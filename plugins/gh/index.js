import path from 'node:path';
import { block } from 'cosplaying/plugin';
import { rewriteApiArgs } from './api.js';
import {
  createTempFiles,
  flagOccurrences,
  ghError,
  mergeBodyWithTrailer,
  readTextFile,
  requireAttribution,
  replaceOccurrence,
  stdinReader,
} from './shared.js';

export const description = 'Attribute GitHub CLI text writes.';

export const examples = [
  'cosplaying hook --model "Example" -- gh pr create --title "Example" --body "The change is ready."',
  'cosplaying hook --model "Example" -- gh issue comment 123 --body "The fix is deployed."',
];

const BODY_PATHS = new Set([
  'pr create', 'pr edit', 'pr comment', 'pr review',
  'issue create', 'issue edit', 'issue comment'
]);
const NOTE_PATHS = new Set(['release create', 'release edit']);
const DESCRIPTION_PATHS = new Set(['repo create', 'repo edit', 'label create', 'label edit']);
const GIST_PATHS = new Set(['gist create', 'gist edit']);
const PROJECT_BODY_PATHS = new Set(['project item-edit']);
const AGENT_TASK_PATHS = new Set(['agent-task create']);
const TEXT_REQUIRED_PATHS = new Set([
  'pr create', 'pr comment', 'pr review',
  'issue create', 'issue comment', 'gist create', 'gist edit',
  'release create', 'agent-task create'
]);

const ALIASES = new Map([
  ['pr new', 'pr create'],
  ['issue new', 'issue create'],
  ['release new', 'release create'],
  ['repo new', 'repo create'],
  ['gist new', 'gist create']
]);

const GLOBAL_VALUE_FLAGS = new Set(['--repo', '-R', '--hostname']);
/**
 * Finds the first two command words and their argument positions.
 * @param {string[]} args - GitHub CLI argument list.
 * @returns {{path: string, rawPath: string, indices: number[], nextIndex: number}} Normalized and raw command paths with scan offsets.
 * @public
 */
function commandInfo(args) {
  const words = [];
  const indices = [];
  let i = 0;
  while (i < args.length && words.length < 2) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      if (GLOBAL_VALUE_FLAGS.has(arg) && i + 1 < args.length && !arg.includes('=')) i += 2;
      else i += 1;
      continue;
    }
    words.push(arg);
    indices.push(i);
    i += 1;
    if (words[0] === 'api') break;
  }
  const rawPath = words.join(' ');
  return { path: ALIASES.get(rawPath) || rawPath, rawPath, indices, nextIndex: i };
}

/**
 * Returns the text flag groups supported by a GitHub CLI command path.
 * @param {string} commandPath - Normalized GitHub CLI command path.
 * @returns {{value: string[], file: string[], template: string[]} | null} Supported value, file, and template flags, or null when unsupported.
 * @private
 */
function descriptorFor(commandPath) {
  if (BODY_PATHS.has(commandPath)) {
    return { value: ['--body', '-b'], file: ['--body-file', '-F'], template: commandPath === 'pr create' ? ['--template', '-T'] : [] };
  }
  if (NOTE_PATHS.has(commandPath)) return { value: ['--notes', '-n'], file: ['--notes-file', '-F'], template: [] };
  if (DESCRIPTION_PATHS.has(commandPath)) return { value: ['--description', '-d'], file: [], template: [] };
  if (GIST_PATHS.has(commandPath)) return { value: ['--desc', '-d'], file: [], template: [] };
  if (PROJECT_BODY_PATHS.has(commandPath)) return { value: ['--body'], file: [], template: [] };
  if (AGENT_TASK_PATHS.has(commandPath)) return { value: [], file: ['--from-file', '-F'], template: [] };
  if (commandPath === 'issue close' || commandPath === 'pr close') return { value: ['--comment', '-c'], file: [], template: [] };
  return null;
}

/**
 * Rewrites explicit PR merge text in place while preserving body source files.
 * @param {string[]} args - Mutable GitHub CLI arguments.
 * @param {object} context - Attribution and temporary-file context.
 * @param {Record<string, string | undefined>} context.env - Environment containing the model identity.
 * @param {string} context.cwd - Working directory for attribution config.
 * @param {string} [context.home] - Home directory for attribution config.
 * @param {string} [context.platform] - Platform for attribution config paths.
 * @param {{write: function(string, string=): string}} context.tempFiles - Private copy writer for body files.
 * @param {function(): string} context.readStdin - Lazy stdin reader for `--body-file -`.
 * @returns {boolean} Whether an explicit merge message was attributed.
 * @throws {CosplayError} If identity is missing, text flags conflict, or rebase cannot carry a trailer.
 * @private
 */
function rewriteMergeArgs(args, { context, tempFiles, readStdin }) {
  const body = flagOccurrences(args, ['--body', '-b']);
  const files = flagOccurrences(args, ['--body-file', '-F']);
  const subjects = flagOccurrences(args, ['--subject', '-t']);
  if (!body.length && !files.length && !subjects.length) return false;
  if (args.includes('--rebase') || args.includes('-r')) throw ghError('pr merge --rebase cannot attribute an explicit merge message; use --merge or --squash.');
  if (body.length + files.length > 1) throw ghError('pr merge needs one body source; use either --body or --body-file.');
  for (const occurrence of [...body, ...files, ...subjects]) {
    if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a value.`);
  }
  const trailer = context.attribution.renderTrailer();
  if (body.length) replaceOccurrence(args, body[0], mergeBodyWithTrailer(body[0].value, trailer));
  else if (files.length) {
    const input = readTextFile(files[0].value, readStdin);
    replaceOccurrence(args, files[0], tempFiles.write(mergeBodyWithTrailer(input.text, trailer), path.extname(files[0].value) || '.txt'));
  } else args.push('--body', mergeBodyWithTrailer('', trailer));
  return true;
}

/**
 * Annotates a file-backed text flag by redirecting changed input to a temp file.
 * @param {string[]} args - Mutable GitHub CLI argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, value?: string}} occurrence - Parsed file flag.
 * @param {{model: string, template: string, link: string | undefined}} config - Current attribution settings.
 * @param {ReturnType<typeof createTempFiles>} tempFiles - Temporary file manager for rewritten input.
 * @param {function(): string} readStdin - Cached stdin reader for dash file values.
 * @returns {boolean} Whether the argument list now points to attributed content.
 * @throws {CosplayError} If the file input is missing, unreadable, or cannot be attributed.
 * @private
 */
function annotateFileOccurrence(args, occurrence, context, tempFiles, readStdin) {
  if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a value. Pass the text-file path after the flag, or use "${occurrence.flag}=<path>"; use - for stdin when supported.`);
  const input = readTextFile(occurrence.value, readStdin);
  const output = context.attribution.annotateMarkdown(input.text);
  if (input.fromStdin || output !== input.text) {
    const extension = path.extname(occurrence.value) || '.md';
    replaceOccurrence(args, occurrence, tempFiles.write(output, extension));
    return true;
  }
  return false;
}

/**
 * Annotates a text value supplied directly through a command flag.
 * @param {string[]} args - Mutable GitHub CLI argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, value?: string}} occurrence - Parsed text flag.
 * @param {{model: string, template: string, link: string | undefined}} config - Current attribution settings.
 * @returns {boolean} Whether the argument value changed.
 * @throws {CosplayError} If the value cannot be attributed.
 * @private
 */
function annotateValueOccurrence(args, occurrence, context) {
  if (occurrence.value === undefined) return false;
  const output = context.attribution.annotateMarkdown(occurrence.value);
  if (output === occurrence.value) return false;
  replaceOccurrence(args, occurrence, output);
  return true;
}

/**
 * Converts a pull request template input into an attributed body-file argument.
 * @param {string[]} args - Mutable GitHub CLI argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, value?: string}} occurrence - Parsed template flag.
 * @param {{model: string, template: string, link: string | undefined}} config - Current attribution settings.
 * @param {ReturnType<typeof createTempFiles>} tempFiles - Temporary file manager for the converted body.
 * @param {function(): string} readStdin - Cached stdin reader for dash template values.
 * @returns {boolean} Whether the template argument was replaced.
 * @throws {CosplayError} If the template input is missing, unreadable, or cannot be attributed.
 * @private
 */
function replaceTemplate(args, occurrence, context, tempFiles, readStdin) {
  if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a value. Pass the template-file path after the flag or as "${occurrence.flag}=<path>".`);
  const input = readTextFile(occurrence.value, readStdin);
  const output = context.attribution.annotateMarkdown(input.text);
  const file = tempFiles.write(output, path.extname(occurrence.value) || '.md');
  if (occurrence.inline) args[occurrence.index] = `--body-file=${file}`;
  else {
    args[occurrence.index] = '--body-file';
    args[occurrence.valueIndex] = file;
  }
  return true;
}

/**
 * Finds the positional task description in a gh agent-task command.
 * @param {string[]} args - GitHub CLI argument list.
 * @param {{nextIndex: number}} info - Parsed command information containing the scan start.
 * @returns {number} Description argument index, or -1 when none is present.
 * @private
 */
function agentTaskPosition(args, info) {
  const valueFlags = new Set(['--base', '-b', '--custom-agent', '-a', '--repo', '-R', '--from-file', '-F']);
  let i = info.nextIndex;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1;
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg) && i + 1 < args.length) i += 2;
      else i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Attributes supported GitHub CLI text writes and blocks unsupported writes.
 * @param {string[]} inputArgs - GitHub CLI arguments after the gh command token.
 * @param {object} [options] - Environment, paths, platform, and stdin overrides.
 * @param {Record<string, string | undefined>} [options.env=process.env] - Environment variables used for attribution config.
 * @param {string} [options.cwd=process.cwd()] - Working directory used to find project config.
 * @param {string} [options.home] - Home directory override for user config.
 * @param {string} [options.platform] - Platform override for user config paths.
 * @param {string | Buffer | NodeJS.ReadStream} [options.stdin=process.stdin] - Input used by dash file arguments.
 * @returns {{args: string[], changed: boolean, path: string, tempFiles: ReturnType<typeof createTempFiles> | {cleanup: function(): void}, blockedReason: string | null}} Prepared arguments, cleanup handle, and any reason a write was blocked.
 * @public
 */
function rewriteGhArgs(inputArgs, context) {
  const args = [...inputArgs];
  const info = commandInfo(args);
  const tempFiles = createTempFiles();
  const readStdin = stdinReader(context.stdin);
  let changed = false;

  try {
    if (info.path === 'api') {
      const result = rewriteApiArgs(args, { info, context, tempFiles, readStdin });
      return { ...result, path: info.path, tempFiles, blockedReason: null };
    }
    if (info.path === 'pr merge') {
      changed = rewriteMergeArgs(args, { context, tempFiles, readStdin });
      return { args, changed, path: info.path, tempFiles, blockedReason: null };
    }

    const descriptor = descriptorFor(info.path);
    const valueOccurrences = descriptor ? flagOccurrences(args, descriptor.value) : [];
    const fileOccurrences = descriptor ? flagOccurrences(args, descriptor.file) : [];
    const templateOccurrences = descriptor ? flagOccurrences(args, descriptor.template) : [];
    const needsText = valueOccurrences.length || fileOccurrences.length || templateOccurrences.length || TEXT_REQUIRED_PATHS.has(info.path);
    if (needsText) requireAttribution(context);

    for (const occurrence of valueOccurrences) {
      if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a value. Pass it after the flag or as "${occurrence.flag}=<value>".`);
      changed = annotateValueOccurrence(args, occurrence, context) || changed;
    }
    for (const occurrence of fileOccurrences) changed = annotateFileOccurrence(args, occurrence, context, tempFiles, readStdin) || changed;
    if (templateOccurrences.length && !valueOccurrences.length && !fileOccurrences.length) {
      for (const occurrence of templateOccurrences) changed = replaceTemplate(args, occurrence, context, tempFiles, readStdin) || changed;
    }

    let hasPosition = false;
    if (AGENT_TASK_PATHS.has(info.path) && !fileOccurrences.length) {
      const position = agentTaskPosition(args, info);
      if (position >= 0) {
        hasPosition = true;
        const output = context.attribution.annotateMarkdown(args[position]);
        if (output !== args[position]) {
          args[position] = output;
          changed = true;
        }
      }
    }

    const hasText = valueOccurrences.length || fileOccurrences.length || templateOccurrences.length || hasPosition;
    if (TEXT_REQUIRED_PATHS.has(info.path) && !hasText && info.path !== 'pr review') {
      const acceptedFlags = descriptor ? [...descriptor.value, ...descriptor.file, ...descriptor.template] : [];
      throw ghError(`${info.path} needs explicit text so attribution can be guaranteed. Pass the user's intended text with one of these flags: ${acceptedFlags.join(', ') || 'a supported text input'}. If the user did not supply the text, ask before creating it.`);
    }
    if (info.path === 'pr review' && !hasText) {
      args.push('--body', context.attribution.annotateMarkdown(''));
      changed = true;
    }
    if (needsText && (args.includes('--web') || args.includes('-w'))) {
      const acceptedFlags = descriptor ? [...descriptor.value, ...descriptor.file, ...descriptor.template] : [];
      throw ghError(`${info.path} cannot use browser flows because the final text cannot be attributed. Remove --web/-w and pass the user's final text with ${acceptedFlags.join(', ') || 'a supported text input'}; do not retry outside cosplaying.`);
    }
    return { args, changed, path: info.path, tempFiles, blockedReason: null };
  } catch (error) {
    tempFiles.cleanup();
    return {
      args: [...inputArgs],
      changed: false,
      path: info.path,
      tempFiles: { cleanup() {} },
      blockedReason: error.message
    };
  }
}


/**
 * @param {string[]} args
 * @param {object} context
 * @returns {Promise<number>}
 */
export default async function run(args, context) {
  const prepared = rewriteGhArgs(args, context);
  try {
    if (prepared.blockedReason) {
      block(context.stderr, prepared.blockedReason);
      return 2;
    }
    const child = await Promise.resolve(context.spawn(context.realBin, prepared.args, {
      cwd: context.cwd,
      env: context.env,
      stdio: 'inherit',
    }));
    if (child?.error) return child.status ?? 127;
    return typeof child?.status === 'number' ? child.status : 1;
  } finally {
    prepared.tempFiles.cleanup();
  }
}
