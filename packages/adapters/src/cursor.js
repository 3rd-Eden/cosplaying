import path from 'node:path';
import { Harness } from './harness.js';

export class Cursor extends Harness {
  id = 'cursor';

  label = 'Cursor';

  binary = 'cursor';

  /**
   * @param {{home: string, projectDir?: string}} options
   * @returns {string}
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.cursor', 'hooks.json');
  }

  /**
   * @returns {string[]}
   */
  events() {
    return ['sessionStart', 'preToolUse'];
  }

  /**
   * @param {string} event
   * @param {NodeJS.Platform} [platform]
   * @param {string} [bin]
   * @returns {Record<string, unknown>}
   */
  hookEntry(event, platform, bin) {
    const command = this.hookCommand(event, platform, bin);
    if (event === 'preToolUse') return { command, matcher: 'Shell', failClosed: true };
    return { command };
  }

  /**
   * @returns {{version?: number}}
   */
  jsonOptions() {
    return { version: 1 };
  }

  /**
   * @returns {string}
   */
  defaultEvent() {
    return 'preToolUse';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  isSessionStart(event) {
    return event === 'sessionStart';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  isPreTool(event) {
    return event === 'preToolUse';
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  matchesShellTool(name) {
    return name === 'Shell';
  }

  /**
   * @param {string} reason
   * @returns {Record<string, unknown>}
   */
  deny(reason) {
    return { permission: 'deny', agent_message: reason };
  }

  /**
   * @param {Record<string, unknown>} toolInput
   * @returns {Record<string, unknown>}
   */
  allow(toolInput) {
    return { permission: 'allow', updated_input: toolInput };
  }

  /**
   * @returns {Record<string, unknown> | null}
   */
  unchanged() {
    return { permission: 'allow' };
  }

  /**
   * @param {string} prompt
   * @returns {string}
   */
  sessionPayload(prompt) {
    return `${JSON.stringify({ additional_context: prompt })}\n`;
  }

  /**
   * @returns {boolean}
   */
  denyUnreadable() {
    return true;
  }

  /**
   * Cursor also loads Claude Code hooks.
   * @returns {string[]}
   */
  alsoRuns() {
    return ['claude-code'];
  }
}
