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

test('hook preserves source files and removes private attributed copies after success or failure', () => {
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
    writeFileSync(path.join(pluginDir, 'index.js'), String.raw`
import { readFileSync, statSync } from 'node:fs';
import { withAttributedCopy } from 'cosplaying/plugin';
export default async function run(args, context) {
  try {
    await withAttributedCopy(args[0], (text) => {
      if (args[1] === 'render-error') throw new Error('The renderer failed.');
      return context.attribution.annotateMarkdown(text);
    }, (file) => {
      context.stdout.write(JSON.stringify({
        file,
        mode: statSync(file).mode & 0o777,
        text: readFileSync(file, 'utf8'),
      }) + '\n');
      if (args[1] === 'work-error') throw new Error('The copy consumer failed.');
    });
    return 0;
  } catch (error) {
    context.stderr.write(error.message + '\n');
    return 2;
  }
}
`);
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [pluginDir] }));
    const rows = [
      { name: 'notes', mode: 'ok', status: 0 },
      { name: 'body.md', mode: 'ok', status: 0 },
      { name: 'render.md', mode: 'render-error', status: 2, error: /The renderer failed/ },
      { name: 'work.md', mode: 'work-error', status: 2, error: /The copy consumer failed/ },
      { name: 'missing.md', mode: 'ok', status: 2, error: /could not read.*missing\.md/ },
      { name: 'invalid.md', mode: 'ok', status: 2, error: /file is not valid UTF-8/, bytes: Buffer.from([0xff, 0xfe, 0x00]) },
    ];
    for (const row of rows) {
      const source = path.join(cwd, row.name);
      const bytes = row.bytes ?? Buffer.from('Hello\n');
      if (row.name !== 'missing.md') writeFileSync(source, bytes);
      const result = spawnSync(process.execPath, [bin, 'hook', '--model', 'Example', '--', 'copyfile', source, row.mode], {
        cwd,
        encoding: 'utf8',
        env: {
          HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp,
          COSPLAYING_COPYFILE_BIN: path.join(pluginDir, 'package.json'),
        },
      });
      assert.equal(result.status, row.status, result.stderr);
      if (row.error) assert.match(result.stderr, row.error);
      else assert.equal(result.stderr, '');
      if (row.status === 0 || row.mode === 'work-error') {
        const copy = JSON.parse(result.stdout);
        if (process.platform !== 'win32') assert.equal(copy.mode, 0o600);
        assert.equal(path.dirname(copy.file), temp);
        assert.equal(path.extname(copy.file), path.extname(source));
        assert.equal(copy.text, 'Hello\n\n<!-- cosplaying:attribution -->\n> 🤖 Authored by Example via [cosplaying](https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.\n<!-- /cosplaying:attribution -->\n');
        assert.equal(existsSync(copy.file), false);
      } else {
        assert.equal(result.stdout, '');
      }
      if (row.name !== 'missing.md') assert.deepEqual(readFileSync(source), bytes);
      assert.deepEqual(readdirSync(temp), []);
    }
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
