import { ClaudeCode } from './claude-code.js';
import { Codex } from './codex.js';
import { Cursor } from './cursor.js';
import { Gemini } from './gemini.js';
import { OpenCode } from './opencode.js';
import { Pi } from './pi.js';

export { Harness } from './harness.js';
export { ExtensionHarness } from './extension.js';
export { ClaudeCode, Codex, Cursor, Gemini, OpenCode, Pi };

/** @type {import('./harness.js').Harness[]} */
export const adapters = [
  new ClaudeCode(),
  new Codex(),
  new Cursor(),
  new Gemini(),
  new OpenCode(),
  new Pi(),
];

/**
 * @param {string} id
 * @returns {import('./harness.js').Harness | undefined}
 */
export function getAdapter(id) {
  return adapters.find((item) => item.id === id);
}
