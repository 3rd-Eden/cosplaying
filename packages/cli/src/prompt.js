import { CosplayError } from 'cosplaying/errors';
import replaces from 'replaces';
import { getAdapter } from 'cosplaying/adapters';

/** @type {string} */
export const DEFAULT_SESSION = 'For authored writes with {commands}, prefix the command with {executable} hook --model <current model id> --. You are running in {harness}. When you know the model id, pass it as plain text with --model. Installed hooks pass --model-base64 for you. Write authored text in ASD-STE100 Simplified Technical English. If a command is blocked, correct the input or ask the user. Never bypass cosplaying for those commands.';

/** @type {string} */
export const EMPTY_SESSION = 'No cosplaying plugins are installed. Do not invent wrapped commands. Write authored text in ASD-STE100 Simplified Technical English.';

/**
 * @param {string} harness
 * @returns {string}
 */
export function harnessLabel(harness) {
  return getAdapter(harness)?.label || harness;
}

/**
 * @param {{harness: string, executable: string, commands: string[], template?: string}} options
 * @returns {string}
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
 * @param {string[]} files
 * @returns {string}
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
 * @param {string[]} files
 * @param {boolean} repaired
 * @returns {string}
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
