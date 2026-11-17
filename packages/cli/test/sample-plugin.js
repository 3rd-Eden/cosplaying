import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));

const source = [
  "import { block } from 'cosplaying/plugin';",
  '',
  "export const description = 'Append a byline to byline --message';",
  '',
  'export const examples = [\'cosplaying hook --model "Example" -- byline --message "text"\'];',
  '',
  'export default async function run(args, context) {',
  "  const index = args.indexOf('--message');",
  '  const text = index >= 0 ? args[index + 1] : undefined;',
  '  if (text === undefined) {',
  '    const result = await context.spawn(context.realBin, args, {',
  '      cwd: context.cwd,',
  '      env: context.env,',
  "      stdio: 'inherit',",
  '    });',
  '    return result?.status ?? 1;',
  '  }',
  '  if (!context.model) {',
  "    block(context.stderr, 'byline --message writes text and needs a model. Pass --model <name> or set COSPLAYING_MODEL.');",
  '    return 2;',
  '  }',
  '  let trailer;',
  '  try {',
  '    trailer = context.attribution.renderTrailer();',
  '  } catch (error) {',
  '    block(context.stderr, error.message);',
  '    return 2;',
  '  }',
  '  const next = args.slice();',
  "  next[index + 1] = `${text}\\n${trailer}`;",
  '  const result = await context.spawn(context.realBin, next, {',
  '    cwd: context.cwd,',
  '    env: context.env,',
  "    stdio: 'inherit',",
  '  });',
  '  return result?.status ?? 1;',
  '}',
  '',
].join('\n');

/**
 * Writes the byline sample plugin into a directory and links this repo as `cosplaying`.
 *
 * Tests install or configure this directory. The command name is `byline`. The link lets the plugin import this package during development.
 *
 * @param {string} directory Directory that will contain `package.json` and `index.js`. It is created when missing.
 * @returns {string} The same `directory`, after the plugin files are written.
 */
export function writeSamplePlugin(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({
    name: 'byline',
    private: true,
    type: 'module',
    version: '0.0.0',
    main: './index.js',
  }, null, 2)}\n`);
  writeFileSync(path.join(directory, 'index.js'), source);
  const modules = path.join(directory, 'node_modules');
  mkdirSync(modules, { recursive: true });
  symlinkSync(root, path.join(modules, 'cosplaying'), process.platform === 'win32' ? 'junction' : 'dir');
  return directory;
}
