import { installHookFile, uninstallHookFile } from 'cosplaying/hooks';
import { Harness } from './harness.js';

/**
 * Standalone executable check copied into Pi and OpenCode.
 * The generated file does not import this package.
 * @type {string}
 */
export const executableGuardSource = `function mentionsWrappedCommand(command) {
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

function wrappedBasename(name, next) {
  if (COMMANDS.includes(name) || name === 'cosplaying' || name === 'cosplaying.js') return true;
  if (name === 'node') {
    const script = basename(next);
    if (script === 'main.js' || script === 'cosplaying.js') return true;
  }
  return false;
}`;

/**
 * Generated JavaScript file installed into Pi or OpenCode.
 * The file is standalone and does not import this package.
 */
export class ExtensionHarness extends Harness {
  /** @type {'json' | 'extension'} */
  kind = 'extension';

  /**
   * @returns {string}
   */
  marker() {
    return `// cosplaying:${this.id}`;
  }

  /**
   * @returns {string[]}
   */
  events() {
    return [];
  }

  /**
   * @param {{home: string, env?: NodeJS.ProcessEnv, projectDir?: string, commands?: string[], bin?: string}} options
   * @returns {string}
   */
  install(options) {
    const file = this.file(options);
    installHookFile(file, this.marker(), this.render(options.commands || [], options.bin));
    return file;
  }

  /**
   * @param {{home: string, env?: NodeJS.ProcessEnv, projectDir?: string}} options
   * @returns {string}
   */
  uninstall(options) {
    const file = this.file(options);
    uninstallHookFile(file, this.marker());
    return file;
  }

  /**
   * @param {string[]} _commands
   * @param {string} [_bin]
   * @returns {string}
   */
  render(_commands, _bin) {}

  /**
   * @returns {string}
   */
  defaultEvent() {
    return 'session-start';
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  isSessionStart(event) {
    return event === 'session-start' || event === 'SessionStart';
  }

  /**
   * @returns {boolean}
   */
  isPreTool() {
    return false;
  }

  /**
   * @param {string} prompt
   * @returns {string}
   */
  sessionPayload(prompt) {
    return prompt.endsWith('\n') ? prompt : `${prompt}\n`;
  }
}
