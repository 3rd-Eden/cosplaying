import { installJsonHooks, uninstallJsonHooks } from 'cosplaying/hooks';
import { cliInvocation } from 'cosplaying/cli/paths';

/**
 * Adapter for the hook file of one coding agent.
 *
 * A subclass supplies the file path, the event names, the matchers, and the JSON shapes that the agent accepts. The base class installs JSON hooks and answers the agent-hook protocol with the Claude-shaped responses.
 */
export class Harness {
  /**
   * Stable id used by `cosplaying install --harness` and by `agent-hook`.
   * @type {string}
   */
  id = '';

  /**
   * Display name shown in the session prompt and used as a fallback model name.
   * @type {string}
   */
  label = '';

  /**
   * Executable name that doctor looks up on `PATH`. A missing executable is reported and is not an install failure.
   * @type {string}
   */
  binary = '';

  /**
   * Install format. `json` edits a settings file. `extension` writes a standalone script.
   * @type {'json' | 'extension'}
   */
  kind = 'json';

  /**
   * Returns the marker that identifies hooks written for this harness.
   *
   * Install embeds the marker in the command. Later install and uninstall use it to find those entries without touching foreign hooks.
   *
   * @returns {string} Marker comment, `# cosplaying:<id>`.
   */
  marker() {
    return `# cosplaying:${this.id}`;
  }

  /**
   * Returns the settings file that install edits for this harness.
   *
   * Subclasses choose a user path or a project path. The base method has no path.
   *
   * @param {object} _options Location of the harness config.
   * @param {string} _options.home User home directory.
   * @param {NodeJS.ProcessEnv} [_options.env] Environment that some harnesses use to override the config root.
   * @param {string} [_options.projectDir] Project directory. When set, the hook file is inside the project.
   * @returns {string} Absolute settings path. The base method returns `undefined`.
   */
  file(_options) {}

  /**
   * Lists the harness events that install must register.
   *
   * Each name is a key in the settings file. The command for that event calls `agent-hook`.
   *
   * @returns {string[]} Event names in the order they are written. The base list is empty.
   */
  events() {
    return [];
  }

  /**
   * Builds the shell command that the harness runs for one event.
   *
   * The command starts this CLI, passes the harness id and the event, and ends with the ownership marker.
   *
   * @param {string} event Harness event name, for example `PreToolUse`.
   * @param {NodeJS.Platform} [platform] Platform whose quoting rules are applied to the CLI path.
   * @param {string} [bin] `cosplaying` executable to invoke. When omitted, the command uses Node and `main.js`.
   * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
   * @returns {string} One command line: the CLI invocation, `agent-hook`, the harness id, the event, and the marker.
   */
  hookCommand(event, platform, bin, entrypoint) {
    return `${cliInvocation(platform, bin, entrypoint)} agent-hook ${this.id} ${event} ${this.marker()}`;
  }

  /**
   * Builds the JSON object that install appends for one event.
   *
   * The default shape is a hook group with one command. A subclass adds a matcher when the agent requires one.
   *
   * @param {string} event Harness event name.
   * @param {NodeJS.Platform} [platform] Platform passed through to {@link Harness#hookCommand}.
   * @param {string} [bin] Executable passed through to {@link Harness#hookCommand}.
   * @param {string} [entrypoint] Wrapper script passed through to {@link Harness#hookCommand}.
   * @returns {Record<string, unknown>} Hook group `{ hooks: [{ type: 'command', command }] }`.
   */
  hookEntry(event, platform, bin, entrypoint) {
    return { hooks: [{ type: 'command', command: this.hookCommand(event, platform, bin, entrypoint) }] };
  }

  /**
   * Returns settings-file options that apply only on the first write.
   *
   * Cursor requires `version`. Other JSON harnesses add nothing.
   *
   * @returns {{version?: number}} Options for the JSON installer. An empty object when the file has no schema version.
   */
  jsonOptions() {
    return {};
  }

  /**
   * Writes this harness's hooks into its settings file.
   *
   * One command entry is added for each event from {@link Harness#events}. Owned entries are replaced. Foreign entries stay.
   *
   * @param {object} options Install location and command text.
   * @param {string} options.home User home directory.
   * @param {NodeJS.ProcessEnv} [options.env] Environment used by harnesses that override the config root.
   * @param {string} [options.projectDir] Project directory. When set, the file is the project hook file.
   * @param {NodeJS.Platform} [options.platform] Platform used to quote the hook command.
   * @param {string} [options.bin] `cosplaying` executable to embed in the hook command.
   * @param {string} [options.entrypoint] Wrapper script used in place of `main.js`.
   * @param {string[]} [options.commands] Plugin commands. JSON harnesses do not embed them. Extension harnesses do.
   * @returns {string} Path of the settings file that was updated.
   */
  install(options) {
    const file = this.file(options);
    /** @type {Record<string, unknown[]>} */
    const additions = {};
    for (const event of this.events()) {
      additions[event] = [this.hookEntry(event, options.platform, options.bin, options.entrypoint)];
    }
    installJsonHooks(file, this.marker(), additions, this.jsonOptions());
    return file;
  }

  /**
   * Removes this harness's hooks from its settings file.
   *
   * Only entries that contain the ownership marker are removed.
   *
   * @param {object} options Location of the settings file.
   * @param {string} options.home User home directory.
   * @param {NodeJS.ProcessEnv} [options.env] Environment used by harnesses that override the config root.
   * @param {string} [options.projectDir] Project directory. When set, the project hook file is edited.
   * @returns {string} Path of the settings file that was updated.
   */
  uninstall(options) {
    const file = this.file(options);
    uninstallJsonHooks(file, this.marker());
    return file;
  }

  /**
   * Returns the event name used when `agent-hook` is called without one.
   *
   * The default is the pre-tool event, because that is the event that rewrites shell commands.
   *
   * @returns {string} `PreToolUse` for the base harness.
   */
  defaultEvent() {
    return 'PreToolUse';
  }

  /**
   * Reports whether this event should receive the session prompt.
   *
   * Session start is also when a harness stores or clears the model for the session.
   *
   * @param {string} event Event name from the `agent-hook` arguments.
   * @returns {boolean} True when `event` is `SessionStart`.
   */
  isSessionStart(event) {
    return event === 'SessionStart';
  }

  /**
   * Reports whether this event is the one that can rewrite a shell command.
   *
   * Hook-order checks read the commands registered on this event. The agent hook rewrites only when this returns true.
   *
   * @param {string} event Event name from the settings file or from `agent-hook`.
   * @returns {boolean} True when `event` is `PreToolUse`.
   */
  isPreTool(event) {
    return event === 'PreToolUse';
  }

  /**
   * Reports whether the hook payload is a shell tool that cosplaying must read.
   *
   * A payload with no tool name is treated as a shell tool. A named tool is accepted only when {@link Harness#matchesShellTool} accepts that name.
   *
   * @param {Record<string, unknown>} input JSON object from the harness. `tool_name` or `toolName` selects the tool.
   * @returns {boolean} True when the tool name is absent or is a shell tool for this harness.
   */
  isShellTool(input) {
    const name = input.tool_name || input.toolName || '';
    return !name || this.matchesShellTool(name);
  }

  /**
   * Reports whether a tool name is the shell tool for this harness.
   *
   * The base adapter accepts every name. A subclass narrows that to the name its agent uses, so a non-shell tool is not rewritten.
   *
   * @param {string} _name Tool name from the hook payload.
   * @returns {boolean} True for every name in the base adapter.
   */
  matchesShellTool(_name) {
    return true;
  }

  /**
   * Reads the shell command out of a pre-tool payload.
   *
   * The command is needed before it can be rewritten. The location is returned so the rewritten text can be written back into the same field.
   *
   * @param {Record<string, unknown>} input JSON object from the harness.
   * @returns {{container: string, field: string, command: string} | null} The object key, the field name, and the command text. Null when neither `tool_input.command` nor `toolInput.command` is a string.
   */
  extractCommand(input) {
    for (const container of ['tool_input', 'toolInput']) {
      const value = input[container];
      if (value && typeof value === 'object' && typeof value.command === 'string') {
        return { container, field: 'command', command: value.command };
      }
    }
    return null;
  }

  /**
   * Builds the payload that tells the harness to refuse the tool call.
   *
   * The command is not run. The reason is shown to the agent so it can correct the input or ask the user.
   *
   * @param {string} reason Text that explains why the command was not run.
   * @returns {Record<string, unknown>} Claude-shaped deny decision with `permissionDecision` `deny` and `permissionDecisionReason`.
   */
  deny(reason) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }

  /**
   * Builds the payload that tells the harness to run the rewritten tool input.
   *
   * The updated input replaces the original command so the agent runs the attributed command.
   *
   * @param {Record<string, unknown>} toolInput Tool input object with the rewritten command already stored.
   * @returns {Record<string, unknown>} Claude-shaped allow decision with `updatedInput` set to `toolInput`.
   */
  allow(toolInput) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'cosplaying attribution',
        updatedInput: toolInput,
      },
    };
  }

  /**
   * Builds the payload for a shell command that did not need a rewrite.
   *
   * The base adapter returns null so the harness keeps its own decision. A subclass that must answer on every call returns an allow payload.
   *
   * @returns {Record<string, unknown> | null} Null. No JSON is written to stdout.
   */
  unchanged() {
    return null;
  }

  /**
   * Formats the session prompt as the bytes that `agent-hook` writes to stdout.
   *
   * The harness reads this payload and adds the text to the agent context.
   *
   * @param {string} prompt Session text from the prompt renderer.
   * @returns {string} One JSON line whose `additionalContext` is `prompt`, including the trailing newline.
   */
  sessionPayload(prompt) {
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: prompt } })}\n`;
  }

  /**
   * Reports whether a shell event with no readable command must be denied.
   *
   * Some agents fail closed. Others continue when the command field is absent. The base adapter does not deny.
   *
   * @returns {boolean} False. An unreadable command produces no deny payload.
   */
  denyUnreadable() {
    return false;
  }

  /**
   * Reports whether this event ends the agent session.
   *
   * Session end clears a stored model. The base adapter has no session-end event.
   *
   * @param {string} _event Event name from `agent-hook`.
   * @returns {boolean} False for the base adapter.
   */
  endsSession(_event) {
    return false;
  }

  /**
   * Reports whether this event means the agent changed models.
   *
   * A model switch stores the new name so later tool events attribute the current model.
   *
   * @param {string} _event Event name from `agent-hook`.
   * @returns {boolean} False for the base adapter.
   */
  switchesModel(_event) {
    return false;
  }

  /**
   * Handles the start of an agent session.
   *
   * The base method does nothing. Claude Code clears the previous model and stores the model from the payload.
   *
   * @param {Record<string, unknown>} _input Hook payload. Subclasses read `session_id` and `model`.
   * @param {object} _context Runtime context. Subclasses use `home` to locate the session file.
   * @returns {void} No value.
   */
  onSessionStart(_input, _context) {}

  /**
   * Handles the end of an agent session.
   *
   * The base method does nothing. Claude Code deletes the stored model so the next session does not reuse it.
   *
   * @param {Record<string, unknown>} _input Hook payload. Subclasses read `session_id`.
   * @param {object} _context Runtime context. Subclasses use `home` to locate the session file.
   * @returns {void} No value.
   */
  onSessionEnd(_input, _context) {}

  /**
   * Handles a model change inside an agent session.
   *
   * The base method does nothing. Claude Code stores `to_model` or `model` for the session id.
   *
   * @param {Record<string, unknown>} _input Hook payload. Subclasses read the new model and `session_id`.
   * @param {object} _context Runtime context. Subclasses use `home` to locate the session file.
   * @returns {void} No value.
   */
  onModelSwitch(_input, _context) {}

  /**
   * Reads a model name that was stored for this session.
   *
   * The agent hook uses the result when the current payload has no model. The base adapter stores nothing.
   *
   * @param {Record<string, unknown>} _input Hook payload. Subclasses read `session_id`.
   * @param {object} _context Runtime context. Subclasses use `home` to locate the session file.
   * @returns {string} Stored model name. An empty string when this harness does not store one.
   */
  modelFromSession(_input, _context) {
    return '';
  }

  /**
   * Returns host-specific instructions for finding the active model ID.
   *
   * The CLI appends this text to a session prompt when commands are available. The base adapter has no model lookup instructions.
   *
   * @returns {string} Model lookup guidance, or an empty string when this harness has no known source.
   */
  modelGuidance() {
    return '';
  }

  /**
   * Returns the note that install prints after it writes this harness.
   *
   * The note tells the operator how to approve the new hooks. An empty string means install prints nothing.
   *
   * @param {object} [_options]
   * @param {string} [_options.projectDir] Project directory, when the hooks were written for a project.
   * @returns {string} Operator note, including a trailing newline when there is text. An empty string when no note is required.
   */
  installedNote(_options) {
    return '';
  }

  /**
   * Returns the note that doctor prints after it rewrites this harness's hooks.
   *
   * Codex records approval by hook hash, so a repaired command must be trusted again.
   *
   * @returns {string} Operator note, including a trailing newline when there is text. An empty string for the base adapter.
   */
  retrustNote() {
    return '';
  }

  /**
   * Lists other harnesses whose pre-tool hooks run in the same chain, after this one.
   *
   * Hook-order repair treats that chain as one sequence. The cosplaying hook must stay last, including across those files.
   *
   * @returns {string[]} Harness ids that run later in the same agent. An empty list when this harness does not share a chain.
   */
  alsoRuns() {
    return [];
  }
}
