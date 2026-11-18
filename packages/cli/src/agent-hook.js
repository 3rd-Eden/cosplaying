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
 * Reads the hook payload that the harness writes to stdin.
 *
 * The read is synchronous because the hook process must answer before the tool runs. A temporary `EAGAIN` is retried. The bytes are decoded as UTF-8.
 *
 * @param {import('node:fs').ReadStream | NodeJS.ReadStream} stdin Stream the harness writes. `fd` is read until EOF.
 * @returns {string} The complete stdin text.
 * @throws {CosplayError} The read fails for a reason other than a temporary lack of data.
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
 * Returns a copy of the tool input with the shell command replaced.
 *
 * The harness allow payload sends this object back as the tool input. The original payload is not mutated.
 *
 * @param {Record<string, unknown>} input Hook payload that contains the tool input object.
 * @param {{container: string, field: string}} extracted Location returned by the harness. `container` is `tool_input` or `toolInput`. `field` is the command field.
 * @param {string} command Rewritten shell command.
 * @returns {Record<string, unknown>} Copy of the tool input object with `field` set to `command`.
 */
function updatedToolInput(input, extracted, command) {
  const copy = structuredClone(input);
  const container = copy[extracted.container];
  container[extracted.field] = command;
  return container;
}

/**
 * Reports whether a shell command is one that cosplaying would wrap or already mentions this CLI.
 *
 * Hook-order failures deny these commands. A command that does not match a route and does not call this CLI is allowed to run.
 *
 * @param {string} command Shell command from the tool payload.
 * @param {Record<string, string>} routes Map of plugin command name to its rewrite prefix.
 * @returns {boolean} True when rewrite would change the command, or when the command already names this CLI.
 */
function isWrapped(command, routes) {
  if (rewriteShellCommand(command, routes).changed) return true;
  return /\b(?:cosplaying(?:\.js)?|main\.js)\b/.test(command);
}

/**
 * Loads plugins and builds the rewrite route for each one that intercepts shell commands.
 *
 * A plugin with `intercept: false` is omitted. The route prefix includes the model so the wrapped command still knows which model to attribute.
 *
 * @param {object} context Runtime context used to load settings and plugins.
 * @param {string} [context.cwd] Directory used to find project settings.
 * @param {string} [context.home] Home directory used to find user settings.
 * @param {NodeJS.ProcessEnv} [context.env] Environment used for plugin paths.
 * @param {NodeJS.Platform} [context.platform] Platform used to quote the route prefix.
 * @param {string} model Model name placed in each route prefix. It may be empty.
 * @returns {Promise<{plugins: object[], routes: Record<string, string>, config: Record<string, unknown>, model: string}>} Loaded plugins, the route map, the merged settings, and the same model.
 * @throws {CosplayError} Settings or a named plugin cannot be loaded.
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
 * Handles one harness hook event.
 *
 * Session start writes the session prompt. A pre-tool shell event rewrites routed commands and returns the harness allow or deny payload. Session end and model switch update stored session state. Any other event exits without writing a payload.
 *
 * @param {string} id Harness id from the hook command, for example `cursor`.
 * @param {string | undefined} eventName Event name from the hook command. The harness default is used when this is omitted.
 * @param {object} context Runtime context.
 * @param {NodeJS.WritableStream} context.stdout Stream that receives the hook payload.
 * @param {NodeJS.WritableStream} context.stderr Stream that receives error text.
 * @param {NodeJS.ReadStream} [context.stdin] Stream that carries the JSON payload. The process stdin is used when this is omitted.
 * @param {NodeJS.ProcessEnv} context.env Environment. `COSPLAYING_MODEL` is a model fallback.
 * @param {string} [context.cwd] Working directory for settings and hook files.
 * @param {string} [context.home] Home directory for settings and session files.
 * @param {NodeJS.Platform} [context.platform] Platform used to quote commands.
 * @returns {Promise<number>} Process exit code. `0` when the hook answered, including a deny. `1` when plugin loading fails outside a pre-tool event. `2` when the harness id or the JSON payload is not usable.
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
    raw = readStdin(context.stdin || process.stdin);
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
      empty: prepared.config.empty,
      model,
      link: prepared.config.link,
      variables: prepared.config.variables,
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
 * Chooses the model name for this hook payload.
 *
 * The payload fields win, then the model stored for the session, then `COSPLAYING_MODEL`, then the harness display name. The result can be a harness label. Shell rewrite leaves that label unchanged.
 *
 * @param {Record<string, unknown>} input Hook payload. `model` and `model_id` are checked first.
 * @param {import('cosplaying/adapters').Harness} harness Adapter that can read a stored session model.
 * @param {object} context Runtime context.
 * @param {NodeJS.ProcessEnv} context.env Environment. `COSPLAYING_MODEL` is used when no other name is present.
 * @returns {string} Model name used for routes and attribution. An empty string only when the harness has no label.
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
 * Builds the attribution helpers that `hook` passes to a plugin.
 *
 * The helpers close over the model and the loaded settings. Plugins call them instead of reading templates themselves. `context` is accepted so the call matches the other hook helpers. This function does not read it.
 *
 * @param {object} context Runtime context from `hook`. It is not used.
 * @param {string} model Model name for this command. An empty name makes both helpers throw when they are called.
 * @param {object} config Loaded settings.
 * @param {string} [config.markdown] Markdown byline template. `{model}` and `{link}` are replaced.
 * @param {string} [config.trailer] Single-line trailer template placed after `AI-Assisted-By:`.
 * @param {string} [config.link] Policy URL. It must be an absolute http or https URL when it is set.
 * @param {Record<string, string>} [config.variables] Extra `{name}` values for both templates.
 * @returns {{annotateMarkdown: (text: string) => string, renderTrailer: () => string}} Helpers for the plugin `run` function.
 */
export function attributionApi(context, model, config) {
  return {
    /**
     * Appends the Markdown attribution block to text.
     *
     * A previous cosplaying block at the end is replaced.
     *
     * @param {string} text Original Markdown. It can be empty.
     * @returns {string} Text with one attribution block at the end.
     * @throws {CosplayError} The model is empty, the link is not an http(s) URL, or the template contains a marker comment.
     */
    annotateMarkdown(text) {
      return annotateMarkdown(text, { model, template: config.markdown, link: config.link, variables: config.variables });
    },
    /**
     * Builds the single-line `AI-Assisted-By` trailer for a commit or merge message.
     *
     * @returns {string} One trailer line.
     * @throws {CosplayError} The model is empty, the link is not an http(s) URL, or the rendered trailer contains a line break.
     */
    renderTrailer() {
      return renderTrailer(model, { template: config.trailer, link: config.link, variables: config.variables });
    },
  };
}

export { block };
