import path from 'node:path';
import { Harness } from './harness.js';

/**
 * Gemini CLI adapter.
 *
 * Hooks are written to `.gemini/settings.json` in the project, or in the home directory when no project is set. Gemini warns before a new or changed project hook runs.
 */
export class Gemini extends Harness {
  id = 'gemini';

  label = 'Gemini CLI';

  binary = 'gemini';

  /**
   * Returns the Gemini CLI settings file for this scope.
   *
   * @param {object} options
   * @param {string} options.home User home directory. Used when `projectDir` is omitted.
   * @param {string} [options.projectDir] Project directory. When set, the file is `<projectDir>/.gemini/settings.json`.
   * @returns {string} Absolute path of `settings.json`.
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.gemini', 'settings.json');
  }

  /**
   * Lists the Gemini CLI events that install registers.
   *
   * SessionStart supplies the prompt. BeforeTool rewrites `run_shell_command`.
   *
   * @returns {string[]} `SessionStart` and `BeforeTool`.
   */
  events() {
    return ['SessionStart', 'BeforeTool'];
  }

  /**
   * Builds one Gemini CLI hook group.
   *
   * BeforeTool is limited to `run_shell_command` so other tools are not sent to this hook.
   *
   * @param {string} event Gemini event name.
   * @param {NodeJS.Platform} [platform] Platform used to quote the hook command.
   * @param {string} [bin] `cosplaying` executable embedded in the command.
   * @returns {Record<string, unknown>} Hook group. `BeforeTool` includes matcher `run_shell_command`.
   */
  hookEntry(event, platform, bin) {
    const group = super.hookEntry(event, platform, bin);
    if (event === 'BeforeTool') group.matcher = 'run_shell_command';
    return group;
  }

  /**
   * Returns the Gemini event used when `agent-hook` is called without one.
   *
   * @returns {string} `BeforeTool`.
   */
  defaultEvent() {
    return 'BeforeTool';
  }

  /**
   * Reports whether this Gemini event can rewrite a shell command.
   *
   * @param {string} event Event name from the settings file or from `agent-hook`.
   * @returns {boolean} True when `event` is `BeforeTool`.
   */
  isPreTool(event) {
    return event === 'BeforeTool';
  }

  /**
   * Reports whether a Gemini tool name is the shell tool.
   *
   * @param {string} name Tool name from the hook payload.
   * @returns {boolean} True when `name` is `run_shell_command`.
   */
  matchesShellTool(name) {
    return name === 'run_shell_command';
  }

  /**
   * Builds the Gemini payload that refuses the tool call.
   *
   * @param {string} reason Text that explains why the command was not run.
   * @returns {Record<string, unknown>} `{ decision: 'deny', reason }`.
   */
  deny(reason) {
    return { decision: 'deny', reason };
  }

  /**
   * Builds the Gemini payload that runs the rewritten tool input.
   *
   * @param {Record<string, unknown>} toolInput Tool input with the rewritten command already stored.
   * @returns {Record<string, unknown>} Allow decision whose `hookSpecificOutput.tool_input` is `toolInput`.
   */
  allow(toolInput) {
    return { decision: 'allow', hookSpecificOutput: { tool_input: toolInput } };
  }

  /**
   * Builds the Gemini allow payload for a command that did not change.
   *
   * Gemini still expects a decision when the hook runs.
   *
   * @returns {Record<string, unknown>} `{ decision: 'allow' }`.
   */
  unchanged() {
    return { decision: 'allow' };
  }

  /**
   * Formats the session prompt as the JSON line Gemini reads from hook stdout.
   *
   * @param {string} prompt Session text from the prompt renderer.
   * @returns {string} One JSON line whose `additionalContext` is `prompt`, including the trailing newline.
   */
  sessionPayload(prompt) {
    return `${JSON.stringify({ hookSpecificOutput: { additionalContext: prompt } })}\n`;
  }

  /**
   * Reports that Gemini must deny a shell event whose command cannot be read.
   *
   * An unreadable command cannot be checked for a wrapped plugin, so it is not run.
   *
   * @returns {boolean} True.
   */
  denyUnreadable() {
    return true;
  }

  /**
   * Returns the review note for a Gemini project install.
   *
   * Gemini warns before a new or changed project hook runs. A user-scope install has no extra note.
   *
   * @param {object} [options]
   * @param {string} [options.projectDir] Project directory. The note is returned only when this is set.
   * @returns {string} One-line note with a trailing newline for a project install. An empty string otherwise.
   */
  installedNote({ projectDir } = {}) {
    if (!projectDir) return '';
    return 'Gemini CLI will warn before new or changed project hooks run; review the command.\n';
  }
}
