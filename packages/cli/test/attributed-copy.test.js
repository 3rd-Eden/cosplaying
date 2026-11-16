import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));

test('hook loads a plugin that writes a mode 0600 attributed copy and removes it', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  const temp = path.join(home, 'tmp');
  const pluginDir = path.join(cwd, 'copyfile');
  const link = path.join(pluginDir, 'node_modules', 'cosplaying');
  try {
    mkdirSync(temp);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(root, link);
    writeFileSync(path.join(pluginDir, 'package.json'), `${JSON.stringify({
      name: 'copyfile',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    })}\n`);
    writeFileSync(path.join(pluginDir, 'index.js'), [
      "import { statSync } from 'node:fs';",
      "import { withAttributedCopy } from 'cosplaying/plugin';",
      'export default async function run(args, context) {',
      '  await withAttributedCopy(args[0], (text) => text, (file) => {',
      '    const mode = (statSync(file).mode & 0o777).toString(8);',
      '    context.stdout.write(`${mode}\\n${file}\\n`);',
      '  });',
      '  return 0;',
      '}',
      '',
    ].join('\n'));
    const source = path.join(cwd, 'notes');
    writeFileSync(source, 'Hello\n');
    const program = path.join(home, 'copyfile-bin');
    writeFileSync(program, '');
    writeFileSync(path.join(cwd, '.cosplaying.json'), `${JSON.stringify({ plugins: [pluginDir] })}\n`);

    const result = spawnSync(process.execPath, [bin, 'hook', '--', 'copyfile', source], {
      cwd,
      encoding: 'utf8',
      env: {
        HOME: home,
        USERPROFILE: home,
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
        COSPLAYING_COPYFILE_BIN: program,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const lines = result.stdout.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    const [mode, copyPath] = lines;
    if (process.platform !== 'win32') assert.equal(mode, '600');
    assert.match(path.basename(copyPath), new RegExp(`^cosplaying-${result.pid}-[0-9a-f]{8}$`));
    assert.equal(path.dirname(copyPath), temp);
    assert.equal(existsSync(copyPath), false);
    assert.equal(readFileSync(source, 'utf8'), 'Hello\n');
    assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('cosplaying-')), []);
  } finally {
    try {
      unlinkSync(link);
    } catch {
      // The link was not created.
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
