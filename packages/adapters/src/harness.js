import { installJsonHooks, uninstallJsonHooks } from 'cosplaying/hooks';
import { cliInvocation } from 'cosplaying/cli/paths';

/**
 * JSON hook file for one coding harness.
 * Subclasses own the path, events, matchers, and hook response shapes.
 */
export class Harness {
  /** @type {string} */
  id = '';

  /** @type {string} */
  label = '';

  /** @type {string} */
  binary = '';

  /** @type {'json' | 'extension'} */
  kind = 'json';

  /**
   * @returns {string}
   */
  marker() {
    return `# cosplaying:${this.id}`;
  }

  /**
   * @param {{home: string, env?: NodeJS.ProcessEnv, projectDir?: string}} _options
   * @returns {string}
   */
  file(_options) {}

  /**
   * @returns {string[]}
   */
  events() {
    return [];
  }

  /**
   * @param {string} event
   * @param {NodeJS.Platform} [platform]
   * @param {string} [bin]
   * @returns {string}
   */
  hookCommand(event, platform, bin) {
    return `${cliInvocation(platform, bin)} agent-hook ${this.id} ${event} ${this.marker()}`;
  }

  /**
   * @param {string} event
   * @param {NodeJS.Platform} [platform]
   * @param {string} [bin]
   * @returns {Record<string, unknown>}
   */
  hookEntry(event, platform, bin) {
    return { hooks: [{ type: 'command', command: this.hookCommand(event, platform, bin) }] };
  }

  /**
   * @returns {{version?: number}}
   */
  jsonOptions() {
    return {};
  }

  /**
   * @param {{home: string, env?: NodeJS.ProcessEnv, projectDir?: string, platform?: NodeJS.Platform, bin?: string, commands?: string[]}} options
   * @returns {string}
   */
  install(options) {
    const file = this.file(options);
    /** @type {Record<string, unknown[]>} */
    const additions = {};
    for (const event of this.events()) additions[event] = [this.hookEntry(event, options.platform, options.bin)];
    installJsonHooks(file, this.marker(), additions, this.jsonOptions());
    return file;
  }

  /**
   * @param {{home: string, env?: NodeJS.ProcessEnv, projectDir?: string}} options
   * @returns {string}
   */
  uninstall(options) {
    const file = this.file(options);
    uninstallJsonHooks(file, this.marker());
    return file;
  }

  /**
   * @returns {string}
   */
  defaultEvent() {
    return 'PreToolUse';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  isSessionStart(event) {
    return event === 'SessionStart';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  isPreTool(event) {
    return event === 'PreToolUse';
  }

  /**
   * @param {Record<string, unknown>} input
   * @returns {boolean}
   */
  isShellTool(input) {
    const name = input.tool_name || input.toolName || '';
    return !name || this.matchesShellTool(name);
  }

  /**
   * @param {string} _name
   * @returns {boolean}
   */
  matchesShellTool(_name) {
    return true;
  }

  /**
   * @param {Record<string, unknown>} input
   * @returns {{container: string, field: string, command: string} | null}
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
   * @param {string} reason
   * @returns {Record<string, unknown>}
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
   * @param {Record<string, unknown>} toolInput
   * @returns {Record<string, unknown>}
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
   * @returns {Record<string, unknown> | null}
   */
  unchanged() {
    return null;
  }

  /**
   * @param {string} prompt
   * @returns {string}
   */
  sessionPayload(prompt) {
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: prompt } })}\n`;
  }

  /**
   * @returns {boolean}
   */
  denyUnreadable() {
    return false;
  }

  /**
   * @param {string} _event
   * @returns {boolean}
   */
  endsSession(_event) {
    return false;
  }

  /**
   * @param {string} _event
   * @returns {boolean}
   */
  switchesModel(_event) {
    return false;
  }

  /**
   * @param {Record<string, unknown>} _input
   * @param {object} _context
   */
  onSessionStart(_input, _context) {}

  /**
   * @param {Record<string, unknown>} _input
   * @param {object} _context
   */
  onSessionEnd(_input, _context) {}

  /**
   * @param {Record<string, unknown>} _input
   * @param {object} _context
   */
  onModelSwitch(_input, _context) {}

  /**
   * @param {Record<string, unknown>} _input
   * @param {object} _context
   * @returns {string}
   */
  modelFromSession(_input, _context) {
    return '';
  }

  /**
   * @param {{projectDir?: string}} [_options]
   * @returns {string}
   */
  installedNote(_options) {
    return '';
  }

  /**
   * @returns {string}
   */
  retrustNote() {
    return '';
  }

  /**
   * Harness ids whose pre-tool hooks run in the same chain, after this one.
   * @returns {string[]}
   */
  alsoRuns() {
    return [];
  }
}
