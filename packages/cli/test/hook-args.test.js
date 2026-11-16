import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv, writeSpawnStub } from './spawn-stub.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const notify = fileURLToPath(new URL('../../../examples/notify', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
 * @param {string} stub
 */
function run(args, home, cwd, stub) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...systemEnv(),
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      COSPLAYING_NOTIFY_BIN: stub,
    },
  });
}

/**
 * @returns {{home: string, cwd: string, stub: string, marker: string}}
 */
function isolated() {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-hook-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-hook-cwd-'));
  const marker = path.join(home, 'spawned');
  const stub = writeSpawnStub(
    path.join(home, 'notify'),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '%s\\n' "$@"\n`,
    { marker },
  );
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [notify] }));
  return { home, cwd, stub, marker };
}

test('a hook flag after the command does not spawn', () => {
  const { home, cwd, stub, marker } = isolated();
  const stolen = run(['hook', 'notify', '--model', 'stolen'], home, cwd, stub);
  assert.notEqual(stolen.status, 0, stolen.stdout);
  assert.equal(existsSync(marker), false);
  assert.match(stolen.stderr, /--model is after the command/);
  assert.doesNotMatch(stolen.stderr, /no plugin is installed/);

  const harness = run(['hook', '--model', 'Example', 'notify', '--harness', 'prod'], home, cwd, stub);
  assert.notEqual(harness.status, 0, harness.stdout);
  assert.equal(existsSync(marker), false);
  assert.match(harness.stderr, /--harness is after the command/);
});

test('hook flags before -- reach the plugin and padded base64 is rejected', () => {
  const { home, cwd, stub, marker } = isolated();
  const encoded = Buffer.from('Example', 'utf8').toString('base64url');
  const listed = run(['hook', '--model-base64', encoded, '--', 'notify', '--list'], home, cwd, stub);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /--list/);
  assert.equal(existsSync(marker), true);

  const { home: home2, cwd: cwd2, stub: stub2, marker: marker2 } = isolated();
  const padded = run(['hook', '--model-base64', 'YQ==', '--', 'notify', '--list'], home2, cwd2, stub2);
  assert.notEqual(padded.status, 0);
  assert.equal(existsSync(marker2), false);
  assert.match(padded.stderr, /base64url/);
});
