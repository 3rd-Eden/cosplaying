import path from 'node:path';
import { clearSessionModel, readSessionModel, saveSessionModel } from 'cosplaying/cli/state';
import { Harness } from './harness.js';

export class ClaudeCode extends Harness {
  id = 'claude-code';

  label = 'Claude Code';

  binary = 'claude';

  /**
   * @param {{home: string, projectDir?: string}} options
   * @returns {string}
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.claude', 'settings.json');
  }

  /**
   * @returns {string[]}
   */
  events() {
    return ['SessionStart', 'PostModelSwitch', 'PreToolUse', 'SessionEnd'];
  }

  /**
   * @param {string} event
   * @param {NodeJS.Platform} [platform]
   * @param {string} [bin]
   * @returns {Record<string, unknown>}
   */
  hookEntry(event, platform, bin) {
    const group = super.hookEntry(event, platform, bin);
    if (event === 'PreToolUse') group.matcher = 'Bash|PowerShell';
    return group;
  }

  /**
   * @param {string} prompt
   * @returns {string}
   */
  sessionPayload(prompt) {
    return prompt.endsWith('\n') ? prompt : `${prompt}\n`;
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  endsSession(event) {
    return event === 'SessionEnd';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  switchesModel(event) {
    return event === 'PostModelSwitch';
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {object} context
   */
  onSessionStart(input, context) {
    clearSessionModel(context, input.session_id);
    if (input.model) saveSessionModel(context, input.session_id, input.model);
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {object} context
   */
  onSessionEnd(input, context) {
    clearSessionModel(context, input.session_id);
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {object} context
   */
  onModelSwitch(input, context) {
    saveSessionModel(context, input.session_id, input.to_model || input.model);
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {object} context
   * @returns {string}
   */
  modelFromSession(input, context) {
    return readSessionModel(context, input.session_id);
  }

  /**
   * @returns {string}
   */
  installedNote() {
    return 'Claude Code runs settings hooks after workspace trust is accepted.\n';
  }
}
