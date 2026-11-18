import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Runs the CLI with an isolated note-writing plugin.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @param {string} entry Plugin entry used as the unused real-binary override.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd, entry) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      COSPLAYING_BYLINE_BIN: entry,
    },
  });
}

/**
 * Creates a temporary home, working directory, and a plugin that saves a note.
 *
 * The test callback deletes both directories when it finishes.
 *
 * @param {import('node:test').TestContext} t Test context. Its `after` hook removes the temporary directories.
 * @returns {{home: string, cwd: string, entry: string, note: string}}
 */
function isolated(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-hook-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-hook-cwd-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const note = path.join(cwd, 'note.txt');
  const plugin = path.join(cwd, 'byline');
  mkdirSync(plugin);
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'byline', version: '1.0.0', type: 'module', main: './index.js' }));
  const entry = path.join(plugin, 'index.js');
  writeFileSync(entry, `import { readFileSync, writeFileSync } from 'node:fs';
export default function run(args, context) {
  const message = args.indexOf('--message');
  const note = context.cwd + '/note.txt';
  writeFileSync(note, message < 0 ? '' : args[message + 1]);
  context.stdout.write(readFileSync(note, 'utf8'));
  return 0;
}\n`);
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [plugin] }));
  return { home, cwd, entry, note };
}

test('a flag after the command does not run the plugin', (t) => {
  const { home, cwd, entry, note } = isolated(t);
  const stolen = run(['hook', 'byline', '--model', 'stolen'], home, cwd, entry);
  assert.notEqual(stolen.status, 0, stolen.stdout);
  assert.equal(existsSync(note), false);
  assert.match(stolen.stderr, /--model is after the command/);
  assert.doesNotMatch(stolen.stderr, /no plugin is installed/);

  const harness = run(['hook', '--model', 'Example', 'byline', '--harness', 'prod'], home, cwd, entry);
  assert.notEqual(harness.status, 0, harness.stdout);
  assert.equal(existsSync(note), false);
  assert.match(harness.stderr, /--harness is after the command/);

  const wrapped = run(['hook', '--model', 'Example', 'byline', '--message', 'text'], home, cwd, entry);
  assert.equal(wrapped.status, 2);
  assert.equal(wrapped.stdout, '');
  assert.match(wrapped.stderr, /--message/);
  assert.match(wrapped.stderr, /For more information visit:/);
  assert.equal(existsSync(note), false);
});

test('hook flags before -- let the plugin write a note and padded base64 is rejected', (t) => {
  const { home, cwd, entry, note } = isolated(t);
  const encoded = Buffer.from('Example', 'utf8').toString('base64url');
  const written = run(['hook', '--model-base64', encoded, '--', 'byline', '--message', 'Saved note.'], home, cwd, entry);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stderr, '');
  assert.equal(written.stdout, 'Saved note.');
  assert.equal(readFileSync(note, 'utf8'), 'Saved note.');

  const { home: home2, cwd: cwd2, entry: entry2, note: note2 } = isolated(t);
  const padded = run(['hook', '--model-base64', 'YQ==', '--', 'byline', '--message', 'Must not be saved.'], home2, cwd2, entry2);
  assert.notEqual(padded.status, 0);
  assert.equal(existsSync(note2), false);
  assert.match(padded.stderr, /base64url/);
});
