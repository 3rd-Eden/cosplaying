import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installHookFile, installJsonHooks, quoteShell, uninstallHookFile, uninstallJsonHooks, writeTextAtomic } from '../src/index.js';

test('json hook install preserves foreign keys and appends the owned hook last', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cosplaying-hooks-'));
  const file = path.join(directory, 'settings.json');
  writeFileSync(file, `${JSON.stringify({
    permissions: { allow: [] },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
  }, null, 2)}\n`);
  const owned = { hooks: [{ type: 'command', command: 'cosplaying agent-hook claude-code PreToolUse # cosplaying:claude-code' }] };
  installJsonHooks(file, '# cosplaying:claude-code', { PreToolUse: [owned] });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed), ['permissions', 'hooks']);
  assert.equal(parsed.hooks.PreToolUse.at(-1).hooks[0].command.includes('# cosplaying:claude-code'), true);
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
  installJsonHooks(file, '# cosplaying:claude-code', { PreToolUse: [owned] });
  const again = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(again.hooks.PreToolUse.filter((entry) => JSON.stringify(entry).includes('# cosplaying:claude-code')).length, 1);
  uninstallJsonHooks(file, '# cosplaying:claude-code');
  const removed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(JSON.stringify(removed).includes('# cosplaying:claude-code'), false);
  assert.equal(removed.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
});

test('a generated hook file is replaced only when it carries the marker', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cosplaying-hooks-'));
  const file = path.join(directory, 'cosplaying.js');
  writeFileSync(file, 'export default function user() {}\n');
  assert.throws(() => installHookFile(file, '// cosplaying:pi', '// cosplaying:pi\nexport {}\n'), /unmanaged/);
  assert.equal(uninstallHookFile(file, '// cosplaying:pi'), false);
  assert.equal(readFileSync(file, 'utf8').includes('user()'), true);
  writeFileSync(file, '// cosplaying:pi\nold\n');
  installHookFile(file, '// cosplaying:pi', '// cosplaying:pi\nexport {}\n');
  assert.equal(readFileSync(file, 'utf8'), '// cosplaying:pi\nexport {}\n');
  assert.equal(uninstallHookFile(file, '// cosplaying:pi'), true);
});

test('quoteShell uses POSIX or Windows quoting', () => {
  assert.equal(quoteShell("a b'c", 'linux'), "'a b'\\''c'");
  assert.equal(quoteShell('a "b"', 'win32'), '"a ""b"""');
});

test('writeTextAtomic refuses a symlink and still writes a regular file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cosplaying-hooks-'));
  try {
    const target = path.join(directory, 'target.txt');
    const link = path.join(directory, 'link.txt');
    const original = Buffer.from('original-bytes');
    writeFileSync(target, original);
    symlinkSync(target, link);
    assert.throws(() => writeTextAtomic(link, 'changed'), (error) => {
      assert.equal(error.name, 'LayerError');
      assert.equal(error.method, 'writeTextAtomic');
      assert.match(error.message, /link\.txt/);
      assert.match(error.message, /Do not follow the symlink/);
      assert.match(error.message, /regular file/);
      assert.match(error.message, /packages\/hooks\/README\.md#error-[0-9a-f]{6}/);
      return true;
    });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(target), original);

    const plain = path.join(directory, 'plain.txt');
    writeTextAtomic(plain, 'hello\n');
    assert.equal(lstatSync(plain).isSymbolicLink(), false);
    assert.equal(readFileSync(plain, 'utf8'), 'hello\n');

    const hook = path.join(directory, 'cosplaying.js');
    const contents = '// cosplaying:pi\nexport {}\n';
    installHookFile(hook, '// cosplaying:pi', contents);
    const past = new Date(Date.now() - 120_000);
    utimesSync(hook, past, past);
    const before = statSync(hook).mtimeMs;
    assert.equal(installHookFile(hook, '// cosplaying:pi', contents), false);
    assert.equal(statSync(hook).mtimeMs, before);
    assert.equal(readFileSync(hook, 'utf8'), contents);

    const json = path.join(directory, 'settings.json');
    const owned = { hooks: [{ type: 'command', command: 'cosplaying agent-hook claude-code PreToolUse # cosplaying:claude-code' }] };
    installJsonHooks(json, '# cosplaying:claude-code', { PreToolUse: [owned] });
    const written = readFileSync(json);
    utimesSync(json, past, past);
    const jsonBefore = statSync(json).mtimeMs;
    installJsonHooks(json, '# cosplaying:claude-code', { PreToolUse: [owned] });
    assert.equal(statSync(json).mtimeMs, jsonBefore);
    assert.deepEqual(readFileSync(json), written);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid UTF-8 hook files are not installed or removed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cosplaying-hooks-'));
  try {
    const file = path.join(directory, 'cosplaying.js');
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from('// cosplaying:pi\n')]);
    writeFileSync(file, bytes);
    assert.throws(() => installHookFile(file, '// cosplaying:pi', '// cosplaying:pi\nexport {}\n'), (error) => {
      assert.equal(error.name, 'LayerError');
      assert.equal(error.method, 'readUtf8File');
      assert.match(error.message, /not valid UTF-8/);
      assert.match(error.message, /packages\/hooks\/README\.md#error-[0-9a-f]{6}/);
      return true;
    });
    assert.deepEqual(readFileSync(file), bytes);
    assert.throws(() => uninstallHookFile(file, '// cosplaying:pi'), (error) => {
      assert.equal(error.name, 'LayerError');
      assert.equal(error.method, 'readUtf8File');
      return true;
    });
    assert.equal(existsSync(file), true);
    assert.deepEqual(readFileSync(file), bytes);

    const contents = '// cosplaying:pi\nexport {}\n';
    writeFileSync(file, '// cosplaying:pi\nold\n');
    assert.equal(installHookFile(file, '// cosplaying:pi', contents), true);
    assert.equal(readFileSync(file, 'utf8'), contents);
    assert.equal(uninstallHookFile(file, '// cosplaying:pi'), true);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
