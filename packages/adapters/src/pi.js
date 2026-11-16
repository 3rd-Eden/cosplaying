import path from 'node:path';
import { realMainPath } from 'cosplaying/cli/paths';
import { ExtensionHarness, executableGuardSource } from './extension.js';

export class Pi extends ExtensionHarness {
  id = 'pi';

  label = 'Pi';

  binary = 'pi';

  /**
   * @param {{home: string, env: NodeJS.ProcessEnv, projectDir?: string}} options
   * @returns {string}
   */
  file({ home, env, projectDir }) {
    if (projectDir) return path.join(projectDir, '.pi', 'extensions', 'cosplaying.js');
    const root = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
    return path.join(root, 'extensions', 'cosplaying.js');
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
