import path from 'node:path';
import { cliCommand } from 'cosplaying/cli/paths';
import { ExtensionHarness, executableGuardSource } from './extension.js';

/**
 * Pi adapter.
 *
 * The extension is written to `.pi/extensions/cosplaying.js` in the project, or under the Pi agent directory when no project is set. The script adds the session prompt and rewrites the bash tool.
 */
export class Pi extends ExtensionHarness {
  id = 'pi';

  label = 'Pi';

  binary = 'pi';

  /**
   * Returns the Pi extension path for this scope.
   *
   * A project directory selects `<project>/.pi/extensions/cosplaying.js`. Otherwise `PI_CODING_AGENT_DIR` selects the agent root, and the default root is `~/.pi/agent`.
   *
   * @param {object} options
   * @param {string} options.home User home directory.
   * @param {NodeJS.ProcessEnv} options.env Process environment. `PI_CODING_AGENT_DIR` overrides the user agent directory.
   * @param {string} [options.projectDir] Project directory. When set, the extension is inside that project.
   * @returns {string} Absolute path of `cosplaying.js`.
   */
  file({ home, env, projectDir }) {
    if (projectDir) return path.join(projectDir, '.pi', 'extensions', 'cosplaying.js');
    const root = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
    return path.join(root, 'extensions', 'cosplaying.js');
  }

  /**
   * Builds the standalone Pi extension.
   *
   * The script does not import this package. On `before_agent_start` it asks this CLI for the session prompt. On a bash tool call it asks `rewrite` to prefix wrapped commands. A wrapped command is blocked when that call fails.
   *
   * @param {string[]} commands Plugin command names the script must recognize.
   * @param {string} [bin] `cosplaying` executable the script spawns. When omitted, the script uses Node and `main.js`.
   * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
   * @returns {string} Complete extension source, starting with the ownership comment.
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
 * The extension uses the result to read the session prompt or the rewritten command.
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
 * Registers the Pi hooks that add the session prompt and rewrite bash commands.
 *
 * before_agent_start appends the prompt from this CLI. tool_call rewrites a bash command. A wrapped command is blocked when the rewrite cannot run.
 *
 * @param {object} pi Pi extension API.
 * @param {function(string, function): void} pi.on Registers an event handler.
 * @returns {void} No value. The handlers are registered on pi.
 */
export default function cosplaying(pi) {
  pi.on('before_agent_start', (event) => {
    const result = run(['agent-hook', 'pi', 'session-start'], '{}');
    if (result.error || result.status !== 0) return;
    const prompt = (result.stdout || '').replace(/\\n$/, '');
    if (!prompt.trim()) return;
    return { systemPrompt: event.systemPrompt + '\\n\\n' + prompt };
  });

  pi.on('tool_call', (event, ctx) => {
    if (event?.toolName !== 'bash') return;
    const command = event?.input?.command;
    if (typeof command !== 'string' || !command.trim()) return;
    const model = (ctx && ctx.model && ctx.model.id)
      || process.env.COSPLAYING_MODEL
      || 'Pi';
    let result;
    try {
      result = run(['rewrite', '--model', model, '--shell', command]);
    } catch {
      if (mentionsWrappedCommand(command)) {
        return { block: true, reason: 'cosplaying could not rewrite this command. Run it through cosplaying hook with the current model.' };
      }
      return;
    }
    if (!result || result.error || result.status !== 0 || result.stdout == null) {
      if (mentionsWrappedCommand(command)) {
        return { block: true, reason: 'cosplaying could not rewrite this command. Run it through cosplaying hook with the current model.' };
      }
      return;
    }
    const updated = result.stdout.replace(/\\n$/, '');
    if (updated && updated !== command) event.input.command = updated;
  });
}
`;
  }
}
