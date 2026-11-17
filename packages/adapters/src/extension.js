import { installHookFile, uninstallHookFile } from 'cosplaying/hooks';
import { Harness } from './harness.js';

/**
 * Source of the command check that Pi and OpenCode extensions copy.
 *
 * The generated file does not import this package. The check reports whether a shell command is one that cosplaying must rewrite, so a failed rewrite can block that command.
 *
 * @type {string}
 */
export const executableGuardSource = `/**
 * Reports whether a shell command is a plugin command or this CLI.
 *
 * Wrappers such as env, sudo, and rtk are skipped. The check looks at the first real executable so a failed rewrite can block only a command that needs attribution.
 *
 * @param {string} command Shell command from the harness tool call.
 * @returns {boolean} True when the executable is a wrapped plugin command, cosplaying, or node running this CLI.
 */
function mentionsWrappedCommand(command) {
  const tokens = String(command || '').trim().split(/\\s+/).filter(Boolean);
  const wrappers = new Set(['env', 'command', 'builtin', 'exec', 'sudo', 'nohup', 'time', 'xargs', 'rtk', 'proxy']);
  const flagArgs = {
    sudo: { short: 'ughpUCDRT', long: ['user', 'group', 'host', 'prompt', 'other-user', 'close-from', 'chdir', 'role', 'command-timeout'] },
    env: { short: 'uCSa', long: ['unset', 'chdir', 'split-string', 'argv0'] },
    xargs: { short: 'aEeiILlnPsdJ', long: ['arg-file', 'eof', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'delimiter'] },
    time: { short: 'fo', long: ['format', 'output'] },
    exec: { short: 'a', long: [] },
  };
  let index = 0;
  let wrapper = '';
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token === '--') {
      index += 1;
      break;
    }
    if (token.startsWith('-')) {
      const spec = flagArgs[wrapper];
      const takes = Boolean(spec) && !token.includes('=') && token !== '-' && (
        token.startsWith('--')
          ? spec.long.includes(token.slice(2))
          : token.length === 2 && spec.short.includes(token[1])
      );
      index += takes ? 2 : 1;
      continue;
    }
    const name = basename(token);
    if (wrappers.has(name)) {
      wrapper = name;
      index += 1;
      continue;
    }
    return wrappedBasename(name, tokens[index + 1] || '');
  }
  return wrappedBasename(basename(tokens[index] || ''), tokens[index + 1] || '');
}

/**
 * Reports whether an executable name is a command that cosplaying wraps.
 *
 * Node is included only when the next token is this CLI's script.
 *
 * @param {string} name Executable basename with a trailing .exe removed.
 * @param {string} next Following token. Used when name is node.
 * @returns {boolean} True for a plugin command, cosplaying, or node running main.js or cosplaying.js.
 */
function wrappedBasename(name, next) {
  if (COMMANDS.includes(name) || name === 'cosplaying' || name === 'cosplaying.js') return true;
  if (name === 'node') {
    const script = basename(next);
    if (script === 'main.js' || script === 'cosplaying.js') return true;
  }
  return false;
}`;

/**
 * Adapter that installs a standalone JavaScript extension into Pi or OpenCode.
 *
 * The generated file does not import this package. It calls the CLI with `spawnSync` and blocks a wrapped command when that call fails.
 */
export class ExtensionHarness extends Harness {
  /**
   * Install format. Extension harnesses write a script instead of a JSON settings file.
   * @type {'json' | 'extension'}
   */
  kind = 'extension';

  /**
   * Returns the comment that marks a generated extension as owned by this install.
   *
   * Install refuses to replace a file that does not contain this comment.
   *
   * @returns {string} Line comment `// cosplaying:<id>`.
   */
  marker() {
    return `// cosplaying:${this.id}`;
  }

  /**
   * Lists JSON hook events for this harness.
   *
   * Extension harnesses do not register JSON events. Their script listens inside the agent.
   *
   * @returns {string[]} An empty list.
   */
  events() {
    return [];
  }

  /**
   * Writes the generated extension when the destination is missing or already owned.
   *
   * An unmarked file that differs from the generated source is left in place.
   *
   * @param {object} options Install location and the commands the extension must recognize.
   * @param {string} options.home User home directory.
   * @param {NodeJS.ProcessEnv} [options.env] Environment used to find the harness config root.
   * @param {string} [options.projectDir] Project directory. When set, the extension is written inside the project.
   * @param {string[]} [options.commands] Plugin command names embedded in the extension.
   * @param {string} [options.bin] `cosplaying` executable embedded in the extension. When omitted, the script uses Node and `main.js`.
   * @returns {string} Path of the extension file.
   * @throws {CosplayError} The destination exists, has no ownership marker, and is not already the generated source.
   */
  install(options) {
    const file = this.file(options);
    installHookFile(file, this.marker(), this.render(options.commands || [], options.bin));
    return file;
  }

  /**
   * Deletes the generated extension when it contains the ownership marker.
   *
   * An unmarked file is not deleted.
   *
   * @param {object} options Location of the extension.
   * @param {string} options.home User home directory.
   * @param {NodeJS.ProcessEnv} [options.env] Environment used to find the harness config root.
   * @param {string} [options.projectDir] Project directory. When set, the project extension is the target.
   * @returns {string} Path that was considered. The file is removed only when it contains the marker.
   */
  uninstall(options) {
    const file = this.file(options);
    uninstallHookFile(file, this.marker());
    return file;
  }

  /**
   * Builds the full extension source for this harness.
   *
   * Subclasses return a script that asks this CLI for the session prompt and rewrites bash commands. The base method has no script.
   *
   * @param {string[]} _commands Plugin command names the script must treat as wrapped commands.
   * @param {string} [_bin] `cosplaying` executable the script should spawn. When omitted, the script uses Node and `main.js`.
   * @returns {string} Extension source. The base method returns `undefined`.
   */
  render(_commands, _bin) {}

  /**
   * Returns the event name used when `agent-hook` is called for this harness without one.
   *
   * Pi and OpenCode ask for the session prompt through the `session-start` event.
   *
   * @returns {string} `session-start`.
   */
  defaultEvent() {
    return 'session-start';
  }

  /**
   * Reports whether this event should receive the session prompt.
   *
   * Both the extension event name and the JSON event name are accepted so one hook path can serve either spelling.
   *
   * @param {string} event Event name from `agent-hook`.
   * @returns {boolean} True for `session-start` and `SessionStart`.
   */
  isSessionStart(event) {
    return event === 'session-start' || event === 'SessionStart';
  }

  /**
   * Reports whether the agent-hook process should rewrite a shell command.
   *
   * Pi and OpenCode rewrite inside the extension. The `agent-hook` process only supplies the session prompt.
   *
   * @returns {boolean} False.
   */
  isPreTool() {
    return false;
  }

  /**
   * Returns the session prompt as plain text for the extension to append.
   *
   * The extension reads stdout and adds that text to the system prompt. A trailing newline is added when the prompt does not already end with one.
   *
   * @param {string} prompt Session text from the prompt renderer.
   * @returns {string} `prompt` with a trailing newline.
   */
  sessionPayload(prompt) {
    return prompt.endsWith('\n') ? prompt : `${prompt}\n`;
  }
}
