import path from 'node:path';
import { Harness } from './harness.js';

/**
 * Codex adapter.
 *
 * Hooks are written to `.codex/hooks.json` in the project, or in the home directory when no project is set. Codex must trust the hook command in `/hooks` before it will run.
 */
export class Codex extends Harness {
  id = 'codex';

  label = 'Codex';

  binary = 'codex';

  /**
   * Returns the Codex hooks file for this scope.
   *
   * @param {object} options
   * @param {string} options.home User home directory. Used when `projectDir` is omitted.
   * @param {string} [options.projectDir] Project directory. When set, the file is `<projectDir>/.codex/hooks.json`.
   * @returns {string} Absolute path of `hooks.json`.
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.codex', 'hooks.json');
  }

  /**
   * Lists the Codex events that install registers.
   *
   * SessionStart supplies the prompt. PreToolUse rewrites shell commands.
   *
   * @returns {string[]} `SessionStart` and `PreToolUse`.
   */
  events() {
    return ['SessionStart', 'PreToolUse'];
  }

  /**
   * Reports whether a Codex tool name carries a shell command.
   *
   * `exec_command` uses `cmd` instead of `command`. The other names use the base command field.
   *
   * @param {string} name Tool name from the hook payload.
   * @returns {boolean} True for `Bash`, `bash`, and `exec_command`.
   */
  matchesShellTool(name) {
    return name === 'Bash' || name === 'bash' || name === 'exec_command';
  }

  /**
   * Reads the shell command from a Codex pre-tool payload.
   *
   * `exec_command` stores the text in `cmd`. Other shell tools use the base `command` field.
   *
   * @param {Record<string, unknown>} input JSON object from Codex.
   * @returns {{container: string, field: string, command: string} | null} The object key, the field name, and the command text. Null when the command field is not a string.
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
   * Reports that Codex must deny a shell event whose command cannot be read.
   *
   * An unreadable command cannot be checked for a wrapped plugin, so it is not run.
   *
   * @returns {boolean} True.
   */
  denyUnreadable() {
    return true;
  }

  /**
   * Returns instructions for finding Codex's current model ID.
   *
   * Codex stores model IDs in the current session JSONL file under its session directory.
   *
   * @returns {string} Model lookup instructions for the session prompt.
   */
  modelGuidance() {
    return `${super.modelGuidance()} For Codex, check this session's JSONL file under \`~/.codex/sessions\`. Read \`payload.state.model.model\` or \`payload.thread_settings.model\`.`;
  }

  /**
   * Returns the note that tells the operator to trust the new Codex hooks.
   *
   * Codex does not run a hook until `/hooks` records approval for that command.
   *
   * @returns {string} One-line note with a trailing newline.
   */
  installedNote() {
    return 'Codex CLI: run /hooks, review cosplaying\'s PreToolUse command, then trust it.\n';
  }

  /**
   * Returns the note that tells the operator to trust Codex hooks again after a repair.
   *
   * Codex stores approval against the hook hash. A rewritten command is a new hash.
   *
   * @returns {string} One-line note with a trailing newline.
   */
  retrustNote() {
    return 'Codex CLI: run /hooks, review cosplaying\'s updated hook definitions, then trust them again.\n';
  }
}
