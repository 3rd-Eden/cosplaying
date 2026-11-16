import path from 'node:path';
import { realMainPath } from 'cosplaying/cli/paths';
import { ExtensionHarness, executableGuardSource } from './extension.js';

export class OpenCode extends ExtensionHarness {
  id = 'opencode';

  label = 'OpenCode';

  binary = 'opencode';

  /**
   * @param {{home: string, env: NodeJS.ProcessEnv, projectDir?: string}} options
   * @returns {string}
   */
  file({ home, env, projectDir }) {
    if (projectDir) return path.join(projectDir, '.opencode', 'plugins', 'cosplaying.js');
    const root = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
    return path.join(root, 'opencode', 'plugins', 'cosplaying.js');
  }

  /**
   * @param {string[]} commands
   * @param {string} [bin]
   * @returns {string}
   */
  render(commands, bin) {
    const marker = this.marker();
    const names = [...commands].sort((left, right) => left.localeCompare(right));
    const executable = JSON.stringify(bin || process.execPath);
    const args = JSON.stringify(bin ? [] : [realMainPath()]);
    const commandList = JSON.stringify(names);
    return `${marker}
import { spawnSync } from 'node:child_process';

const EXECUTABLE = ${executable};
const ARGS = ${args};
const COMMANDS = ${commandList};

function basename(value) {
  const text = value.replaceAll('\\\\', '/');
  const name = text.slice(text.lastIndexOf('/') + 1);
  return name.replace(/\\.exe$/i, '');
}

${executableGuardSource}

function run(extra, input) {
  return spawnSync(EXECUTABLE, [...ARGS, ...extra], {
    encoding: 'utf8',
    input,
    env: process.env,
  });
}

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
