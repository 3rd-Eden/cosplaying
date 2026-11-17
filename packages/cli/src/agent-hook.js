import { readSync } from 'node:fs';
import { annotateMarkdown, normalizeIdentity, renderTrailer } from 'cosplaying/attribution';
import { CosplayError } from 'cosplaying/errors';
import { block } from 'cosplaying/plugin';
import { loadPlugins } from './plugins.js';
import { adapters, getAdapter } from 'cosplaying/adapters';
import { repairHookOrder } from './harness.js';
import { commandPrefix, cliInvocation } from './paths.js';
import { orderWarning, renderSession, retryReason } from './prompt.js';
import { rewriteModelFlags, rewriteShellCommand } from './shell.js';

/**
 * @param {import('node:fs').ReadStream | NodeJS.ReadStream} stdin
 * @returns {string}
 */
export function readStdin(stdin) {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  while (true) {
    let count;
    try {
      count = readSync(stdin.fd, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = error.code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      throw new CosplayError({
        name: 'cli',
        method: 'readStdin',
        message: 'could not read hook input: %s. Run this command from the harness so it can write one JSON object to stdin.',
        args: [error.message],
        cause: error,
      });
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {Record<string, unknown>} input
 * @param {{container: string, field: string}} extracted
 * @param {string} command
 * @returns {Record<string, unknown>}
 */
function updatedToolInput(input, extracted, command) {
  const copy = structuredClone(input);
  const container = copy[extracted.container];
  container[extracted.field] = command;
  return container;
}

/**
 * @param {string} command
 * @param {Record<string, string>} routes
 * @returns {boolean}
 */
function isWrapped(command, routes) {
  if (rewriteShellCommand(command, routes).changed) return true;
  return /\b(?:cosplaying(?:\.js)?|main\.js)\b/.test(command);
}

/**
 * @param {object} context
 * @returns {Promise<{plugins: object[], routes: Record<string, string>, model: string, error?: Error}>}
 */
async function prepare(context, model) {
  const { config, plugins } = await loadPlugins(context);
  /** @type {Record<string, string>} */
  const routes = {};
  for (const plugin of plugins) {
    if (plugin.descriptor.intercept === false) continue;
    routes[plugin.command] = commandPrefix(plugin.command, model, context.platform);
  }
  return { plugins, routes, config, model };
}

/**
 * @param {string} id
 * @param {string | undefined} eventName
 * @param {object} context
 * @returns {Promise<number>}
 */
export async function runAgentHook(id, eventName, context) {
  const { stdout, stderr } = context;
  const harness = getAdapter(id);
  if (!harness) {
    stderr.write(`cosplaying: ${new CosplayError({
      name: 'cli',
      method: 'runAgentHook',
      message: 'unknown harness %s. Supported harnesses: %s. Run cosplaying install --harness <name> with one of those harness names.',
      args: [id, adapters.map((item) => item.id).join(', ')],
    }).message}\n`);
    return 2;
  }
  const event = eventName || harness.defaultEvent();
  let raw;
  try {
    raw = context.input !== undefined ? context.input : readStdin(context.stdin || process.stdin);
  } catch (error) {
    stderr.write(`cosplaying: ${error.message}\n`);
    return 2;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    stderr.write(`cosplaying: ${new CosplayError({
      name: 'cli',
      method: 'runAgentHook',
      message: 'invalid hook input: %s. The calling agent must send one JSON hook payload on stdin. Call agent-hook with a single JSON object on stdin. This command is for harness hooks, not for typed commands.',
      args: [error.message],
    }).message}\n`);
    return 2;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    stderr.write(`cosplaying: ${new CosplayError({
      name: 'cli',
      method: 'runAgentHook',
      message: 'invalid hook input: %s. The calling agent must send one JSON hook payload on stdin. Call agent-hook with a single JSON object on stdin. This command is for harness hooks, not for typed commands.',
      args: ['expected a JSON object'],
    }).message}\n`);
    return 2;
  }

  if (harness.endsSession(event)) {
    harness.onSessionEnd(input, context);
    return 0;
  }
  if (harness.switchesModel(event)) {
    harness.onModelSwitch(input, context);
    return 0;
  }

  const model = resolvePayloadModel(input, harness, context);
  let prepared;
  try {
    prepared = await prepare(context, model);
  } catch (error) {
    const message = error.message;
    if (harness.isPreTool(event)) {
      stdout.write(`${JSON.stringify(harness.deny(message))}\n`);
      return 0;
    }
    stderr.write(`cosplaying: ${message}\n`);
    return 1;
  }

  const repair = repairHookOrder({ ...context, commands: Object.keys(prepared.routes) });

  if (harness.isSessionStart(event)) {
    harness.onSessionStart(input, context);
    let prompt = renderSession({
      harness: id,
      executable: cliInvocation(context.platform),
      commands: Object.keys(prepared.routes),
      template: prepared.config.session,
    });
    const problemFiles = [...repair.conflicts, ...repair.failures].map((issue) => issue.file);
    if (problemFiles.length) prompt = `${prompt}\n\n${orderWarning(problemFiles)}`;
    stdout.write(harness.sessionPayload(prompt));
    return 0;
  }

  if (!harness.isPreTool(event)) return 0;
  if (!harness.isShellTool(input)) return 0;
  const extracted = harness.extractCommand(input);
  if (!extracted) {
    if (harness.denyUnreadable()) {
      stdout.write(`${JSON.stringify(harness.deny('cosplaying could not read the shell command. The command was not run. Retry it through cosplaying.'))}\n`);
    }
    return 0;
  }

  const problem = repair.repaired.length > 0 || repair.conflicts.length > 0 || repair.failures.length > 0;
  if (problem && isWrapped(extracted.command, prepared.routes)) {
    const files = [...repair.repaired, ...repair.conflicts.map((issue) => issue.file), ...repair.failures.map((issue) => issue.file)];
    stdout.write(`${JSON.stringify(harness.deny(retryReason(files, repair.repaired.length > 0 && repair.conflicts.length === 0 && repair.failures.length === 0)))}\n`);
    return 0;
  }

  const rewritten = rewriteModelFlags(rewriteShellCommand(extracted.command, prepared.routes).command, model);
  if (rewritten === extracted.command) {
    const payload = harness.unchanged();
    if (payload) stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  stdout.write(`${JSON.stringify(harness.allow(updatedToolInput(input, extracted, rewritten)))}\n`);
  return 0;
}

/**
 * @param {Record<string, unknown>} input
 * @param {import('cosplaying/adapters').Harness} harness
 * @param {object} context
 * @returns {string}
 */
function resolvePayloadModel(input, harness, context) {
  const direct = normalizeIdentity(input.model);
  if (direct) return direct;
  const modelId = normalizeIdentity(input.model_id);
  if (modelId) return modelId;
  const saved = harness.modelFromSession(input, context);
  if (saved) return saved;
  const fromEnv = normalizeIdentity(context.env.COSPLAYING_MODEL);
  if (fromEnv) return fromEnv;
  return harness.label || '';
}

/**
 * Builds the attribution helpers passed to a plugin.
 * @param {object} context
 * @param {string} model
 * @param {{ markdown?: string, trailer?: string, link?: string, variables?: Record<string, string> }} config
 */
export function attributionApi(context, model, config) {
  return {
    annotateMarkdown(text) {
      return annotateMarkdown(text, { model, template: config.markdown, link: config.link, variables: config.variables });
    },
    renderTrailer() {
      return renderTrailer(model, { template: config.trailer, link: config.link, variables: config.variables });
    },
  };
}

export { block };
