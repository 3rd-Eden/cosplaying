import path from 'node:path';
import { Harness } from './harness.js';

/**
 * Cursor adapter.
 *
 * Hooks are written to `.cursor/hooks.json` in the project, or in the home directory when no project is set. Cursor also loads Claude Code hooks, so those two files are one hook chain.
 */
export class Cursor extends Harness {
  id = 'cursor';

  label = 'Cursor';

  binary = 'cursor';

  /**
   * Returns the Cursor hooks file for this scope.
   *
   * @param {object} options
   * @param {string} options.home User home directory. Used when `projectDir` is omitted.
   * @param {string} [options.projectDir] Project directory. When set, the file is `<projectDir>/.cursor/hooks.json`.
   * @returns {string} Absolute path of `hooks.json`.
   */
  file({ home, projectDir }) {
    return path.join(projectDir || home, '.cursor', 'hooks.json');
  }

  /**
   * Lists the Cursor events that install registers.
   *
   * `sessionStart` supplies the prompt. `preToolUse` rewrites Shell commands.
   *
   * @returns {string[]} `sessionStart` and `preToolUse`.
   */
  events() {
    return ['sessionStart', 'preToolUse'];
  }

  /**
   * Builds one Cursor hook entry.
   *
   * Cursor uses a flat command object. `preToolUse` matches Shell and fails closed when the hook cannot answer.
   *
   * @param {string} event Cursor event name.
   * @param {NodeJS.Platform} [platform] Platform used to quote the hook command.
   * @param {string} [bin] `cosplaying` executable embedded in the command.
   * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
   * @returns {Record<string, unknown>} `{ command }` for session start. `{ command, matcher, failClosed }` for `preToolUse`.
   */
  hookEntry(event, platform, bin, entrypoint) {
    const command = this.hookCommand(event, platform, bin, entrypoint);
    if (event === 'preToolUse') return { command, matcher: 'Shell', failClosed: true };
    return { command };
  }

  /**
   * Returns the schema version Cursor requires in a new hooks file.
   *
   * The version is written only when the file does not already have one.
   *
   * @returns {{version: number}} `{ version: 1 }`.
   */
  jsonOptions() {
    return { version: 1 };
  }

  /**
   * Returns instructions for finding Cursor's current model ID.
   *
   * Cursor hook data can report `model_id` or the legacy `model` field and provides `transcript_path` for the current session transcript.
   *
   * @returns {string} Model lookup instructions for the session prompt.
   */
  modelGuidance() {
    return "For Cursor, check the current session's `model_id` field or the legacy `model` field. Use `transcript_path` to locate its JSONL transcript. " + super.modelGuidance();
  }

  /**
   * Returns the Cursor event used when `agent-hook` is called without one.
   *
   * @returns {string} `preToolUse`.
   */
  defaultEvent() {
    return 'preToolUse';
  }

  /**
   * Reports whether this Cursor event should receive the session prompt.
   *
   * @param {string} event Event name from `agent-hook`.
   * @returns {boolean} True when `event` is `sessionStart`.
   */
  isSessionStart(event) {
    return event === 'sessionStart';
  }

  /**
   * Reports whether this Cursor event can rewrite a shell command.
   *
   * @param {string} event Event name from the hooks file or from `agent-hook`.
   * @returns {boolean} True when `event` is `preToolUse`.
   */
  isPreTool(event) {
    return event === 'preToolUse';
  }

  /**
   * Reports whether a Cursor tool name is the shell tool.
   *
   * @param {string} name Tool name from the hook payload.
   * @returns {boolean} True when `name` is `Shell`.
   */
  matchesShellTool(name) {
    return name === 'Shell';
  }

  /**
   * Builds the Cursor payload that refuses the tool call.
   *
   * @param {string} reason Text shown to the agent. It explains why the command was not run.
   * @returns {Record<string, unknown>} `{ permission: 'deny', agent_message: reason }`.
   */
  deny(reason) {
    return { permission: 'deny', agent_message: reason };
  }

  /**
   * Builds the Cursor payload that runs the rewritten tool input.
   *
   * @param {Record<string, unknown>} toolInput Tool input with the rewritten command already stored.
   * @returns {Record<string, unknown>} `{ permission: 'allow', updated_input: toolInput }`.
   */
  allow(toolInput) {
    return { permission: 'allow', updated_input: toolInput };
  }

  /**
   * Builds the Cursor allow payload for a command that did not change.
   *
   * Cursor still expects a permission decision when the hook runs.
   *
   * @returns {Record<string, unknown>} `{ permission: 'allow' }`.
   */
  unchanged() {
    return { permission: 'allow' };
  }

  /**
   * Formats the session prompt as the JSON line Cursor reads from hook stdout.
   *
   * @param {string} prompt Session text from the prompt renderer.
   * @returns {string} One JSON line whose `additional_context` is `prompt`, including the trailing newline.
   */
  sessionPayload(prompt) {
    return `${JSON.stringify({ additional_context: prompt })}\n`;
  }

  /**
   * Reports that Cursor must deny a shell event whose command cannot be read.
   *
   * The hook is fail-closed. An unreadable command is not run.
   *
   * @returns {boolean} True.
   */
  denyUnreadable() {
    return true;
  }

  /**
   * Lists the other harness whose pre-tool hooks run in the same Cursor chain.
   *
   * Cursor loads Claude Code hooks as well. Order repair treats both files as one sequence so the cosplaying command stays last.
   *
   * @returns {string[]} `['claude-code']`.
   */
  alsoRuns() {
    return ['claude-code'];
  }
}
