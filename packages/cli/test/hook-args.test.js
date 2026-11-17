import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Runs the CLI with the byline plugin forced to a stub file.
 *
 * The stub records that the real command was reached. `PATH` does not include a developer `byline`.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @param {string} stub Absolute path of the plugin entry used as `COSPLAYING_BYLINE_BIN`.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd, stub) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      COSPLAYING_BYLINE_BIN: stub,
    },
  });
}

/**
 * Creates a temporary home, a working directory, and a byline plugin that records when it runs.
 *
 * The test callback deletes both directories when it finishes.
 *
 * @param {import('node:test').TestContext} t Test context. Its `after` hook removes the temporary directories.
 * @returns {{home: string, cwd: string, stub: string, marker: string}} The home, the working directory, the plugin entry, and the file the plugin writes when it runs.
 */
function isolated(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-hook-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-hook-cwd-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const marker = path.join(home, 'ran');
  const plugin = path.join(cwd, 'byline');
  mkdirSync(plugin);
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'byline', version: '1.0.0', type: 'module', main: './index.js' }));
  const stub = path.join(plugin, 'index.js');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';
export default function run(args, context) {
  writeFileSync(${JSON.stringify(marker)}, 'yes');
  context.stdout.write(JSON.stringify(args));
  return 0;
}\n`);
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [plugin] }));
  return { home, cwd, stub, marker };
}

test('a flag after the command does not run the plugin', (t) => {
  const { home, cwd, stub, marker } = isolated(t);
  const stolen = run(['hook', 'byline', '--model', 'stolen'], home, cwd, stub);
  assert.notEqual(stolen.status, 0, stolen.stdout);
  assert.equal(existsSync(marker), false);
  assert.match(stolen.stderr, /--model is after the command/);
  assert.doesNotMatch(stolen.stderr, /no plugin is installed/);

  const harness = run(['hook', '--model', 'Example', 'byline', '--harness', 'prod'], home, cwd, stub);
  assert.notEqual(harness.status, 0, harness.stdout);
  assert.equal(existsSync(marker), false);
  assert.match(harness.stderr, /--harness is after the command/);

  const wrapped = run(['hook', '--model', 'Example', 'byline', '--message', 'text'], home, cwd, stub);
  assert.equal(wrapped.status, 2);
  assert.equal(wrapped.stdout, '');
  assert.match(wrapped.stderr, /--message/);
  assert.match(wrapped.stderr, /For more information visit:/);
  assert.equal(existsSync(marker), false);
});

test('hook flags before -- reach the plugin and padded base64 is rejected', (t) => {
  const { home, cwd, stub, marker } = isolated(t);
  const encoded = Buffer.from('Example', 'utf8').toString('base64url');
  const listed = run(['hook', '--model-base64', encoded, '--', 'byline', '--list'], home, cwd, stub);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /--list/);
  assert.equal(existsSync(marker), true);

  const { home: home2, cwd: cwd2, stub: stub2, marker: marker2 } = isolated(t);
  const padded = run(['hook', '--model-base64', 'YQ==', '--', 'byline', '--list'], home2, cwd2, stub2);
  assert.notEqual(padded.status, 0);
  assert.equal(existsSync(marker2), false);
  assert.match(padded.stderr, /base64url/);
});
