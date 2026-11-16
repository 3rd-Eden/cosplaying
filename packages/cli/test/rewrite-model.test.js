import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const mainJs = '/usr/local/bin/main.js';
const encoded = Buffer.from('Example Model', 'utf8').toString('base64url');

/**
 * @param {string} command
 * @param {string} [model]
 */
function rewrite(command, model = 'Example Model') {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-rewrite-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-rewrite-cwd-'));
  return spawnSync(process.execPath, [bin, 'rewrite', '--model', model, '--', command], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
}

test('wrapper prefixes still rewrite the hook model flag', () => {
  const cases = [
    `env FOO=1 node ${mainJs} hook --model 'Claude Code' -- git commit`,
    `rtk proxy node ${mainJs} hook --model 'Claude Code' -- git commit`,
    `sudo -u user node ${mainJs} hook --model 'Claude Code' -- git commit`,
  ];
  for (const input of cases) {
    const result = rewrite(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), input.replace("--model 'Claude Code'", `--model-base64 ${encoded}`), input);
  }
  const sudo = rewrite(`sudo -u user node ${mainJs} hook --model 'Claude Code' -- git commit`);
  assert.match(sudo.stdout, /sudo -u user node /);
});

test('a model flag after -- belongs to the wrapped command', () => {
  const input = `node ${mainJs} hook -- gh pr create --model 'Claude Code'`;
  const result = rewrite(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${input}\n`);
});

test('every harness-label flag on the hook invocation is replaced', () => {
  const input = `node ${mainJs} hook --model 'Claude Code' --model 'Codex' -- git commit`;
  const flag = `--model-base64 ${encoded}`;
  const result = rewrite(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trimEnd(), `node ${mainJs} hook ${flag} ${flag} -- git commit`);
});

test('an active harness label is not substituted', () => {
  const input = `env FOO=1 node ${mainJs} hook --model 'Claude Code' -- git commit`;
  const result = rewrite(input, 'Claude Code');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${input}\n`);
  const plain = `node ${mainJs} hook --model 'gpt-5' -- gh`;
  const kept = rewrite(plain);
  assert.equal(kept.stdout, `${plain}\n`);
});
