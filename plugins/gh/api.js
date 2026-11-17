import path from 'node:path';
import { rewriteGraphqlArgs } from './graphql.js';
import {
  API_FIELD_FLAGS,
  API_INPUT_FLAGS,
  apiFieldOccurrences,
  createTempFiles,
  flagOccurrences,
  ghError,
  isRecord,
  mergeBodyWithTrailer,
  readTextFile,
  requireAttribution,
  replaceOccurrence,
} from './shared.js';

const API_METHOD_FLAGS = new Set(['-X', '--method']);
const API_TEXT_FIELDS = new Set([
  'body', 'comment', 'description', 'notes', 'title', 'name', 'new_name',
  'summary', 'message', 'commit_message', 'commit_title', 'label', 'bio',
  'general_instructions', 'dismissed_comment'
]);
const REVIEWER_FIELD_FLAGS = new Set(['reviewers[]', 'team_reviewers[]']);
const REVIEWER_INPUT_FIELDS = ['reviewers', 'team_reviewers'];
const API_VALUE_FLAGS = new Set([
  ...API_FIELD_FLAGS, ...API_METHOD_FLAGS, ...API_INPUT_FLAGS,
  '-H', '--header', '--jq', '--template', '--cache', '--hostname'
]);

/**
 * Returns the HTTP method a `gh api` invocation will use.
 *
 * An explicit `-X` or `--method` wins. A request that sends fields or an input file is `POST`. Anything else is `GET`, which this plugin does not rewrite.
 *
 * @param {string[]} args Arguments after `gh api`, or the full `gh` argument list. Method flags are searched in the whole list.
 * @returns {string} Uppercase method name.
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
 * Finds the endpoint argument of `gh api`.
 *
 * Flags that take a value are skipped, including `--hostname` and `-f`. The first remaining word is the endpoint. `--` ends the search with no endpoint, because the path would be ambiguous.
 *
 * @param {string[]} args Full `gh` arguments.
 * @param {{nextIndex: number}} info Parsed command. `nextIndex` is the first argument after `api`.
 * @returns {{value: string, index: number} | null} Endpoint text and its index. Null when no endpoint word is present.
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
 * Reduces a GitHub API endpoint to the route the allowlist matches.
 *
 * A relative path has its query and a leading `api/v3/` removed. An absolute URL is accepted only for `https://api.github.com` or the hostname from `--hostname`. Any other URL becomes an empty route so it matches no rule.
 *
 * @param {string} endpoint Endpoint argument, either a relative path or an absolute URL.
 * @param {string} [hostname] GitHub Enterprise hostname from `--hostname`. It is omitted for github.com.
 * @returns {string} Route without a leading slash. An empty string when an absolute URL is not an accepted host.
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
 * Finds the attribution rule for one mutating GitHub API route and method.
 *
 * Each rule names the text fields that receive a Markdown byline, the fields that are checked but not rewritten, and the fields that receive a Git trailer. A route with no rule is blocked. The first matching rule wins.
 *
 * @param {string} endpoint API route or absolute endpoint URL.
 * @param {string} method Uppercase HTTP method.
 * @param {string} [hostname] GitHub Enterprise hostname from `--hostname`.
 * @returns {object | null} The matching rule. `fields` receive a Markdown byline. `passthroughFields` require a model but are not rewritten. `trailerFields` receive the Git trailer. `identityOnly` checks the model and does not change the body. `reviewerRequest` is `request` or `remove`. Null when no rule matches.
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
    { pattern: /^gists$/, methods: ['POST'], fields: ['description'], payloadFields: ['files'], payloadDisclosureField: 'description' },
    { pattern: /^gists\/[^/]+$/, methods: ['PATCH'], fields: ['description'], payloadFields: ['files'], payloadDisclosureField: 'description' },
    { pattern: /^gists\/[^/]+\/comments$/, methods: ['POST'], fields: ['body'] },
    { pattern: /^gists\/[^/]+\/comments\/[^/]+$/, methods: ['PATCH'], fields: ['body'] },
    { pattern: new RegExp(`^${repo}$`), methods: ['PATCH'], fields: ['description'], passthroughFields: ['name'] },
    { pattern: new RegExp(`^${repo}/actions/runs/[^/]+/deployment_protection_rule$`), methods: ['POST'], fields: ['comment'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/actions/runs/[^/]+/pending_deployments$`), methods: ['POST'], fields: ['comment'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/actions/runs/[^/]+/rerun$`), methods: ['POST'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/actions/runs/[^/]+/rerun-failed-jobs$`), methods: ['POST'], allowTextless: true },
    { pattern: new RegExp(`^${repo}/actions/jobs/[^/]+/rerun$`), methods: ['POST'], allowTextless: true },
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
 * Checks a pull-request reviewer request and leaves its reviewer lists unchanged.
 *
 * The request has no prose to attribute. A model is still required so the write is tied to a session. The payload must be reviewer fields or one JSON object with `reviewers` or `team_reviewers`. Stdin JSON is copied to a private file. The reviewer names are not rewritten.
 *
 * @param {string[]} args Mutable `gh api` arguments. A stdin `--input` is replaced with a private path.
 * @param {object} tools Helpers for this check.
 * @param {object} tools.context Hook context.
 * @param {{annotateMarkdown: function(string): string}} tools.context.attribution Helper used to prove that a model is available.
 * @param {{write: function(string, string=): string}} tools.tempFiles Writer used when `--input` is stdin.
 * @param {function(): string} tools.readStdin Cached stdin reader.
 * @param {'request' | 'remove'} [tools.operation='request'] `request` adds reviewers. `remove` deletes them. The value only changes the error text.
 * @returns {{args: string[], changed: boolean}} The same arguments, and true when stdin was copied to a file.
 * @throws {CosplayError} The model is missing, or the reviewer payload is missing or not a list of non-empty strings.
 */
function rewriteReviewerRequestArgs(args, { context, tempFiles, readStdin, operation = 'request' }) {
  requireAttribution(context);
  const label = operation === 'remove' ? 'reviewer removals' : 'reviewer requests';
  const fields = flagOccurrences(args, API_FIELD_FLAGS);
  const inputs = flagOccurrences(args, API_INPUT_FLAGS);
  if (inputs.length > 1) throw ghError(`gh api ${label} support one --input value. Use one JSON object with reviewer arrays.`);
  if (inputs.length && fields.length) throw ghError('Use reviewer fields or one JSON --input file. Do not combine both forms.');

  if (inputs.length) {
    const occurrence = inputs[0];
    if (occurrence.value === undefined) throw ghError('--input needs a value. Pass a JSON file with reviewer arrays.');
    const input = readTextFile(occurrence.value, readStdin);
    let request;
    try { request = JSON.parse(input.text); } catch (error) {
      throw ghError(`could not parse gh api reviewer JSON input ${occurrence.value}: ${error.message}. Fix the JSON syntax.`);
    }
    if (!isRecord(request)) throw ghError('gh api reviewer JSON input must be one object with a reviewers or team_reviewers array.');
    const unsupported = Object.keys(request).find((field) => !REVIEWER_INPUT_FIELDS.includes(field));
    if (unsupported) throw ghError(`gh api reviewer JSON input only accepts reviewers and team_reviewers arrays. Remove "${unsupported}".`);
    let hasReviewer = false;
    for (const field of REVIEWER_INPUT_FIELDS) {
      if (!Object.hasOwn(request, field)) continue;
      if (!Array.isArray(request[field]) || request[field].some((name) => typeof name !== 'string' || !name.trim())) {
        throw ghError(`gh api reviewer input field "${field}" must be an array of non-empty strings.`);
      }
      hasReviewer ||= request[field].length > 0;
    }
    if (!hasReviewer) throw ghError(`Add at least one reviewer in reviewers or team_reviewers to ${operation} reviewers.`);
    if (input.fromStdin) replaceOccurrence(args, occurrence, tempFiles.write(input.text, '.json'));
    return { args, changed: input.fromStdin };
  }

  if (!fields.length) throw ghError(`Add a reviewer with -f "reviewers[]=<login>" or -f "team_reviewers[]=<slug>", or pass reviewer arrays in JSON with --input to ${operation} reviewers.`);
  for (const occurrence of fields) {
    if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a reviewer field and value.`);
    const separator = occurrence.value.indexOf('=');
    const field = occurrence.value.slice(0, separator);
    if (separator < 1 || !REVIEWER_FIELD_FLAGS.has(field)) {
      throw ghError('gh api reviewer requests only accept reviewers[] and team_reviewers[] fields.');
    }
    if (!occurrence.value.slice(separator + 1).trim()) throw ghError(`gh api reviewer field "${field}" needs a non-empty value.`);
  }
  return { args, changed: false };
}

/**
 * Attributes the allowlisted text fields of one `gh api` JSON object.
 *
 * Markdown fields receive the byline. Trailer fields receive the Git trailer. A request must not mix those two kinds. Fields that are only passed through are not rewritten. The object is updated in place.
 *
 * @param {Record<string, unknown>} value Parsed JSON object.
 * @param {object} context Hook context.
 * @param {{annotateMarkdown: function(string): string}} context.attribution Helper that appends the Markdown byline.
 * @param {string[]} fields Field names that receive a Markdown byline.
 * @param {string[]} [passthroughFields=[]] Field names that may be present and are not rewritten.
 * @param {string[]} [trailerFields=[]] Field names that receive the Git trailer.
 * @param {string} [trailer] Rendered `AI-Assisted-By` line. Required when a trailer field is present.
 * @returns {boolean} True when a Markdown field or a trailer field was present and rewritten.
 * @throws {CosplayError} The value is not an object, a text field is not allowlisted, a value is not a string, or Markdown fields and trailer fields are both present.
 */
function annotateJson(value, context, fields, passthroughFields = [], trailerFields = [], trailer) {
  if (!isRecord(value)) throw ghError('gh api --input must contain one top-level JSON object. Put the endpoint’s supported text field in that object as a string.');
  const allowedFields = [...fields, ...passthroughFields, ...trailerFields];
  const unsupportedField = Object.keys(value).find((field) => API_TEXT_FIELDS.has(field) && !allowedFields.includes(field));
  if (unsupportedField) throw ghError(`gh api field "${unsupportedField}" is not supported for this endpoint. Supported text fields: ${allowedFields.join(', ')}. If that does not preserve the requested operation, stop and ask the user.`);
  const matches = fields.filter((field) => Object.hasOwn(value, field));
  const trailerMatches = trailerFields.filter((field) => Object.hasOwn(value, field));
  if (matches.length && trailerMatches.length) throw ghError('Use Markdown text fields or Git message fields in one JSON request, not both.');
  for (const field of matches) {
    if (typeof value[field] !== 'string') throw ghError(`gh api input field "${field}" must be a string. Use the user's text as a JSON string value.`);
    value[field] = annotateApiText(value[field], context, field);
  }
  for (const field of trailerMatches) {
    if (typeof value[field] !== 'string') throw ghError(`gh api input field "${field}" must be a string. Use the user's text as a JSON string value.`);
    value[field] = mergeBodyWithTrailer(value[field], trailer);
  }
  return Boolean(matches.length || trailerMatches.length);
}

/**
 * Appends the Markdown byline and enforces the code-scanning comment limit.
 *
 * GitHub stores `dismissed_comment` only up to 280 characters. The text is not truncated. A longer result is refused so the caller can shorten the comment or the template.
 *
 * @param {string} value Original field text.
 * @param {object} context Hook context.
 * @param {{annotateMarkdown: function(string): string}} context.attribution Helper that appends the Markdown byline.
 * @param {string} field REST field name. `dismissed_comment` is length-checked. Other fields are not.
 * @returns {string} Attributed text.
 * @throws {CosplayError} The attributed `dismissed_comment` is longer than 280 characters, or the byline cannot be rendered.
 */
function annotateApiText(value, context, field) {
  const output = context.attribution.annotateMarkdown(value);
  if (field === 'dismissed_comment' && [...output].length > 280) {
    throw ghError('attributed dismissed_comment exceeds GitHub\'s 280-character limit. Shorten the comment or the configured Markdown attribution template; cosplaying does not truncate text.');
  }
  return output;
}

/**
 * Rewrites a mutating `gh api` request so its text payload includes attribution.
 *
 * `GET`, `HEAD`, and `OPTIONS` are returned unchanged. `graphql` is delegated. Markdown rendering and release-note generation are returned unchanged because they do not publish the caller's text. Every other mutating route must match an allowlist rule. Field form and one `--input` file must not be combined. A missing text field is refused unless the rule allows a textless call or supplies a default trailer.
 *
 * @param {string[]} inputArgs Original `gh api` arguments. This array is copied before it is edited.
 * @param {object} [tools]
 * @param {{path: string, nextIndex: number}} tools.info Parsed `gh` command. `nextIndex` is the first argument after `api`.
 * @param {object} tools.context Hook context.
 * @param {{annotateMarkdown: function(string): string, renderTrailer: function(): string}} tools.context.attribution Attribution helpers.
 * @param {{write: function(string, string=): string}} tools.tempFiles Writer for rewritten JSON and file fields.
 * @param {function(): string} tools.readStdin Cached stdin reader.
 * @returns {{args: string[], changed: boolean}} Arguments to spawn, and whether a value was rewritten or a default field was added.
 * @throws {CosplayError} The route has no rule, or its text cannot be attributed safely.
 */
export function rewriteApiArgs(inputArgs, { info, context, tempFiles, readStdin } = {}) {
  const args = [...inputArgs];
  const method = apiMethod(args);
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return { args, changed: false };
  const endpoint = apiEndpoint(args, info);
  if (!endpoint) throw ghError('cannot determine the gh api endpoint for this mutating request. Put the endpoint after `gh api`, for example `gh api <endpoint> -X <method>`, and keep the request inside cosplaying.');
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
      throw ghError(`blocked unsupported mutating gh api request: ${method} ${endpoint.value}. Inline review comment replies need the pull request number after "pulls". Use "repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies". If you do not know the number, read "pull_request_url" from "gh api repos/${missingPull[1]}/${missingPull[2]}/pulls/comments/${missingPull[3]}" through cosplaying. Do not retry through bare gh.`);
    }
    throw ghError(`blocked unsupported mutating gh api request: ${method} ${endpoint.value}. This endpoint has no safe attribution rule. Stop and ask for an approved route instead of retrying through bare gh.`);
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
  const payloadDisclosureField = rule.payloadDisclosureField;
  const supportedFields = [...fieldsAllowed, ...passthroughFields, ...trailerFields];
  const allTextFields = apiFieldOccurrences(args, [...API_TEXT_FIELDS]);
  const unsupportedField = allTextFields.find((occurrence) => !supportedFields.includes(occurrence.field));
  if (unsupportedField) throw ghError(`gh api field "${unsupportedField.field}" is not supported for ${method} ${endpoint.value}. Supported text fields: ${supportedFields.join(', ')}. If that changes the requested operation, stop and ask the user.`);
  const fields = apiFieldOccurrences(args, fieldsAllowed);
  const passthroughs = apiFieldOccurrences(args, passthroughFields);
  const trailers = apiFieldOccurrences(args, trailerFields);
  const inputs = flagOccurrences(args, API_INPUT_FLAGS);
  if (inputs.length > 1) throw ghError('gh api supports one `--input` value for attributed writes. Merge the request into one JSON object and pass one `--input <file>`.');
  if (inputs.length && flagOccurrences(args, API_FIELD_FLAGS).length) {
    throw ghError('choose one attributed request form: pass fields with `-f`/`-F`, or pass one JSON file with `--input`; do not combine them.');
  }
  if (rule.emptyReview && flagOccurrences(args, API_FIELD_FLAGS).some((field) => /^comments(?:\[|=|$)/i.test(field.value ?? ''))) {
    throw ghError('gh api review comments must use a JSON array in one --input file; field-encoded comments cannot be safely attributed. Put each inline comment body in comments[].body.');
  }
  const attributed = [...fields, ...trailers];
  const duplicate = attributed.find((occurrence, index) => attributed.slice(0, index).some((earlier) => earlier.field === occurrence.field));
  if (duplicate) throw ghError(`gh api request contains more than one "${duplicate.field}" field. Pass that field once.`);
  if (rule.dismissal && fields.some((occurrence) => occurrence.key !== 'dismissed_comment')) {
    throw ghError('code-scanning comments need the exact lowercase dismissed_comment field name so GitHub stores the attribution.');
  }
  if (rule.dismissal && !inputs.length) {
    const states = apiFieldOccurrences(args, ['state']);
    if (states.length !== 1 || states[0].key !== 'state' || states[0].value !== 'dismissed') {
      throw ghError('code-scanning alert writes need one literal state=dismissed field so GitHub stores the attributed comment. Reopening and other alert updates are not supported.');
    }
  }
  if (fields.length && trailers.length) throw ghError('Use Markdown text fields or Git message fields in one request, not both.');
  if (!inputs.length && !fields.length && !passthroughs.length && !trailers.length && !rule.emptyReview && !rule.allowTextless && !rule.defaultTrailerField) {
    if (payloadFields.length) throw ghError(`gh api ${method} ${endpoint.value} needs a JSON --input object with ${payloadFields.join(' or ')}.`);
    const allowed = supportedFields.length ? supportedFields.join('/') : 'an attributed text field';
    throw ghError(`gh api ${method} ${endpoint.value} needs an explicit ${allowed} field. Use one supported -f field or one --input JSON object.`);
  }

  if (!rule.allowTextless || fields.length || passthroughs.length || trailers.length) requireAttribution(context);
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
    if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a value. Pass the JSON path after the flag, or as "${occurrence.flag}=<path>"; use - for stdin when supported.`);
    const file = occurrence.value;
    const input = readTextFile(file, readStdin);
    let body;
    try {
      body = JSON.parse(input.text);
    } catch (error) {
      throw ghError(`could not parse gh api JSON input ${file}: ${error.message}. Fix the JSON syntax and use one supported text field or payload.`);
    }
    if (rule.dismissal && body?.state !== 'dismissed') {
      throw ghError('code-scanning alert writes need state="dismissed" in the JSON object so GitHub stores the attributed comment. Reopening and other alert updates are not supported.');
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
      if (!Array.isArray(body.comments)) throw ghError('gh api review comments must be a JSON array in --input.');
      for (const [index, comment] of body.comments.entries()) {
        if (!isRecord(comment) || typeof comment.body !== 'string') {
          throw ghError(`gh api review comments[${index}] must be an object with a string body; correct the JSON input before retrying.`);
        }
        comment.body = context.attribution.annotateMarkdown(comment.body);
      }
    }
    const hasText = supportedFields.some((field) => Object.hasOwn(body, field));
    const hasPayload = payloadFields.some((field) => Object.hasOwn(body, field) && isRecord(body[field]));
    const hasPayloadText = payloadDisclosureField && payloadFields.some((field) => {
      const payload = body[field];
      return isRecord(payload) && Object.values(payload).some((file) => isRecord(file) && Object.hasOwn(file, 'content'));
    });
    if (hasPayloadText && !Object.hasOwn(body, payloadDisclosureField)) {
      throw ghError(`gh api ${method} ${endpoint.value} file writes need an attributed ${payloadDisclosureField} field in the JSON object.`);
    }
    if (!bodyChanged && !hasText && !hasPayload && !rule.emptyReview && !rule.allowTextless) {
      const allowed = [...supportedFields, ...payloadFields].join('/') || 'an attributed text field';
      throw ghError(`gh api ${method} ${endpoint.value} needs an explicit ${allowed} field in the JSON object.`);
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
    if (!rule.emptyReview && !rule.allowTextless && !rule.defaultTrailerField) throw ghError(`gh api ${method} ${endpoint.value} needs an explicit ${rule.fields.join('/')} field. Add the user's text with one -f ${rule.fields[0]}=<text> field or as a string in one --input JSON object.`);
    if (rule.allowTextless || rule.defaultTrailerField) return { args, changed };
    args.push('-f', `body=${context.attribution.annotateMarkdown('')}`);
    changed = true;
  }
  return { args, changed };
}
