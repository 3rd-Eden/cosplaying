import path from 'node:path';
import { block, help } from 'cosplaying/plugin';
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
 * Finds the GitHub CLI command path after the global options.
 *
 * The first two words form the path, for example `pr create`. An alias such as `pr new` is normalized to `pr create`. `api` is one word. `--repo` and `--hostname` consume the following argument so they are not treated as the command.
 *
 * @param {string[]} args Arguments after the `gh` executable.
 * @returns {{path: string, rawPath: string, indices: number[], nextIndex: number}} `path` is the normalized command. `rawPath` is the text the user typed. `indices` are the argument positions of those words. `nextIndex` is where flags and positionals begin.
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
 * Returns the text flags that a GitHub CLI command uses for user-authored text.
 *
 * Only those flags are rewritten. A command that is not in the list has no text for this plugin to attribute through a flag.
 *
 * @param {string} commandPath Normalized command path from {@link commandInfo}, for example `pr create`.
 * @returns {{value: string[], file: string[], template: string[]} | null} Flag names for inline text, file text, and a pull-request template. Null when this command has no such flags.
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
 * Adds the attribution trailer to an explicit `pr merge` message.
 *
 * A body flag is rewritten in place. A body file is copied to a private file so the source file stays unchanged. A subject with no body gets a body that contains only the trailer. Rebase cannot store that message, so it is refused. The source file is not modified.
 *
 * @param {string[]} args Mutable `gh` arguments. Matching flags are replaced in this array.
 * @param {object} tools Helpers for this rewrite.
 * @param {object} tools.context Hook context.
 * @param {{renderTrailer: () => string}} tools.context.attribution Helper that returns one `AI-Assisted-By` line.
 * @param {{write: function(string, string=): string}} tools.tempFiles Writer for a private copy of a body file.
 * @param {function(): string} tools.readStdin Reader used when the body file is `-`.
 * @returns {boolean} True when a merge message was attributed. False when the command has no subject, body, or body file.
 * @throws {CosplayError} The model or link is unusable, more than one body source is present, a flag has no value, or the merge uses rebase.
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
 * Attributes the text behind a file flag and points the argument at a private copy.
 *
 * The source file is not modified. Stdin (`-`) is always copied, because the wrapped `gh` process would not see the same stdin. An unchanged file that was not read from stdin keeps its original path.
 *
 * @param {string[]} args Mutable `gh` arguments. The file flag is replaced when a copy is written.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, attached?: boolean, value?: string}} occurrence Parsed file flag from {@link flagOccurrences}.
 * @param {object} context Hook context.
 * @param {{annotateMarkdown: function(string): string}} context.attribution Helper that appends the Markdown byline.
 * @param {{write: function(string, string=): string}} tempFiles Writer for the private copy.
 * @param {function(): string} readStdin Reader used when the file path is `-`.
 * @returns {boolean} True when `args` now points at attributed content. False when the file text did not change.
 * @throws {CosplayError} The flag has no path, the file cannot be read, or the text cannot be attributed.
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
 * Attributes text that was passed directly on a command flag.
 *
 * The flag value is replaced in `args`. A missing value is left for the caller to reject.
 *
 * @param {string[]} args Mutable `gh` arguments.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, attached?: boolean, value?: string}} occurrence Parsed text flag from {@link flagOccurrences}.
 * @param {object} context Hook context.
 * @param {{annotateMarkdown: function(string): string}} context.attribution Helper that appends the Markdown byline.
 * @returns {boolean} True when the flag value changed. False when the value is missing or the attributed text is identical.
 * @throws {CosplayError} The text cannot be attributed.
 */
function annotateValueOccurrence(args, occurrence, context) {
  if (occurrence.value === undefined) return false;
  const output = context.attribution.annotateMarkdown(occurrence.value);
  if (output === occurrence.value) return false;
  replaceOccurrence(args, occurrence, output);
  return true;
}

/**
 * Turns a pull-request template flag into an attributed `--body-file`.
 *
 * `gh` would expand the template itself, and that expansion would not contain the byline. The template is read here, attributed, and passed as a body file so the text `gh` sends is the attributed text.
 *
 * @param {string[]} args Mutable `gh` arguments. The template flag is replaced with `--body-file`.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, attached?: boolean, value?: string}} occurrence Parsed template flag.
 * @param {object} context Hook context.
 * @param {{annotateMarkdown: function(string): string}} context.attribution Helper that appends the Markdown byline.
 * @param {{write: function(string, string=): string}} tempFiles Writer for the attributed body.
 * @param {function(): string} readStdin Reader used when the template path is `-`.
 * @returns {boolean} True. The template flag is always replaced.
 * @throws {CosplayError} The flag has no path, the template cannot be read, or the text cannot be attributed.
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
 * Finds the positional task description on `gh agent-task create`.
 *
 * Flags that take a value are skipped. The first remaining word is the description that must be attributed. `--` starts that description at the next word.
 *
 * @param {string[]} args Full `gh` arguments.
 * @param {{nextIndex: number}} info Parsed command. `nextIndex` is the first argument after the command words.
 * @returns {number} Index of the description in `args`. `-1` when no description is present.
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
 * Rewrites `gh` arguments so user-authored text includes attribution.
 *
 * `api` and `pr merge` have their own rewriters. Other supported commands attribute body, notes, description, and template flags. A command that must have text, but has none, is blocked. `--web` is blocked because the text typed in the browser cannot be attributed. A failure cleans up temporary files and returns the original arguments with a block reason.
 *
 * @param {string[]} inputArgs Arguments after the `gh` executable. This array is not mutated.
 * @param {object} context Hook context.
 * @param {NodeJS.ReadStream | string | Buffer} [context.stdin] Stdin used when a file flag is `-`.
 * @param {{annotateMarkdown: function(string): string, renderTrailer: function(): string}} context.attribution Helpers for the byline and the trailer.
 * @returns {{args: string[], changed: boolean, path: string, tempFiles: {cleanup: function(): void}, blockedReason: string | null}} Arguments to spawn, whether they differ, the normalized command path, a cleanup handle for private copies, and a block reason when `gh` must not run.
 */
function rewriteGhArgs(inputArgs, context) {
  const args = [...inputArgs];
  const info = commandInfo(args);
  const tempFiles = createTempFiles();
  const readStdin = stdinReader(context.stdin);
  let changed = false;

  try {
    if (help(args)) {
      return { args, changed, path: info.path, tempFiles, blockedReason: null };
    }

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
 * Runs `gh` after attributing the text this command will publish.
 *
 * A command that cannot be attributed is refused and `gh` is not started. Private copies of file input are deleted after `gh` exits, including when `gh` fails to start.
 *
 * @param {string[]} args Arguments after `gh`.
 * @param {object} context Hook context.
 * @param {string} context.cwd Working directory passed to `gh`.
 * @param {NodeJS.ProcessEnv} context.env Environment passed to `gh`.
 * @param {NodeJS.WritableStream} context.stderr Stream that receives a block reason.
 * @param {NodeJS.ReadStream | string | Buffer} [context.stdin] Stdin for a file flag of `-`.
 * @param {string} context.realBin Absolute path of the real `gh` executable.
 * @param {Function} context.spawn Spawn function. It returns a `{ status }` result.
 * @param {{annotateMarkdown: function(string): string, renderTrailer: function(): string}} context.attribution Attribution helpers.
 * @returns {Promise<number>} `2` when the command is blocked. Otherwise the `gh` exit status, or `127` when it cannot be started.
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
    if (child.error) return child.status ?? 127;
    return child.status ?? 1;
  } finally {
    prepared.tempFiles.cleanup();
  }
}
