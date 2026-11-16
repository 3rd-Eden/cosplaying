import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { Kind, parse } from 'graphql';
import { block } from 'cosplaying/plugin';

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
  'issue create', 'issue comment',
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
const API_FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field']);
const API_METHOD_FLAGS = new Set(['-X', '--method']);
const API_INPUT_FLAGS = new Set(['--input']);
const API_TEXT_FIELDS = new Set([
  'body', 'comment', 'description', 'notes', 'title', 'name', 'new_name',
  'summary', 'message', 'commit_message', 'commit_title', 'label', 'bio',
  'general_instructions', 'dismissed_comment'
]);
const REVIEWER_FIELD_FLAGS = new Set(['reviewers[]', 'team_reviewers[]']);
const REVIEWER_INPUT_FIELDS = ['reviewers', 'team_reviewers'];
const GRAPHQL_ACTION_MUTATIONS = new Set(['resolveReviewThread', 'unresolveReviewThread']);
const GRAPHQL_IDENTITY_MUTATIONS = new Set([
  'copyProjectV2', 'createLinkedBranch', 'createProjectV2', 'createProjectV2IssueField',
  'createProjectV2View', 'createRef', 'requestReviews', 'requestReviewsByLogin',
  'rerequestReviews', 'updateProjectV2ItemFieldValue', 'updateProjectV2View', 'updateRef'
]);
const GRAPHQL_TEXT_FIELDS = new Set([
  'body', 'comment', 'description', 'title', 'name', 'summary', 'message',
  'shortDescription', 'readme', 'generalInstructions', 'fullDescription',
  'welcomeMessage', 'commitBody', 'commitMessage', 'commitHeadline'
]);
const GRAPHQL_PASSTHROUGH_FIELDS = new Set(['title', 'name']);
const GRAPHQL_CONTENT_MUTATIONS = new Map([
  ['addComment', ['body']],
  ['addDiscussionComment', ['body']],
  ['addProjectV2DraftIssue', ['body']],
  ['addPullRequestReview', ['body']],
  ['addPullRequestReviewComment', ['body']],
  ['addPullRequestReviewThread', ['body']],
  ['addPullRequestReviewThreadReply', ['body']],
  ['createDiscussion', ['body']],
  ['createIssue', ['body']],
  ['createIssueField', ['description']],
  ['createIssueType', ['description']],
  ['createLabel', ['description']],
  ['createProject', ['body']],
  ['createProjectV2Field', ['description']],
  ['createProjectV2StatusUpdate', ['body']],
  ['createPullRequest', ['body']],
  ['createRepository', ['description']],
  ['cloneTemplateRepository', ['description']],
  ['approveDeployments', ['comment']],
  ['rejectDeployments', ['comment']],
  ['createSponsorsListing', ['fullDescription']],
  ['createSponsorsTier', ['description', 'welcomeMessage']],
  ['createUserList', ['description']],
  ['dismissPullRequestReview', ['message']],
  ['revertPullRequest', ['body']],
  ['submitPullRequestReview', ['body']],
  ['updateDiscussion', ['body']],
  ['updateDiscussionComment', ['body']],
  ['updateEnterpriseProfile', ['description']],
  ['updateIssue', ['body']],
  ['updateIssueComment', ['body']],
  ['updateIssueField', ['description']],
  ['updateIssueType', ['description']],
  ['updateLabel', ['description']],
  ['updateProjectV2', ['shortDescription', 'readme']],
  ['updateProjectV2DraftIssue', ['body']],
  ['updateProjectV2Field', ['description']],
  ['updateProjectV2StatusUpdate', ['body']],
  ['updatePullRequest', ['body']],
  ['updatePullRequestReview', ['body']],
  ['updatePullRequestReviewComment', ['body']],
  ['updateRepository', ['description']],
  ['updateUserList', ['description']]
]);
const GRAPHQL_TRAILER_MUTATIONS = new Map([
  ['createCommitOnBranch', { path: ['message', 'body'], allowedFields: ['message'] }],
  ['enablePullRequestAutoMerge', { field: 'commitBody', allowedFields: ['commitBody', 'commitHeadline'] }],
  ['mergeBranch', { field: 'commitMessage', allowedFields: ['commitMessage'] }],
  ['mergePullRequest', { field: 'commitBody', allowedFields: ['commitBody', 'commitHeadline'] }]
]);
const API_VALUE_FLAGS = new Set([
  ...API_FIELD_FLAGS, ...API_METHOD_FLAGS, ...API_INPUT_FLAGS,
  '-H', '--header', '--jq', '--template', '--cache', '--hostname'
]);


/**
 * Checks whether a value is a non-array object.
 * @param {unknown} value - Value to inspect.
 * @returns {value is Record<string, unknown>} Whether the value is a record.
 * @private
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves the required write identity and validated attribution settings.
 * @param {Record<string, string | undefined>} [env=process.env] - Environment variables used for model and config values.
 * @param {string} [cwd=process.cwd()] - Working directory used to find project config.
 * @param {{env?: Record<string, string | undefined>, cwd?: string, home?: string, platform?: string}} [configPaths] - Additional environment and path overrides for config lookup.
 * @returns {{model: string, template: string, link: string | undefined}} Model identity and attribution settings.
 * @throws {Error} If the model identity is missing or attribution configuration is invalid.
 * @public
 */
function requireAttribution(context) {
  context.attribution.annotateMarkdown('');
}

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
 * Finds occurrences of selected flags and records their value positions.
 * @param {string[]} args - Argument list to scan.
 * @param {Iterable<string>} flags - Flag names to match.
 * @returns {Array<{flag: string, index: number, valueIndex: number, inline: boolean, value: string | undefined}>} Matching flag occurrences.
 * @private
 */
function flagOccurrences(args, flags) {
  const result = [];
  const names = new Set(flags);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    for (const flag of names) {
      if (arg === flag) {
        result.push({ flag, index: i, valueIndex: i + 1, inline: false, value: args[i + 1] });
        break;
      }
      if (arg.startsWith(`${flag}=`)) {
        result.push({ flag, index: i, valueIndex: i, inline: true, value: arg.slice(flag.length + 1) });
        break;
      }
    }
  }
  return result;
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
 * Adds one attribution trailer to a merge body, replacing a prior footer value.
 * @param {string} text - Existing merge commit body.
 * @param {string} trailer - Rendered `AI-Assisted-By` trailer.
 * @returns {string} Body with a single final attribution trailer.
 * @private
 */
function mergeBodyWithTrailer(text, trailer) {
  const lines = String(text).replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const footerStart = lines.lastIndexOf('') + 1;
  for (let i = lines.length - 1; i >= footerStart; i -= 1) {
    if (/^AI-Assisted-By:\s/i.test(lines[i])) lines.splice(i, 1);
  }
  const body = lines.join('\n').trimEnd();
  return `${body}${body ? '\n\n' : ''}${trailer}\n`;
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
 * @throws {Error} If identity is missing, text flags conflict, or rebase cannot carry a trailer.
 * @private
 */
function rewriteMergeArgs(args, { context, tempFiles, readStdin }) {
  const body = flagOccurrences(args, ['--body', '-b']);
  const files = flagOccurrences(args, ['--body-file', '-F']);
  const subjects = flagOccurrences(args, ['--subject', '-t']);
  if (!body.length && !files.length && !subjects.length) return false;
  if (args.includes('--rebase') || args.includes('-r')) throw new Error('pr merge --rebase cannot attribute an explicit merge message; use --merge or --squash.');
  if (body.length + files.length > 1) throw new Error('pr merge needs one body source; use either --body or --body-file.');
  for (const occurrence of [...body, ...files, ...subjects]) {
    if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a value.`);
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
 * Creates private temporary files and a cleanup function for rewritten inputs.
 * @returns {{write: function(string, string=): string, cleanup: function(): void}} Temporary file writer and cleanup operations.
 * @private
 */
function createTempFiles() {
  let directory;
  const files = [];
  return {
    /**
     * Writes text to a private temporary file.
     * @param {string} text - File contents.
     * @param {string} [extension='.md'] - File extension to preserve for the wrapped CLI.
     * @returns {string} Path to the written temporary file.
     * @throws {Error} If the temporary directory or file cannot be created.
     * @private
     */
    write(text, extension = '.md') {
      try {
        directory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cosplaying-'));
        const file = path.join(directory, `input${files.length}${extension.startsWith('.') ? extension : `.${extension}`}`);
        fs.writeFileSync(file, text, { mode: 0o600 });
        files.push(file);
        return file;
      } catch (error) {
        throw new Error(`cannot create private attributed input copy: ${error.message}. Check the system temporary directory and available space; the source file was not modified.`);
      }
    },
    /**
     * Removes the temporary directory and all files written by this instance.
     * @returns {void}
     * @throws {Error} If the temporary directory cannot be removed.
     * @private
     */
    cleanup() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Creates a lazy reader that consumes stdin at most once.
 * @param {string | Buffer | NodeJS.ReadStream} [input=process.stdin] - Stdin source or injected text value.
 * @returns {function(): string} Function returning the cached stdin text.
 * @throws {Error} If stdin cannot be read.
 * @private
 */
function stdinReader(input = process.stdin) {
  let read = false;
  let value = '';
  return () => {
    if (!read) {
      if (typeof input === 'string' || Buffer.isBuffer(input)) value = String(input);
      else {
        try { value = fs.readFileSync(input.fd ?? 0, 'utf8'); }
        catch (error) { throw new Error(`cannot read stdin: ${error.message}. Provide UTF-8 input on stdin or use a readable file where supported.`); }
      }
      read = true;
    }
    return value;
  };
}

/**
 * Replaces the value portion of a previously parsed flag occurrence.
 * @param {string[]} args - Mutable GitHub CLI argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean}} occurrence - Parsed flag location.
 * @param {string} value - Replacement value.
 * @returns {void}
 * @private
 */
function replaceOccurrence(args, occurrence, value) {
  if (occurrence.inline) args[occurrence.index] = `${occurrence.flag}=${value}`;
  else args[occurrence.valueIndex] = value;
}

/**
 * Reads a text file or consumes the injected stdin reader for a dash path.
 * @param {string} file - Text file path or dash to read stdin.
 * @param {function(): string} readStdin - Cached stdin reader.
 * @returns {{text: string, fromStdin: boolean}} File text and whether it came from stdin.
 * @throws {Error} If the requested file cannot be read.
 * @private
 */
function readTextFile(file, readStdin) {
  if (file === '-') return { text: readStdin(), fromStdin: true };
  try { return { text: fs.readFileSync(file, 'utf8'), fromStdin: false }; }
  catch (error) { throw new Error(`cannot read input file ${file}: ${error.message}. Check that the path exists and is readable, or use - for stdin where supported.`); }
}

/**
 * Annotates a file-backed text flag by redirecting changed input to a temp file.
 * @param {string[]} args - Mutable GitHub CLI argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, value?: string}} occurrence - Parsed file flag.
 * @param {{model: string, template: string, link: string | undefined}} config - Current attribution settings.
 * @param {ReturnType<typeof createTempFiles>} tempFiles - Temporary file manager for rewritten input.
 * @param {function(): string} readStdin - Cached stdin reader for dash file values.
 * @returns {boolean} Whether the argument list now points to attributed content.
 * @throws {Error} If the file input is missing, unreadable, or cannot be attributed.
 * @private
 */
function annotateFileOccurrence(args, occurrence, context, tempFiles, readStdin) {
  if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a value. Pass the text-file path after the flag, or use "${occurrence.flag}=<path>"; use - for stdin when supported.`);
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
 * @throws {Error} If the value cannot be attributed.
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
 * @throws {Error} If the template input is missing, unreadable, or cannot be attributed.
 * @private
 */
function replaceTemplate(args, occurrence, context, tempFiles, readStdin) {
  if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a value. Pass the template-file path after the flag or as "${occurrence.flag}=<path>".`);
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
 * Determines the HTTP method implied by a gh api argument list.
 * @param {string[]} args - gh api arguments.
 * @returns {string} Explicit uppercase method, or the method inferred from request fields.
 * @private
 */
function apiMethod(args) {
  let method;
  for (const occurrence of flagOccurrences(args, API_METHOD_FLAGS)) {
    if (occurrence.value !== undefined) method = occurrence.value.toUpperCase();
  }
  if (method) return method;
  return flagOccurrences(args, API_FIELD_FLAGS).length || flagOccurrences(args, API_INPUT_FLAGS).length ? 'POST' : 'GET';
}

/**
 * Finds the gh api endpoint while skipping flags that consume values.
 * @param {string[]} args - gh api arguments.
 * @param {{nextIndex: number}} info - Parsed command information containing the endpoint scan start.
 * @returns {{value: string, index: number} | null} Endpoint value and argument index, or null when it cannot be found.
 * @public
 */
function apiEndpoint(args, info) {
  for (let i = info.nextIndex; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return null;
    const name = arg.split('=', 1)[0];
    if (API_VALUE_FLAGS.has(name)) {
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { value: arg, index: i };
  }
  return null;
}

/**
 * Normalizes a GitHub API endpoint and rejects hosts outside the configured GitHub host.
 * @param {string} endpoint - Relative API path or absolute URL.
 * @param {string} [hostname] - Configured GitHub Enterprise hostname.
 * @returns {string} Normalized API route, or an empty string for an unsupported URL.
 * @private
 */
function normalizedApiEndpoint(endpoint, hostname) {
  let value = String(endpoint);
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return ''; }
    if (url.protocol !== 'https:' || (url.hostname !== 'api.github.com' && url.hostname !== hostname)) return '';
    value = url.pathname;
  }
  return value
    .split(/[?#]/, 1)[0]
    .replace(/^\/+/, '')
    .replace(/^api\/v3\//, '');
}

/**
 * Finds the allowlisted text field for a mutating GitHub API route and method.
 * @param {string} endpoint - API route or absolute endpoint URL.
 * @param {string} method - Uppercase HTTP method.
 * @param {string} [hostname] - Configured GitHub Enterprise hostname.
 * @returns {{pattern: RegExp, methods: string[], fields?: string[], passthroughFields?: string[], trailerFields?: string[], defaultTrailerField?: string, payloadFields?: string[], emptyReview?: boolean, allowTextless?: boolean, reviewerRequest?: string, identityOnly?: boolean, dismissal?: boolean} | null} Matching write rule, or null when unsupported.
 * @public
 */
function apiRule(endpoint, method, hostname) {
  const route = normalizedApiEndpoint(endpoint, hostname);
  const repo = 'repos/[^/]+/[^/]+';
  const team = '(?:orgs/[^/]+/teams/[^/]+|teams/[^/]+)';
  const rules = [
    { pattern: new RegExp(`^${repo}/issues$`), methods: ['POST'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/issues/[^/]+$`), methods: ['PATCH'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/issues/[^/]+/comments$`), methods: ['POST'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/issues/comments/[^/]+$`), methods: ['PATCH'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/pulls$`), methods: ['POST'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+$`), methods: ['PATCH'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/reviews$`), methods: ['POST'], fields: ['body'], emptyReview: true },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/reviews/[^/]+$`), methods: ['PUT'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/reviews/[^/]+/dismissals$`), methods: ['PUT'], fields: ['message'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/reviews/[^/]+/events$`), methods: ['POST'], fields: ['body'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/requested_reviewers$`), methods: ['POST'], reviewerRequest: 'request' },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/requested_reviewers$`), methods: ['DELETE'], reviewerRequest: 'remove' },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/comments$`), methods: ['POST'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/pulls/comments/[^/]+$`), methods: ['PATCH'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/comments/[^/]+/replies$`), methods: ['POST'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/commits/[^/]+/comments$`), methods: ['POST'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}/comments/[^/]+$`), methods: ['PATCH'], fields: ['body'] },
    { pattern: new RegExp(`^${team}/discussions$`), methods: ['POST'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${team}/discussions/[^/]+$`), methods: ['PATCH'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${team}/discussions/[^/]+/comments$`), methods: ['POST'], fields: ['body'] },
    { pattern: new RegExp(`^${team}/discussions/[^/]+/comments/[^/]+$`), methods: ['PATCH'], fields: ['body'] },
    { pattern: /^gists$/, methods: ['POST'], fields: ['description'], payloadFields: ['files'] },
    { pattern: /^gists\/[^/]+$/, methods: ['PATCH'], fields: ['description'], payloadFields: ['files'] },
    { pattern: /^gists\/[^/]+\/comments$/, methods: ['POST'], fields: ['body'] },
    { pattern: /^gists\/[^/]+\/comments\/[^/]+$/, methods: ['PATCH'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}$`), methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/actions/runs/[^/]+/deployment_protection_rule$`), methods: ['POST'], fields: ['comment'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/actions/runs/[^/]+/pending_deployments$`), methods: ['POST'], fields: ['comment'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/releases/assets/[^/]+$`), methods: ['PATCH'], passthroughFields: ['name', 'label'] },
    { pattern: /^user\/repos$/, methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/repos$/, methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^repos\/[^/]+\/[^/]+\/generate$/, methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+$/, methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/campaigns\/[^/]+$/, methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/issue-fields$/, methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/issue-fields\/[^/]+$/, methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/issue-types$/, methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/issue-types\/[^/]+$/, methods: ['PUT'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/teams$/, methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/teams\/[^/]+$/, methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^teams\/[^/]+$/, methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: /^user$/, methods: ['PATCH'], passthroughFields: ['bio', 'name'] },
    { pattern: /^orgs\/[^/]+\/copilot-spaces$/, methods: ['POST'], fields: ['description', 'general_instructions'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/copilot-spaces\/[^/]+$/, methods: ['PUT'], fields: ['description', 'general_instructions'], passthroughFields: ['name'] },
    { pattern: /^users\/[^/]+\/copilot-spaces$/, methods: ['POST'], fields: ['description', 'general_instructions'], passthroughFields: ['name'] },
    { pattern: /^users\/[^/]+\/copilot-spaces\/[^/]+$/, methods: ['PUT'], fields: ['description', 'general_instructions'], passthroughFields: ['name'] },
    { pattern: /^orgs\/[^/]+\/projects$/, methods: ['POST'], fields: ['body'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/projects$`), methods: ['POST'], fields: ['body'], passthroughFields: ['name'] },
    { pattern: /^user\/projects$/, methods: ['POST'], fields: ['body'], passthroughFields: ['name'] },
    { pattern: /^projects\/[^/]+$/, methods: ['PATCH'], fields: ['body'], passthroughFields: ['name'] },
    { pattern: /^projects\/[^/]+\/columns$/, methods: ['POST'], passthroughFields: ['name'] },
    { pattern: /^projects\/columns\/[^/]+$/, methods: ['PATCH'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/git/blobs$`), methods: ['POST'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/git/trees$`), methods: ['POST'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/git/refs$`), methods: ['POST'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/git/refs/.+$`), methods: ['PATCH'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/branches/[^/]+/rename$`), methods: ['POST'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/issues/[^/]+/labels$`), methods: ['POST', 'PUT', 'DELETE'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/issues/[^/]+/labels/[^/]+$`), methods: ['DELETE'], identityOnly: true },
    { pattern: new RegExp(`^${repo}/releases$`), methods: ['POST'], fields: ['body'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/releases/[^/]+$`), methods: ['PATCH'], fields: ['body'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/labels$`), methods: ['POST'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/labels/[^/]+$`), methods: ['PATCH'], fields: ['description'], passthroughFields: ['new_name'] },
    { pattern: new RegExp(`^${repo}/milestones$`), methods: ['POST'], fields: ['description'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/milestones/[^/]+$`), methods: ['PATCH'], fields: ['description'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/security-advisories$`), methods: ['POST'], fields: ['description'], passthroughFields: ['summary'] },
    { pattern: new RegExp(`^${repo}/security-advisories/reports$`), methods: ['POST'], fields: ['description'], passthroughFields: ['summary'] },
    { pattern: new RegExp(`^${repo}/security-advisories/[^/]+$`), methods: ['PATCH'], fields: ['description'], passthroughFields: ['summary'] },
    { pattern: new RegExp(`^${repo}/code-scanning/alerts/[0-9]+$`), methods: ['PATCH'], fields: ['dismissed_comment'], dismissal: true },
    { pattern: /^orgs\/[^/]+\/projectsV2\/[^/]+\/drafts$/, methods: ['POST'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: /^user\/[^/]+\/projectsV2\/[^/]+\/drafts$/, methods: ['POST'], fields: ['body'], passthroughFields: ['title'] },
    { pattern: new RegExp(`^${repo}/contents/.+$`), methods: ['PUT', 'DELETE'], trailerFields: ['message'] },
    { pattern: new RegExp(`^${repo}/git/commits$`), methods: ['POST'], trailerFields: ['message'] },
    { pattern: new RegExp(`^${repo}/git/tags$`), methods: ['POST'], trailerFields: ['message'] },
    { pattern: /^repos\/[^/]+\/[^/]+\/code-scanning\/alerts\/[^/]+\/autofix\/commits$/, methods: ['POST'], trailerFields: ['message'] },
    { pattern: new RegExp(`^${repo}/merges$`), methods: ['POST'], trailerFields: ['commit_message'] },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/merge$`), methods: ['PUT'], passthroughFields: ['commit_title'], trailerFields: ['commit_message'], defaultTrailerField: 'commit_message' },
    { pattern: new RegExp(`^${repo}/pulls/[^/]+/merge-async$`), methods: ['PUT'], passthroughFields: ['commit_title'], trailerFields: ['commit_message'], defaultTrailerField: 'commit_message' },
    { pattern: new RegExp(`^${repo}/releases/[^/]+/assets$`), methods: ['POST'], identityOnly: true }
  ];
  return rules.find((rule) => rule.pattern.test(route) && rule.methods.includes(method)) || null;
}

/**
 * Validates a pull request reviewer request without changing its content.
 * @param {string[]} args - Mutable gh api arguments.
 * @param {object} options - Attribution and input-file context.
 * @param {Record<string, string | undefined>} options.env - Environment containing the model identity.
 * @param {string} options.cwd - Working directory for attribution config.
 * @param {string} [options.home] - Home directory for attribution config.
 * @param {string} [options.platform] - Platform for attribution config paths.
 * @param {ReturnType<typeof createTempFiles>} options.tempFiles - Private copy writer for stdin input.
 * @param {function(): string} options.readStdin - Lazy stdin reader.
 * @returns {{args: string[], changed: boolean}} Validated arguments and whether stdin was redirected to a private copy.
 * @throws {Error} If the identity or reviewer payload is missing or invalid.
 * @private
 */
function rewriteReviewerRequestArgs(args, { context, tempFiles, readStdin, operation = 'request' }) {
  requireAttribution(context);
  const label = operation === 'remove' ? 'reviewer removals' : 'reviewer requests';
  const fields = flagOccurrences(args, API_FIELD_FLAGS);
  const inputs = flagOccurrences(args, API_INPUT_FLAGS);
  if (inputs.length > 1) throw new Error(`gh api ${label} support one --input value. Use one JSON object with reviewer arrays.`);
  if (inputs.length && fields.length) throw new Error('Use reviewer fields or one JSON --input file. Do not combine both forms.');

  if (inputs.length) {
    const occurrence = inputs[0];
    if (occurrence.value === undefined) throw new Error('--input needs a value. Pass a JSON file with reviewer arrays.');
    const input = readTextFile(occurrence.value, readStdin);
    let request;
    try { request = JSON.parse(input.text); } catch (error) {
      throw new Error(`could not parse gh api reviewer JSON input ${occurrence.value}: ${error.message}. Fix the JSON syntax.`);
    }
    if (!isRecord(request)) throw new Error('gh api reviewer JSON input must be one object with a reviewers or team_reviewers array.');
    const unsupported = Object.keys(request).find((field) => !REVIEWER_INPUT_FIELDS.includes(field));
    if (unsupported) throw new Error(`gh api reviewer JSON input only accepts reviewers and team_reviewers arrays. Remove "${unsupported}".`);
    let hasReviewer = false;
    for (const field of REVIEWER_INPUT_FIELDS) {
      if (!Object.hasOwn(request, field)) continue;
      if (!Array.isArray(request[field]) || request[field].some((name) => typeof name !== 'string' || !name.trim())) {
        throw new Error(`gh api reviewer input field "${field}" must be an array of non-empty strings.`);
      }
      hasReviewer ||= request[field].length > 0;
    }
    if (!hasReviewer) throw new Error(`Add at least one reviewer in reviewers or team_reviewers to ${operation} reviewers.`);
    if (input.fromStdin) replaceOccurrence(args, occurrence, tempFiles.write(input.text, '.json'));
    return { args, changed: input.fromStdin };
  }

  if (!fields.length) throw new Error(`Add a reviewer with -f "reviewers[]=<login>" or -f "team_reviewers[]=<slug>", or pass reviewer arrays in JSON with --input to ${operation} reviewers.`);
  for (const occurrence of fields) {
    if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a reviewer field and value.`);
    const separator = occurrence.value.indexOf('=');
    const field = occurrence.value.slice(0, separator);
    if (separator < 1 || !REVIEWER_FIELD_FLAGS.has(field)) {
      throw new Error('gh api reviewer requests only accept reviewers[] and team_reviewers[] fields.');
    }
    if (!occurrence.value.slice(separator + 1).trim()) throw new Error(`gh api reviewer field "${field}" needs a non-empty value.`);
  }
  return { args, changed: false };
}

/**
 * Parses gh api field flags and selects fields allowed for an endpoint.
 * @param {string[]} args - gh api arguments.
 * @param {string[]} fields - Allowlisted text field names.
 * @returns {Array<{flag: string, index: number, valueIndex: number, inline: boolean, key: string, field: string, value: string}>} Matching text field occurrences.
 * @private
 */
function apiFieldOccurrences(args, fields) {
  const result = [];
  for (const occurrence of flagOccurrences(args, API_FIELD_FLAGS)) {
    if (occurrence.value === undefined) continue;
    const equals = occurrence.value.indexOf('=');
    if (equals < 1) continue;
    const key = occurrence.value.slice(0, equals);
    const field = key.toLowerCase();
    if (fields.includes(field)) result.push({ ...occurrence, key, field, value: occurrence.value.slice(equals + 1) });
  }
  return result;
}

/**
 * Finds a supported GraphQL mutation and its attributed input fields.
 * @param {string} query - GraphQL query text.
 * @returns {{name: string, fields?: string[], allowedFields?: string[], variables?: Array<{field: string, variable: string}>, inputVariable?: string, trailerRule?: object, identityOnly?: boolean} | null} Mutation details, or null for a read or untracked action.
 * @throws {Error} If a GraphQL mutation is not safely allowlisted.
 * @private
 */
function graphqlMutation(query) {
  let document;
  try {
    document = parse(query, { noLocation: true });
  } catch {
    // Invalid GraphQL cannot execute; let gh report the parse error.
    return null;
  }

  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  const mutations = operations.filter((operation) => operation.operation === 'mutation');
  if (!mutations.length) return null;
  if (operations.length !== 1 || mutations.length !== 1) {
    throw new Error('blocked unsupported mutating gh api request: POST graphql. cosplaying can attribute one approved content or reviewer mutation per request; split out unrelated operations. If the requested mutation is different, stop and ask for an approved route.');
  }

  const selections = mutations[0].selectionSet.selections;
  const field = selections.length === 1 && selections[0].kind === Kind.FIELD
    ? selections[0]
    : null;
  if (field && GRAPHQL_ACTION_MUTATIONS.has(field.name.value)) return null;
  if (!field) throw new Error('blocked unsupported mutating gh api request: POST graphql. cosplaying needs one direct mutation field with an approved attribution rule; do not retry through bare `gh`.');
  const name = field.name.value;
  if (GRAPHQL_IDENTITY_MUTATIONS.has(name)) return { name, identityOnly: true };
  const textFields = GRAPHQL_CONTENT_MUTATIONS.get(name) || [];
  const trailerRule = GRAPHQL_TRAILER_MUTATIONS.get(name);
  if (!textFields.length && !trailerRule) {
    throw new Error(`blocked unsupported mutating gh api request: POST graphql. cosplaying has no attribution rule for "${name}"; stop and ask for an approved route instead of retrying through bare gh.`);
  }

  const inputs = field.arguments.filter((argument) => argument.name.value === 'input');
  if (inputs.length !== 1) throw new Error(`gh api graphql mutation "${name}" needs one input object.`);
  const allowedFields = [...new Set([...textFields, ...GRAPHQL_PASSTHROUGH_FIELDS, ...(trailerRule?.allowedFields || [])])];
  if (inputs[0].value.kind === Kind.VARIABLE) {
    return { name, fields: textFields, allowedFields, inputVariable: inputs[0].value.name.value, trailerRule };
  }
  if (trailerRule) throw new Error(`gh api graphql mutation "${name}" needs one --input JSON object with the complete "variables.input" object so cosplaying can add the commit trailer.`);
  if (inputs[0].value.kind !== Kind.OBJECT) throw new Error(`gh api graphql mutation "${name}" needs one input object.`);
  const inputFields = inputs[0].value.fields;
  if (name === 'addPullRequestReview' && inputFields.some((inputField) => ['comments', 'threads'].includes(inputField.name.value))) {
    throw new Error('gh api graphql batch review comments and threads need one --input JSON object with a variables.input object so cosplaying can attribute every body.');
  }
  const unsupportedField = inputFields.find((inputField) => GRAPHQL_TEXT_FIELDS.has(inputField.name.value) && !allowedFields.includes(inputField.name.value));
  if (unsupportedField) throw new Error(`gh api graphql mutation "${name}" does not support the "${unsupportedField.name.value}" text field. Use a REST route with a matching attribution rule.`);
  const variables = [];
  for (const textField of textFields) {
    const matches = inputFields.filter((inputField) => inputField.name.value === textField);
    if (matches.length > 1) throw new Error(`gh api graphql mutation "${name}" contains more than one "${textField}" field.`);
    if (!matches.length) continue;
    if (matches[0].value.kind !== Kind.VARIABLE) {
      throw new Error(`gh api graphql mutation "${name}" needs "${textField}: $variable" and a string value for that variable. Pass the text with -f or put it in one --input JSON object.`);
    }
    variables.push({ field: textField, variable: matches[0].value.name.value });
  }
  return { name, fields: textFields, allowedFields, variables, identityOnly: variables.length === 0 };
}

/**
 * Reads a GraphQL field value, including `-F key=@file` values.
 * @param {{flag: string, value?: string}} occurrence - Parsed field occurrence.
 * @param {function(): string} readStdin - Cached stdin reader.
 * @returns {{text: string, fromFile: boolean, file?: string}} Field text and source metadata.
 * @throws {Error} If the value is missing or its file cannot be read.
 * @private
 */
function readGraphqlField(occurrence, readStdin) {
  if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a value. Pass key=<value> after the flag or as "${occurrence.flag}=key=<value>".`);
  if (['-F', '--field'].includes(occurrence.flag) && occurrence.value.startsWith('@')) {
    const file = occurrence.value.slice(1);
    const input = readTextFile(file, readStdin);
    return { text: input.text, fromFile: true, file };
  }
  return { text: occurrence.value, fromFile: false };
}

/**
 * Adds attribution to the approved text fields in a GraphQL input object.
 * @param {Record<string, unknown>} input - GraphQL input variables.
 * @param {object} mutation - Mutation rule returned by {@link graphqlMutation}.
 * @param {{model: string, template: string, link: string | undefined}} config - Current attribution settings.
 * @param {string} [trailer] - Rendered Git trailer for commit mutations.
 * @returns {boolean} Whether an input field changed.
 * @throws {Error} If the input contains unsupported text fields or invalid values.
 * @private
 */
function annotateGraphqlInput(input, mutation, context, trailer) {
  const unsupported = Object.keys(input).find((field) => GRAPHQL_TEXT_FIELDS.has(field) && !mutation.allowedFields.includes(field));
  if (unsupported) throw new Error(`gh api graphql mutation "${mutation.name}" does not support the "${unsupported}" text field.`);
  let changed = false;
  for (const field of mutation.fields || []) {
    if (!Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== 'string') throw new Error(`gh api graphql needs a string value for "${field}" in mutation "${mutation.name}".`);
    input[field] = context.attribution.annotateMarkdown(input[field]);
    changed = true;
  }
  if (mutation.name === 'addPullRequestReview') {
    for (const field of ['comments', 'threads']) {
      if (!Object.hasOwn(input, field)) continue;
      if (!Array.isArray(input[field])) throw new Error(`gh api graphql review input "${field}" must be an array.`);
      for (const [index, entry] of input[field].entries()) {
        if (!isRecord(entry) || typeof entry.body !== 'string') throw new Error(`gh api graphql review input ${field}[${index}] must contain a string body.`);
        entry.body = context.attribution.annotateMarkdown(entry.body);
      }
      changed = true;
    }
  }
  if (mutation.trailerRule) {
    const { field, path: fieldPath } = mutation.trailerRule;
    if (field) {
      if (!Object.hasOwn(input, field)) input[field] = '';
      if (input[field] === null) input[field] = '';
      if (typeof input[field] !== 'string') throw new Error(`gh api graphql commit message field "${field}" must be a string.`);
      input[field] = mergeBodyWithTrailer(input[field], trailer);
      changed = true;
    } else if (fieldPath) {
      let target = input;
      for (const part of fieldPath.slice(0, -1)) {
        if (!isRecord(target[part])) throw new Error(`gh api graphql mutation "${mutation.name}" needs an object at "${fieldPath.slice(0, -1).join('.')}".`);
        target = target[part];
      }
      const last = fieldPath.at(-1);
      if (!Object.hasOwn(target, last)) target[last] = '';
      if (target[last] === null) target[last] = '';
      if (typeof target[last] !== 'string') throw new Error(`gh api graphql commit message field "${fieldPath.join('.')}" must be a string.`);
      target[last] = mergeBodyWithTrailer(target[last], trailer);
      changed = true;
    }
  }
  return changed;
}

/**
 * Rewrites an attributed GraphQL text mutation.
 * @param {string[]} inputArgs - Original gh api arguments.
 * @param {object} options - Parsed command and injected I/O settings.
 * @param {Record<string, string | undefined>} options.env - Environment variables used for attribution config.
 * @param {string} options.cwd - Working directory used to find project config.
 * @param {string} [options.home] - Home directory override for user config.
 * @param {string} [options.platform] - Platform override for user config paths.
 * @param {ReturnType<typeof createTempFiles>} options.tempFiles - Temporary file manager for rewritten inputs.
 * @param {function(): string} options.readStdin - Cached stdin reader.
 * @returns {{args: string[], changed: boolean}} Prepared arguments and whether a rewrite occurred.
 * @throws {Error} If the mutation or body input cannot be attributed safely.
 * @private
 */
function rewriteGraphqlArgs(inputArgs, { context, tempFiles, readStdin }) {
  const args = [...inputArgs];
  const inputs = flagOccurrences(args, API_INPUT_FLAGS);
  if (inputs.length > 1) throw new Error('gh api graphql supports one `--input` value. Merge the query and variables into one JSON object and pass one `--input <file>`.');

  let request;
  let requestInput;
  let queryOccurrence;
  let queryInput;
  if (inputs.length) {
    if (flagOccurrences(args, API_FIELD_FLAGS).length) {
      throw new Error('choose one GraphQL input form: use `-f`/`-F` fields for the query and variables, or one `--input <file>` JSON object containing `query` and `variables`; do not combine them.');
    }
    if (inputs[0].value === undefined) throw new Error(`${inputs[0].flag} needs a value. Pass one JSON file containing a top-level query string and its variables.`);
    requestInput = readTextFile(inputs[0].value, readStdin);
    try { request = JSON.parse(requestInput.text); } catch (error) {
      throw new Error(`could not parse GraphQL JSON input ${inputs[0].value}: ${error.message}. Fix the JSON syntax; use one object with a top-level "query" string and optional "variables" object.`);
    }
    if (!isRecord(request) || typeof request.query !== 'string') {
      throw new Error('gh api graphql --input must be one JSON object with a top-level string `query` and an optional `variables` object.');
    }
  } else {
    const queryOccurrences = apiFieldOccurrences(args, ['query']);
    if (queryOccurrences.length !== 1) throw new Error('gh api graphql needs exactly one query field. Pass one `-f query=<GraphQL document>`; for JSON input, use one `--input <file>` with a top-level `query` string.');
    queryOccurrence = queryOccurrences[0];
    queryInput = readGraphqlField(queryOccurrence, readStdin);
    request = { query: queryInput.text };
  }

  let changed = false;
  const mutation = graphqlMutation(request.query);
  if (!mutation) {
    if (requestInput?.fromStdin) {
      replaceOccurrence(args, inputs[0], tempFiles.write(requestInput.text, '.json'));
      changed = true;
    } else if (queryInput?.fromFile && queryInput.file === '-') {
      replaceOccurrence(args, queryOccurrence, `${queryOccurrence.key}=@${tempFiles.write(queryInput.text, '.graphql')}`);
      changed = true;
    }
    return { args, changed };
  }
  requireAttribution(context);
  const trailer = mutation.trailerRule
    ? context.attribution.renderTrailer()
    : undefined;

  if (mutation.identityOnly) {
    if (requestInput?.fromStdin) {
      replaceOccurrence(args, inputs[0], tempFiles.write(requestInput.text, '.json'));
      changed = true;
    } else if (queryInput?.fromFile && queryInput.file === '-') {
      replaceOccurrence(args, queryOccurrence, `${queryOccurrence.key}=@${tempFiles.write(queryInput.text, '.graphql')}`);
      changed = true;
    }
    return { args, changed };
  }

  if (mutation.inputVariable) {
    if (!inputs.length) throw new Error(`gh api graphql mutation "${mutation.name}" uses an input variable. Pass one --input JSON object with "variables.${mutation.inputVariable}" as an object.`);
    const input = isRecord(request.variables) ? request.variables[mutation.inputVariable] : undefined;
    if (!isRecord(input)) throw new Error(`gh api graphql mutation "${mutation.name}" needs "variables.${mutation.inputVariable}" as an object in the --input JSON file.`);
    changed = annotateGraphqlInput(input, mutation, context, trailer);
    if (changed || requestInput.fromStdin) {
      replaceOccurrence(args, inputs[0], tempFiles.write(`${JSON.stringify(request, null, 2)}\n`, '.json'));
      changed = true;
    }
    return { args, changed };
  }

  if (inputs.length) {
    if (!isRecord(request.variables)) throw new Error(`gh api graphql needs a variables object for mutation "${mutation.name}".`);
    for (const { field, variable } of mutation.variables) {
      if (typeof request.variables[variable] !== 'string') {
        throw new Error(`gh api graphql needs a string value for "${variable}" (${field}). Add "variables.${variable}" to the --input JSON object, using the user's text, then retry.`);
      }
      request.variables[variable] = context.attribution.annotateMarkdown(request.variables[variable]);
    }
    replaceOccurrence(args, inputs[0], tempFiles.write(`${JSON.stringify(request, null, 2)}\n`, '.json'));
    changed = true;
  } else {
    const variables = [...new Set(mutation.variables.map((entry) => entry.variable))];
    const bodyOccurrences = apiFieldOccurrences(args, variables.map((variable) => variable.toLowerCase()));
    const duplicate = bodyOccurrences.find((occurrence, index) => bodyOccurrences.slice(0, index).some((earlier) => earlier.field === occurrence.field));
    if (duplicate) throw new Error(`gh api graphql request contains more than one "${duplicate.key}" field. Supply that variable once.`);
    const missing = variables.find((variable) => !bodyOccurrences.some((occurrence) => occurrence.field === variable.toLowerCase()));
    if (missing) throw new Error(`gh api graphql mutation "${mutation.name}" needs a string value for "${missing}". Use -f ${missing}=<user-provided text>, or put it in one --input JSON object.`);
    if (bodyOccurrences.length) {
      for (const occurrence of bodyOccurrences) {
        if (['-F', '--field'].includes(occurrence.flag) && occurrence.value?.startsWith('@')) {
          const input = readTextFile(occurrence.value.slice(1), readStdin);
          replaceOccurrence(args, occurrence, `${occurrence.key}=@${tempFiles.write(context.attribution.annotateMarkdown(input.text), path.extname(occurrence.value.slice(1)) || '.md')}`);
        } else {
          replaceOccurrence(args, occurrence, `${occurrence.key}=${context.attribution.annotateMarkdown(occurrence.value)}`);
        }
        changed = true;
      }
      if (queryInput?.fromFile) {
        const file = tempFiles.write(request.query, path.extname(queryInput.file) || '.graphql');
        replaceOccurrence(args, queryOccurrence, `${queryOccurrence.key}=@${file}`);
      }
    }
  }
  return { args, changed };
}

/**
 * Annotates one allowlisted text field in a parsed gh api JSON body.
 * @param {Record<string, unknown>} value - Parsed JSON request object; updated in place.
 * @param {{model: string, template: string, link: string | undefined}} config - Current attribution settings.
 * @param {string[]} fields - Text fields that need a Markdown byline.
 * @param {string[]} passthroughFields - Text fields that need an identity check but no byline.
 * @param {string[]} trailerFields - Text fields that need a Git trailer.
 * @param {string} [trailer] - Rendered Git trailer for any matched trailer field.
 * @returns {boolean} Whether an attribution field was changed.
 * @throws {Error} If the JSON body contains unsupported or invalid text fields.
 * @private
 */
function annotateJson(value, context, fields, passthroughFields = [], trailerFields = [], trailer) {
  if (!isRecord(value)) throw new Error('gh api --input must contain one top-level JSON object. Put the endpoint’s supported text field in that object as a string.');
  const allowedFields = [...fields, ...passthroughFields, ...trailerFields];
  const unsupportedField = Object.keys(value).find((field) => API_TEXT_FIELDS.has(field) && !allowedFields.includes(field));
  if (unsupportedField) throw new Error(`gh api field "${unsupportedField}" is not supported for this endpoint. Supported text fields: ${allowedFields.join(', ')}. If that does not preserve the requested operation, stop and ask the user.`);
  const matches = fields.filter((field) => Object.hasOwn(value, field));
  const trailerMatches = trailerFields.filter((field) => Object.hasOwn(value, field));
  if (matches.length && trailerMatches.length) throw new Error('Use Markdown text fields or Git message fields in one JSON request, not both.');
  for (const field of matches) {
    if (typeof value[field] !== 'string') throw new Error(`gh api input field "${field}" must be a string. Use the user's text as a JSON string value.`);
    value[field] = annotateApiText(value[field], context, field);
  }
  for (const field of trailerMatches) {
    if (typeof value[field] !== 'string') throw new Error(`gh api input field "${field}" must be a string. Use the user's text as a JSON string value.`);
    value[field] = mergeBodyWithTrailer(value[field], trailer);
  }
  return Boolean(matches.length || trailerMatches.length);
}

/**
 * Adds the configured byline and checks the code-scanning comment limit.
 * @param {string} value - Original text, preserved in the attributed output.
 * @param {object} config - Validated model and Markdown attribution settings.
 * @param {string} field - REST text field being attributed.
 * @returns {string} Attributed text that fits the endpoint limit.
 * @throws {Error} If the attributed dismissal comment exceeds 280 characters.
 * @private
 */
function annotateApiText(value, context, field) {
  const output = context.attribution.annotateMarkdown(value);
  if (field === 'dismissed_comment' && [...output].length > 280) {
    throw new Error('attributed dismissed_comment exceeds GitHub\'s 280-character limit. Shorten the comment or the configured Markdown attribution template; cosplaying does not truncate text.');
  }
  return output;
}

/**
 * Rewrites supported mutating gh api requests to attribute their text payloads.
 * @param {string[]} inputArgs - Original gh api arguments.
 * @param {object} [options] - Parsed command and injected I/O settings.
 * @param {{path: string, nextIndex: number}} options.info - Parsed gh api command information.
 * @param {Record<string, string | undefined>} options.env - Environment variables used for attribution config.
 * @param {string} options.cwd - Working directory used to find project config.
 * @param {string} [options.home] - Home directory override for user config.
 * @param {string} [options.platform] - Platform override for user config paths.
 * @param {ReturnType<typeof createTempFiles>} options.tempFiles - Temporary file manager for rewritten inputs.
 * @param {function(): string} options.readStdin - Cached stdin reader.
 * @returns {{args: string[], changed: boolean}} Prepared arguments and whether a rewrite occurred.
 * @throws {Error} If a mutating request is unsupported or its text cannot be attributed safely.
 * @private
 */
function rewriteApiArgs(inputArgs, { info, context, tempFiles, readStdin } = {}) {
  const args = [...inputArgs];
  const method = apiMethod(args);
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return { args, changed: false };
  const endpoint = apiEndpoint(args, info);
  if (!endpoint) throw new Error('cannot determine the gh api endpoint for this mutating request. Put the endpoint after `gh api`, for example `gh api <endpoint> -X <method>`, and keep the request inside cosplaying.');
  const hostValue = flagOccurrences(args, new Set(['--hostname'])).at(-1)?.value;
  const route = normalizedApiEndpoint(endpoint.value, hostValue);
  if (route === 'graphql') {
    return rewriteGraphqlArgs(args, { context, tempFiles, readStdin });
  }
  if (method === 'POST' && (route === 'markdown' || /^repos\/[^/]+\/[^/]+\/releases\/generate-notes$/.test(route))) return { args, changed: false };
  const rule = apiRule(endpoint.value, method, hostValue);
  if (!rule) {
    const missingPull = method === 'POST' && endpoint.value.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/comments\/([^/]+)\/replies$/);
    if (missingPull) {
      throw new Error(`blocked unsupported mutating gh api request: ${method} ${endpoint.value}. Inline review comment replies need the pull request number after "pulls". Use "repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies". If you do not know the number, read "pull_request_url" from "gh api repos/${missingPull[1]}/${missingPull[2]}/pulls/comments/${missingPull[3]}" through cosplaying. Do not retry through bare gh.`);
    }
    throw new Error(`blocked unsupported mutating gh api request: ${method} ${endpoint.value}. This endpoint has no safe attribution rule. Stop and ask for an approved route instead of retrying through bare gh.`);
  }
  if (rule.identityOnly) {
    requireAttribution(context);
    return { args, changed: false };
  }
  if (rule.reviewerRequest) {
    return rewriteReviewerRequestArgs(args, { context, tempFiles, readStdin, operation: rule.reviewerRequest });
  }

  const fieldsAllowed = rule.fields || [];
  const passthroughFields = rule.passthroughFields || [];
  const trailerFields = rule.trailerFields || [];
  const payloadFields = rule.payloadFields || [];
  const supportedFields = [...fieldsAllowed, ...passthroughFields, ...trailerFields];
  const allTextFields = apiFieldOccurrences(args, [...API_TEXT_FIELDS]);
  const unsupportedField = allTextFields.find((occurrence) => !supportedFields.includes(occurrence.field));
  if (unsupportedField) throw new Error(`gh api field "${unsupportedField.field}" is not supported for ${method} ${endpoint.value}. Supported text fields: ${supportedFields.join(', ')}. If that changes the requested operation, stop and ask the user.`);
  const fields = apiFieldOccurrences(args, fieldsAllowed);
  const passthroughs = apiFieldOccurrences(args, passthroughFields);
  const trailers = apiFieldOccurrences(args, trailerFields);
  const inputs = flagOccurrences(args, API_INPUT_FLAGS);
  if (inputs.length > 1) throw new Error('gh api supports one `--input` value for attributed writes. Merge the request into one JSON object and pass one `--input <file>`.');
  if (inputs.length && flagOccurrences(args, API_FIELD_FLAGS).length) {
    throw new Error('choose one attributed request form: pass fields with `-f`/`-F`, or pass one JSON file with `--input`; do not combine them.');
  }
  if (rule.emptyReview && flagOccurrences(args, API_FIELD_FLAGS).some((field) => /^comments(?:\[|=|$)/i.test(field.value ?? ''))) {
    throw new Error('gh api review comments must use a JSON array in one --input file; field-encoded comments cannot be safely attributed. Put each inline comment body in comments[].body.');
  }
  const attributed = [...fields, ...trailers];
  const duplicate = attributed.find((occurrence, index) => attributed.slice(0, index).some((earlier) => earlier.field === occurrence.field));
  if (duplicate) throw new Error(`gh api request contains more than one "${duplicate.field}" field. Pass that field once.`);
  if (rule.dismissal && fields.some((occurrence) => occurrence.key !== 'dismissed_comment')) {
    throw new Error('code-scanning comments need the exact lowercase dismissed_comment field name so GitHub stores the attribution.');
  }
  if (rule.dismissal && !inputs.length) {
    const states = apiFieldOccurrences(args, ['state']);
    if (states.length !== 1 || states[0].key !== 'state' || states[0].value !== 'dismissed') {
      throw new Error('code-scanning alert writes need one literal state=dismissed field so GitHub stores the attributed comment. Reopening and other alert updates are not supported.');
    }
  }
  if (fields.length && trailers.length) throw new Error('Use Markdown text fields or Git message fields in one request, not both.');
  if (!inputs.length && !fields.length && !passthroughs.length && !trailers.length && !rule.emptyReview && !rule.allowTextless && !rule.defaultTrailerField) {
    if (payloadFields.length) throw new Error(`gh api ${method} ${endpoint.value} needs a JSON --input object with ${payloadFields.join(' or ')}.`);
    const allowed = supportedFields.length ? supportedFields.join('/') : 'an attributed text field';
    throw new Error(`gh api ${method} ${endpoint.value} needs an explicit ${allowed} field. Use one supported -f field or one --input JSON object.`);
  }

  requireAttribution(context);
  const trailer = trailerFields.length
    ? context.attribution.renderTrailer()
    : undefined;
  let changed = false;

  for (const occurrence of [...fields, ...trailers]) {
    const isTrailer = trailerFields.includes(occurrence.field);
    const value = occurrence.value;
    if (['-F', '--field'].includes(occurrence.flag) && value.startsWith('@')) {
      const file = value.slice(1);
      const input = readTextFile(file, readStdin);
      const output = isTrailer ? mergeBodyWithTrailer(input.text, trailer) : annotateApiText(input.text, context, occurrence.field);
      if (input.fromStdin || output !== input.text) {
        const replacement = `@${tempFiles.write(output, path.extname(file) || (isTrailer ? '.txt' : '.md'))}`;
        replaceOccurrence(args, occurrence, `${occurrence.key}=${replacement}`);
        changed = true;
      }
      continue;
    }
    const output = isTrailer ? mergeBodyWithTrailer(value, trailer) : annotateApiText(value, context, occurrence.field);
    if (output !== value) {
      replaceOccurrence(args, occurrence, `${occurrence.key}=${output}`);
      changed = true;
    }
  }

  for (const occurrence of inputs) {
    if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a value. Pass the JSON path after the flag, or as "${occurrence.flag}=<path>"; use - for stdin when supported.`);
    const file = occurrence.value;
    const input = readTextFile(file, readStdin);
    let body;
    try {
      body = JSON.parse(input.text);
    } catch (error) {
      throw new Error(`could not parse gh api JSON input ${file}: ${error.message}. Fix the JSON syntax and use one supported text field or payload.`);
    }
    if (rule.dismissal && body?.state !== 'dismissed') {
      throw new Error('code-scanning alert writes need state="dismissed" in the JSON object so GitHub stores the attributed comment. Reopening and other alert updates are not supported.');
    }
    let bodyChanged = annotateJson(body, context, fieldsAllowed, passthroughFields, trailerFields, trailer);
    if (rule.defaultTrailerField && !Object.hasOwn(body, rule.defaultTrailerField)) {
      body[rule.defaultTrailerField] = mergeBodyWithTrailer('', trailer);
      bodyChanged = true;
    }
    if (!bodyChanged && rule.emptyReview) {
      body.body = context.attribution.annotateMarkdown('');
      bodyChanged = true;
    }
    if (rule.emptyReview && Object.hasOwn(body, 'comments')) {
      if (!Array.isArray(body.comments)) throw new Error('gh api review comments must be a JSON array in --input.');
      for (const [index, comment] of body.comments.entries()) {
        if (!isRecord(comment) || typeof comment.body !== 'string') {
          throw new Error(`gh api review comments[${index}] must be an object with a string body; correct the JSON input before retrying.`);
        }
        comment.body = context.attribution.annotateMarkdown(comment.body);
      }
    }
    const hasText = supportedFields.some((field) => Object.hasOwn(body, field));
    const hasPayload = payloadFields.some((field) => Object.hasOwn(body, field) && isRecord(body[field]));
    if (!bodyChanged && !hasText && !hasPayload && !rule.emptyReview && !rule.allowTextless) {
      const allowed = [...supportedFields, ...payloadFields].join('/') || 'an attributed text field';
      throw new Error(`gh api ${method} ${endpoint.value} needs an explicit ${allowed} field in the JSON object.`);
    }
    if (bodyChanged || input.fromStdin) {
      replaceOccurrence(args, occurrence, tempFiles.write(`${JSON.stringify(body, null, 2)}\n`, '.json'));
      changed = true;
    }
  }

  if (rule.defaultTrailerField && !trailers.length && !inputs.length) {
    args.push('-f', `${rule.defaultTrailerField}=${mergeBodyWithTrailer('', trailer)}`);
    changed = true;
  }

  if (!fields.length && !passthroughs.length && !trailers.length && !inputs.length) {
    if (!rule.emptyReview && !rule.allowTextless && !rule.defaultTrailerField) throw new Error(`gh api ${method} ${endpoint.value} needs an explicit ${rule.fields.join('/')} field. Add the user's text with one -f ${rule.fields[0]}=<text> field or as a string in one --input JSON object.`);
    if (rule.allowTextless || rule.defaultTrailerField) return { args, changed };
    args.push('-f', `body=${context.attribution.annotateMarkdown('')}`);
    changed = true;
  }
  return { args, changed };
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
      if (occurrence.value === undefined) throw new Error(`${occurrence.flag} needs a value. Pass it after the flag or as "${occurrence.flag}=<value>".`);
      changed = annotateValueOccurrence(args, occurrence, context) || changed;
    }
    for (const occurrence of fileOccurrences) changed = annotateFileOccurrence(args, occurrence, context, tempFiles, readStdin) || changed;
    if (templateOccurrences.length && !valueOccurrences.length && !fileOccurrences.length) {
      for (const occurrence of templateOccurrences) changed = replaceTemplate(args, occurrence, context, tempFiles, readStdin) || changed;
    }

    if (AGENT_TASK_PATHS.has(info.path) && !fileOccurrences.length) {
      const position = agentTaskPosition(args, info);
      if (position >= 0) {
        const output = context.attribution.annotateMarkdown(args[position]);
        if (output !== args[position]) {
          args[position] = output;
          changed = true;
        }
      }
    }

    const hasText = valueOccurrences.length || fileOccurrences.length || templateOccurrences.length;
    if (TEXT_REQUIRED_PATHS.has(info.path) && !hasText && info.path !== 'pr review') {
      const acceptedFlags = descriptor ? [...descriptor.value, ...descriptor.file, ...descriptor.template] : [];
      throw new Error(`${info.path} needs explicit text so attribution can be guaranteed. Pass the user's intended text with one of these flags: ${acceptedFlags.join(', ') || 'a supported text input'}. If the user did not supply the text, ask before creating it.`);
    }
    if (info.path === 'pr review' && !hasText) {
      args.push('--body', context.attribution.annotateMarkdown(''));
      changed = true;
    }
    if (needsText && (args.includes('--web') || args.includes('-w'))) {
      const acceptedFlags = descriptor ? [...descriptor.value, ...descriptor.file, ...descriptor.template] : [];
      throw new Error(`${info.path} cannot use browser flows because the final text cannot be attributed. Remove --web/-w and pass the user's final text with ${acceptedFlags.join(', ') || 'a supported text input'}; do not retry outside cosplaying.`);
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
