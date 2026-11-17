import path from 'node:path';
import { Kind, parse } from 'graphql';
import {
  API_FIELD_FLAGS,
  API_INPUT_FLAGS,
  apiFieldOccurrences,
  flagOccurrences,
  ghError,
  isRecord,
  mergeBodyWithTrailer,
  readTextFile,
  requireAttribution,
  replaceOccurrence,
} from './shared.js';

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

/**
 * Finds a supported GraphQL mutation and its attributed input fields.
 * @param {string} query - GraphQL query text.
 * @returns {{name: string, fields?: string[], allowedFields?: string[], variables?: Array<{field: string, variable: string}>, inputVariable?: string, trailerRule?: object, identityOnly?: boolean} | null} Mutation details, or null for a read or untracked action.
 * @throws {CosplayError} If a GraphQL mutation is not safely allowlisted.
 * @private
 */
function graphqlMutation(query) {
  let document;
  try {
    document = parse(query, { noLocation: true });
  } catch {
    return null;
  }

  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  const mutations = operations.filter((operation) => operation.operation === 'mutation');
  if (!mutations.length) return null;
  if (operations.length !== 1 || mutations.length !== 1) {
    throw ghError('blocked unsupported mutating gh api request: POST graphql. cosplaying can attribute one approved content or reviewer mutation per request; split out unrelated operations. If the requested mutation is different, stop and ask for an approved route.');
  }

  const selections = mutations[0].selectionSet.selections;
  const field = selections.length === 1 && selections[0].kind === Kind.FIELD
    ? selections[0]
    : null;
  if (field && GRAPHQL_ACTION_MUTATIONS.has(field.name.value)) return null;
  if (!field) throw ghError('blocked unsupported mutating gh api request: POST graphql. cosplaying needs one direct mutation field with an approved attribution rule; do not retry through bare `gh`.');
  const name = field.name.value;
  if (GRAPHQL_IDENTITY_MUTATIONS.has(name)) return { name, identityOnly: true };
  const textFields = GRAPHQL_CONTENT_MUTATIONS.get(name) || [];
  const trailerRule = GRAPHQL_TRAILER_MUTATIONS.get(name);
  if (!textFields.length && !trailerRule) {
    throw ghError(`blocked unsupported mutating gh api request: POST graphql. cosplaying has no attribution rule for "${name}"; stop and ask for an approved route instead of retrying through bare gh.`);
  }

  const inputs = field.arguments.filter((argument) => argument.name.value === 'input');
  if (inputs.length !== 1) throw ghError(`gh api graphql mutation "${name}" needs one input object.`);
  const allowedFields = [...new Set([...textFields, ...GRAPHQL_PASSTHROUGH_FIELDS, ...(trailerRule?.allowedFields || [])])];
  if (inputs[0].value.kind === Kind.VARIABLE) {
    return { name, fields: textFields, allowedFields, inputVariable: inputs[0].value.name.value, trailerRule };
  }
  if (trailerRule) throw ghError(`gh api graphql mutation "${name}" needs one --input JSON object with the complete "variables.input" object so cosplaying can add the commit trailer.`);
  if (inputs[0].value.kind !== Kind.OBJECT) throw ghError(`gh api graphql mutation "${name}" needs one input object.`);
  const inputFields = inputs[0].value.fields;
  if (name === 'addPullRequestReview' && inputFields.some((inputField) => ['comments', 'threads'].includes(inputField.name.value))) {
    throw ghError('gh api graphql batch review comments and threads need one --input JSON object with a variables.input object so cosplaying can attribute every body.');
  }
  const unsupportedField = inputFields.find((inputField) => GRAPHQL_TEXT_FIELDS.has(inputField.name.value) && !allowedFields.includes(inputField.name.value));
  if (unsupportedField) throw ghError(`gh api graphql mutation "${name}" does not support the "${unsupportedField.name.value}" text field. Use a REST route with a matching attribution rule.`);
  const variables = [];
  for (const textField of textFields) {
    const matches = inputFields.filter((inputField) => inputField.name.value === textField);
    if (matches.length > 1) throw ghError(`gh api graphql mutation "${name}" contains more than one "${textField}" field.`);
    if (!matches.length) continue;
    if (matches[0].value.kind !== Kind.VARIABLE) {
      throw ghError(`gh api graphql mutation "${name}" needs "${textField}: $variable" and a string value for that variable. Pass the text with -f or put it in one --input JSON object.`);
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
 * @throws {CosplayError} If the value is missing or its file cannot be read.
 * @private
 */
function readGraphqlField(occurrence, readStdin) {
  if (occurrence.value === undefined) throw ghError(`${occurrence.flag} needs a value. Pass key=<value> after the flag or as "${occurrence.flag}=key=<value>".`);
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
 * @throws {CosplayError} If the input contains unsupported text fields or invalid values.
 * @private
 */
function annotateGraphqlInput(input, mutation, context, trailer) {
  const unsupported = Object.keys(input).find((field) => GRAPHQL_TEXT_FIELDS.has(field) && !mutation.allowedFields.includes(field));
  if (unsupported) throw ghError(`gh api graphql mutation "${mutation.name}" does not support the "${unsupported}" text field.`);
  let changed = false;
  for (const field of mutation.fields || []) {
    if (!Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== 'string') throw ghError(`gh api graphql needs a string value for "${field}" in mutation "${mutation.name}".`);
    input[field] = context.attribution.annotateMarkdown(input[field]);
    changed = true;
  }
  if (mutation.name === 'addPullRequestReview') {
    for (const field of ['comments', 'threads']) {
      if (!Object.hasOwn(input, field)) continue;
      if (!Array.isArray(input[field])) throw ghError(`gh api graphql review input "${field}" must be an array.`);
      for (const [index, entry] of input[field].entries()) {
        if (!isRecord(entry) || typeof entry.body !== 'string') throw ghError(`gh api graphql review input ${field}[${index}] must contain a string body.`);
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
      if (typeof input[field] !== 'string') throw ghError(`gh api graphql commit message field "${field}" must be a string.`);
      input[field] = mergeBodyWithTrailer(input[field], trailer);
      changed = true;
    } else if (fieldPath) {
      let target = input;
      for (const part of fieldPath.slice(0, -1)) {
        if (!isRecord(target[part])) throw ghError(`gh api graphql mutation "${mutation.name}" needs an object at "${fieldPath.slice(0, -1).join('.')}".`);
        target = target[part];
      }
      const last = fieldPath.at(-1);
      if (!Object.hasOwn(target, last)) target[last] = '';
      if (target[last] === null) target[last] = '';
      if (typeof target[last] !== 'string') throw ghError(`gh api graphql commit message field "${fieldPath.join('.')}" must be a string.`);
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
 * @throws {CosplayError} If the mutation or body input cannot be attributed safely.
 * @private
 */
export function rewriteGraphqlArgs(inputArgs, { context, tempFiles, readStdin }) {
  const args = [...inputArgs];
  const inputs = flagOccurrences(args, API_INPUT_FLAGS);
  if (inputs.length > 1) throw ghError('gh api graphql supports one `--input` value. Merge the query and variables into one JSON object and pass one `--input <file>`.');

  let request;
  let requestInput;
  let queryOccurrence;
  let queryInput;
  if (inputs.length) {
    if (flagOccurrences(args, API_FIELD_FLAGS).length) {
      throw ghError('choose one GraphQL input form: use `-f`/`-F` fields for the query and variables, or one `--input <file>` JSON object containing `query` and `variables`; do not combine them.');
    }
    if (inputs[0].value === undefined) throw ghError(`${inputs[0].flag} needs a value. Pass one JSON file containing a top-level query string and its variables.`);
    requestInput = readTextFile(inputs[0].value, readStdin);
    try { request = JSON.parse(requestInput.text); } catch (error) {
      throw ghError(`could not parse GraphQL JSON input ${inputs[0].value}: ${error.message}. Fix the JSON syntax; use one object with a top-level "query" string and optional "variables" object.`);
    }
    if (!isRecord(request) || typeof request.query !== 'string') {
      throw ghError('gh api graphql --input must be one JSON object with a top-level string `query` and an optional `variables` object.');
    }
  } else {
    const queryOccurrences = apiFieldOccurrences(args, ['query']);
    if (queryOccurrences.length !== 1) throw ghError('gh api graphql needs exactly one query field. Pass one `-f query=<GraphQL document>`; for JSON input, use one `--input <file>` with a top-level `query` string.');
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
    if (!inputs.length) throw ghError(`gh api graphql mutation "${mutation.name}" uses an input variable. Pass one --input JSON object with "variables.${mutation.inputVariable}" as an object.`);
    const input = isRecord(request.variables) ? request.variables[mutation.inputVariable] : undefined;
    if (!isRecord(input)) throw ghError(`gh api graphql mutation "${mutation.name}" needs "variables.${mutation.inputVariable}" as an object in the --input JSON file.`);
    changed = annotateGraphqlInput(input, mutation, context, trailer);
    if (changed || requestInput.fromStdin) {
      replaceOccurrence(args, inputs[0], tempFiles.write(`${JSON.stringify(request, null, 2)}\n`, '.json'));
      changed = true;
    }
    return { args, changed };
  }

  if (inputs.length) {
    if (!isRecord(request.variables)) throw ghError(`gh api graphql needs a variables object for mutation "${mutation.name}".`);
    for (const { field, variable } of mutation.variables) {
      if (typeof request.variables[variable] !== 'string') {
        throw ghError(`gh api graphql needs a string value for "${variable}" (${field}). Add "variables.${variable}" to the --input JSON object, using the user's text, then retry.`);
      }
      request.variables[variable] = context.attribution.annotateMarkdown(request.variables[variable]);
    }
    replaceOccurrence(args, inputs[0], tempFiles.write(`${JSON.stringify(request, null, 2)}\n`, '.json'));
    changed = true;
  } else {
    const variables = [...new Set(mutation.variables.map((entry) => entry.variable))];
    const bodyOccurrences = apiFieldOccurrences(args, variables.map((variable) => variable.toLowerCase()));
    const duplicate = bodyOccurrences.find((occurrence, index) => bodyOccurrences.slice(0, index).some((earlier) => earlier.field === occurrence.field));
    if (duplicate) throw ghError(`gh api graphql request contains more than one "${duplicate.key}" field. Supply that variable once.`);
    const missing = variables.find((variable) => !bodyOccurrences.some((occurrence) => occurrence.field === variable.toLowerCase()));
    if (missing) throw ghError(`gh api graphql mutation "${mutation.name}" needs a string value for "${missing}". Use -f ${missing}=<user-provided text>, or put it in one --input JSON object.`);
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
