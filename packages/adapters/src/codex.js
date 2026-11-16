import path from 'node:path';
import { Harness } from './harness.js';

export class Codex extends Harness {
  id = 'codex';

  label = 'Codex';

  binary = 'codex';

  /**
   * @param {{home: string, projectDir?: string}} options
   * @returns {string}
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.codex', 'hooks.json');
  }

  /**
   * @returns {string[]}
   */
  events() {
    return ['SessionStart', 'PreToolUse'];
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  matchesShellTool(name) {
    return name === 'Bash' || name === 'bash' || name === 'exec_command';
  }

  /**
   * @param {Record<string, unknown>} input
   * @returns {{container: string, field: string, command: string} | null}
   */
  extractCommand(input) {
    const toolName = input.tool_name || input.toolName || '';
    if (toolName === 'exec_command') {
      for (const container of ['tool_input', 'toolInput']) {
        const value = input[container];
        if (value && typeof value === 'object' && typeof value.cmd === 'string') {
          return { container, field: 'cmd', command: value.cmd };
        }
      }
    }
    return super.extractCommand(input);
  }

  /**
   * @returns {boolean}
   */
  denyUnreadable() {
    return true;
  }

  /**
   * @returns {string}
   */
  installedNote() {
    return 'Codex CLI: run /hooks, review cosplaying\'s PreToolUse command, then trust it.\n';
  }

  /**
   * @returns {string}
   */
  retrustNote() {
    return 'Codex CLI: run /hooks, review cosplaying\'s updated hook definitions, then trust them again.\n';
  }
}
