import { CosplayError } from 'cosplaying/errors';
import replaces from 'replaces';
import { getAdapter } from 'cosplaying/adapters';

/** @type {string} */
export const DEFAULT_SESSION = 'For authored writes with {commands}, prefix the command with {executable} hook --model <current model id> --. You are running in {harness}. When you know the model id, pass it as plain text with --model. Installed hooks pass --model-base64 for you. Write authored text in ASD-STE100 Simplified Technical English. If a command is blocked, correct the input or ask the user. Never bypass cosplaying for those commands.';

/** @type {string} */
export const EMPTY_SESSION = 'No cosplaying plugins are installed. Do not invent wrapped commands. Write authored text in ASD-STE100 Simplified Technical English.';

/**
 * Returns the display name of a harness.
 *
 * The session prompt uses this name so the agent sees the product name, for example Claude Code, instead of the harness id.
 *
 * @param {string} harness Harness id, for example `claude-code`.
 * @returns {string} Adapter label for that id. The same id when no adapter is registered.
 */
export function harnessLabel(harness) {
  return getAdapter(harness)?.label || harness;
}

/**
 * Builds the text that a harness shows when a session starts.
 *
 * The text tells the agent to prefix authored writes with this CLI. An empty command list uses the text that tells the agent not to invent wrapped commands.
 *
 * @param {object} options
 * @param {string} options.harness Harness id. The text shows the display name for this id.
 * @param {string} options.executable Quoted invocation of this CLI. The text tells the agent to put this command before a wrapped write.
 * @param {string[]} options.commands Plugin command names that shell rewrite wraps. The names are sorted before they are inserted.
 * @param {string} [options.template] Session template from settings. `{harness}`, `{executable}`, and `{commands}` are replaced. The built-in template is used when this is omitted.
 * @returns {string} Prompt text for the session-start hook.
 */
export function renderSession({ harness, executable, commands, template }) {
  const names = [...commands].sort((left, right) => left.localeCompare(right));
  if (names.length === 0) return EMPTY_SESSION;
  const source = template || DEFAULT_SESSION;
  const values = {
    executable,
    harness: harnessLabel(harness),
    commands: names.join(', '),
  };
  return replaces(source, /\{()([^{}]+)\}/g, values);
}

/**
 * Builds the session text for hook files whose order could not be checked.
 *
 * A later hook can remove the cosplaying prefix. The agent must see that wrapped commands stay denied until the order can be checked.
 *
 * @param {string[]} files Hook file paths from the failed order check. Empty strings and repeated paths are omitted.
 * @returns {string} Text that names those files and tells the operator to run `cosplaying doctor --repair`.
 */
export function orderWarning(files) {
  const list = [...new Set(files.filter(Boolean))];
  const where = list.length ? ` in ${list.join(', ')}` : '';
  return new CosplayError({
    name: 'cli',
    method: 'repairHookOrder',
    message: 'Hook order could not be verified%s. Inspect those hook files and run cosplaying doctor --repair. Wrapped commands stay denied until the order can be checked.',
    args: [where],
  }).message;
}

/**
 * Builds the deny reason for a wrapped command that was not run because the hook order was unsafe.
 *
 * @param {string[]} files Hook files that were repaired, or that still fail the order check. Empty strings and repeated paths are omitted.
 * @param {boolean} repaired True when every problem was repaired and the command can be retried. False when the order still cannot be verified.
 * @returns {string} Deny text for the harness. It tells the agent to retry the command through cosplaying.
 */
export function retryReason(files, repaired) {
  const list = [...new Set(files.filter(Boolean))];
  const where = list.length ? ` in ${list.join(', ')}` : '';
  const detail = repaired ? `was repaired${where}` : `could not be verified${where}`;
  return new CosplayError({
    name: 'cli',
    method: 'repairHookOrder',
    message: 'Hook order %s. This command was not run. Retry the command through cosplaying. If the hook file changed, trust Codex hooks again with /hooks.',
    args: [detail],
  }).message;
}
