import path from 'node:path';
import { Harness } from './harness.js';

export class Gemini extends Harness {
  id = 'gemini';

  label = 'Gemini CLI';

  binary = 'gemini';

  /**
   * @param {{home: string, projectDir?: string}} options
   * @returns {string}
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.gemini', 'settings.json');
  }

  /**
   * @returns {string[]}
   */
  events() {
    return ['SessionStart', 'BeforeTool'];
  }

  /**
   * @param {string} event
   * @param {NodeJS.Platform} [platform]
   * @param {string} [bin]
   * @returns {Record<string, unknown>}
   */
  hookEntry(event, platform, bin) {
    const group = super.hookEntry(event, platform, bin);
    if (event === 'BeforeTool') group.matcher = 'run_shell_command';
    return group;
  }

  /**
   * @returns {string}
   */
  defaultEvent() {
    return 'BeforeTool';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  isPreTool(event) {
    return event === 'BeforeTool';
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  matchesShellTool(name) {
    return name === 'run_shell_command';
  }

  /**
   * @param {string} reason
   * @returns {Record<string, unknown>}
   */
  deny(reason) {
    return { decision: 'deny', reason };
  }

  /**
   * @param {Record<string, unknown>} toolInput
   * @returns {Record<string, unknown>}
   */
  allow(toolInput) {
    return { decision: 'allow', hookSpecificOutput: { tool_input: toolInput } };
  }

  /**
   * @returns {Record<string, unknown> | null}
   */
  unchanged() {
    return { decision: 'allow' };
  }

  /**
   * @param {string} prompt
   * @returns {string}
   */
  sessionPayload(prompt) {
    return `${JSON.stringify({ hookSpecificOutput: { additionalContext: prompt } })}\n`;
  }

  /**
   * @returns {boolean}
   */
  denyUnreadable() {
    return true;
  }

  /**
   * @param {{projectDir?: string}} [options]
   * @returns {string}
   */
  installedNote({ projectDir } = {}) {
    if (!projectDir) return '';
    return 'Gemini CLI will warn before new or changed project hooks run; review the command.\n';
  }
}
