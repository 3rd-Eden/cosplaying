import path from 'node:path';
import { clearSessionModel, readSessionModel, saveSessionModel } from 'cosplaying/cli/state';
import { Harness } from './harness.js';

/**
 * Claude Code adapter.
 *
 * Hooks are written to `.claude/settings.json` in the project, or in the home directory when no project is set. The session model is stored from SessionStart until SessionEnd so a later tool event can name the model.
 */
export class ClaudeCode extends Harness {
  id = 'claude-code';

  label = 'Claude Code';

  binary = 'claude';

  /**
   * Returns the Claude Code settings file for this scope.
   *
   * A project directory selects the repository settings. Otherwise the file is under the user home.
   *
   * @param {object} options
   * @param {string} options.home User home directory. Used when `projectDir` is omitted.
   * @param {string} [options.projectDir] Project directory. When set, the settings file is `<projectDir>/.claude/settings.json`.
   * @returns {string} Absolute path of `settings.json`.
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.claude', 'settings.json');
  }

  /**
   * Lists the Claude Code events that install registers.
   *
   * Session start and end maintain the stored model. PostModelSwitch updates it. PreToolUse rewrites Bash and PowerShell commands.
   *
   * @returns {string[]} `SessionStart`, `PostModelSwitch`, `PreToolUse`, and `SessionEnd`.
   */
  events() {
    return ['SessionStart', 'PostModelSwitch', 'PreToolUse', 'SessionEnd'];
  }

  /**
   * Builds one Claude Code hook group.
   *
   * PreToolUse is limited to Bash and PowerShell so other tools are not sent to this hook.
   *
   * @param {string} event Claude Code event name.
   * @param {NodeJS.Platform} [platform] Platform used to quote the hook command.
   * @param {string} [bin] `cosplaying` executable embedded in the command.
   * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
   * @returns {Record<string, unknown>} Hook group. `PreToolUse` includes matcher `Bash|PowerShell`.
   */
  hookEntry(event, platform, bin, entrypoint) {
    const group = super.hookEntry(event, platform, bin, entrypoint);
    if (event === 'PreToolUse') group.matcher = 'Bash|PowerShell';
    return group;
  }

  /**
   * Returns the session prompt as plain text.
   *
   * Claude Code reads the hook stdout as additional context. The text ends with a newline.
   *
   * @param {string} prompt Session text from the prompt renderer.
   * @returns {string} `prompt` with a trailing newline.
   */
  sessionPayload(prompt) {
    return prompt.endsWith('\n') ? prompt : `${prompt}\n`;
  }

  /**
   * Reports whether this event ends the Claude Code session.
   *
   * Session end deletes the stored model.
   *
   * @param {string} event Event name from `agent-hook`.
   * @returns {boolean} True when `event` is `SessionEnd`.
   */
  endsSession(event) {
    return event === 'SessionEnd';
  }

  /**
   * Reports whether this event is a Claude Code model change.
   *
   * The new model is stored for the session id so the next tool event uses it.
   *
   * @param {string} event Event name from `agent-hook`.
   * @returns {boolean} True when `event` is `PostModelSwitch`.
   */
  switchesModel(event) {
    return event === 'PostModelSwitch';
  }

  /**
   * Clears the previous session model and stores the model from this session start.
   *
   * A payload without `model` only clears the old file. Later events then fall back to the environment or the harness label.
   *
   * @param {Record<string, unknown>} input Claude Code session payload. `session_id` names the file. `model` is stored when it is present.
   * @param {object} context Runtime context. `home` selects the user config directory.
   * @returns {void} No value.
   */
  onSessionStart(input, context) {
    clearSessionModel(context, input.session_id);
    if (input.model) saveSessionModel(context, input.session_id, input.model);
  }

  /**
   * Deletes the model stored for this Claude Code session.
   *
   * The next session must not reuse it.
   *
   * @param {Record<string, unknown>} input Claude Code session payload. `session_id` names the file to delete.
   * @param {object} context Runtime context. `home` selects the user config directory.
   * @returns {void} No value.
   */
  onSessionEnd(input, context) {
    clearSessionModel(context, input.session_id);
  }

  /**
   * Stores the model that Claude Code switched to.
   *
   * `to_model` is preferred. `model` is used when `to_model` is absent.
   *
   * @param {Record<string, unknown>} input Model-switch payload. `session_id` names the file. `to_model` or `model` is the new name.
   * @param {object} context Runtime context. `home` selects the user config directory.
   * @returns {void} No value. An empty model does not write a file.
   */
  onModelSwitch(input, context) {
    saveSessionModel(context, input.session_id, input.to_model || input.model);
  }

  /**
   * Reads the model stored for this Claude Code session.
   *
   * The agent hook uses it when the tool payload does not include a model.
   *
   * @param {Record<string, unknown>} input Hook payload. `session_id` selects the file.
   * @param {object} context Runtime context. `home` selects the user config directory.
   * @returns {string} Stored model name. An empty string when no file exists for that session.
   */
  modelFromSession(input, context) {
    return readSessionModel(context, input.session_id);
  }

  /**
   * Returns the approval note printed after Claude Code hooks are installed.
   *
   * Claude Code does not run settings hooks until workspace trust is accepted.
   *
   * @returns {string} One-line note with a trailing newline.
   */
  installedNote() {
    return 'Claude Code runs settings hooks after workspace trust is accepted.\n';
  }
}
