import path from 'node:path';
import { cliCommand } from 'cosplaying/cli/paths';
import { ExtensionHarness, executableGuardSource } from './extension.js';

/**
 * OpenCode adapter.
 *
 * The plugin is written to `.opencode/plugins/cosplaying.js` in the project, or under the OpenCode config directory when no project is set. The script adds the session prompt and rewrites bash and shell tool commands.
 */
export class OpenCode extends ExtensionHarness {
  id = 'opencode';

  label = 'OpenCode';

  binary = 'opencode';

  /**
   * Returns the OpenCode plugin path for this scope.
   *
   * A project directory selects `<project>/.opencode/plugins/cosplaying.js`. Otherwise an absolute `XDG_CONFIG_HOME` selects the config root, and the default root is `~/.config`.
   *
   * @param {object} options
   * @param {string} options.home User home directory.
   * @param {NodeJS.ProcessEnv} options.env Process environment. An absolute `XDG_CONFIG_HOME` overrides `~/.config`.
   * @param {string} [options.projectDir] Project directory. When set, the plugin is inside that project.
   * @returns {string} Absolute path of `cosplaying.js`.
   */
  file({ home, env, projectDir }) {
    if (projectDir) return path.join(projectDir, '.opencode', 'plugins', 'cosplaying.js');
    const root = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
    return path.join(root, 'opencode', 'plugins', 'cosplaying.js');
  }

  /**
   * Builds the standalone OpenCode plugin.
   *
   * The script does not import this package. The system-transform hook asks this CLI for the session prompt. The before-tool hook asks `rewrite` to prefix bash and shell commands. A wrapped command throws when that call fails.
   *
   * @param {string[]} commands Plugin command names the script must recognize.
   * @param {string} [bin] `cosplaying` executable the script spawns. When omitted, the script uses Node and `main.js`.
   * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
   * @returns {string} Complete plugin source, starting with the ownership comment.
   */
  render(commands, bin, entrypoint) {
    const marker = this.marker();
    const names = [...commands].sort((left, right) => left.localeCompare(right));
    const [executable, ...args] = cliCommand(bin, entrypoint);
    const commandList = JSON.stringify(names);
    return `${marker}
import { spawnSync } from 'node:child_process';

const EXECUTABLE = ${JSON.stringify(executable)};
const ARGS = ${JSON.stringify(args)};
const COMMANDS = ${commandList};

/**
 * Returns the executable name from a path.
 *
 * A trailing .exe is removed so Windows and other platforms use the same command name.
 *
 * @param {string} value Path or command word.
 * @returns {string} Final path segment without a trailing .exe.
 */
function basename(value) {
  const text = value.replaceAll('\\\\', '/');
  const name = text.slice(text.lastIndexOf('/') + 1);
  return name.replace(/\\.exe$/i, '');
}

${executableGuardSource}

/**
 * Runs this CLI and waits for it to exit.
 *
 * The plugin uses the result to read the session prompt or the rewritten command.
 *
 * @param {string[]} extra Arguments after the CLI entry, for example agent-hook or rewrite.
 * @param {string} input UTF-8 text written to the CLI stdin.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Spawn result. stdout is a string.
 */
function run(extra, input) {
  return spawnSync(EXECUTABLE, [...ARGS, ...extra], {
    encoding: 'utf8',
    input,
    env: process.env,
  });
}

/**
 * Returns the OpenCode hooks that add the session prompt and rewrite shell commands.
 *
 * experimental.chat.system.transform appends the prompt from this CLI. tool.execute.before rewrites bash and shell commands. A wrapped command throws when the rewrite cannot run.
 *
 * @returns {Promise<object>} Hook map. The system transform edits output.system. The tool hook edits output.args.command.
 */
async function plugin() {
  return {
    'experimental.chat.system.transform': async (_input, output) => {
      const result = run(['agent-hook', 'opencode', 'session-start'], '{}');
      if (result.error || result.status !== 0) return;
      const prompt = (result.stdout || '').replace(/\\n$/, '');
      if (!prompt.trim()) return;
      output.system = [output.system, prompt].filter(Boolean).join('\\n\\n');
    },
    'tool.execute.before': async (input, output) => {
      const name = input?.tool || '';
      if (name.toLowerCase() !== 'bash' && name.toLowerCase() !== 'shell') return;
      const command = output?.args?.command;
      if (typeof command !== 'string' || !command.trim()) return;
      const model = process.env.COSPLAYING_MODEL || 'OpenCode';
      let result;
      try {
        result = run(['rewrite', '--model', model, '--shell', command]);
      } catch (error) {
        if (mentionsWrappedCommand(command)) {
          throw new Error('cosplaying could not rewrite this command. Run it through cosplaying hook with the current model.');
        }
        return;
      }
      if (!result || result.error || result.status !== 0 || result.stdout == null) {
        if (mentionsWrappedCommand(command)) {
          throw new Error('cosplaying could not rewrite this command. Run it through cosplaying hook with the current model.');
        }
        return;
      }
      const updated = result.stdout.replace(/\\n$/, '');
      if (updated && updated !== command) output.args.command = updated;
    },
  };
}

export default plugin;
export { plugin as Plugin };
`;
  }
}
