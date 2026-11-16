import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'unbash';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const notify = fileURLToPath(new URL('../../../examples/notify', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(args, home, cwd, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      ...env,
    },
  });
}

test('the hook prefix puts --model-base64 after hook and main accepts that argv', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-prefix-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-prefix-cwd-'));
  const stub = path.join(home, 'notify');
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(stub, 0o755);
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [notify] }));
  const env = { COSPLAYING_NOTIFY_BIN: stub };
  const rewritten = run(['rewrite', '--model', 'Example Model', '--', 'notify --list'], home, cwd, env);
  assert.equal(rewritten.status, 0, rewritten.stderr);
  const text = rewritten.stdout.trim();
  assert.match(text, /hook --model-base64 \S+ -- notify --list$/);
  assert.doesNotMatch(text, /--model-base64 \S+ hook --/);

  const tree = parse(text);
  const command = tree.commands[0].command;
  const words = [command.name, ...(command.suffix || [])].map((word) => word.value);
  assert.equal(words[2], 'hook');
  assert.equal(words[3], '--model-base64');
  const executed = run(words.slice(2), home, cwd, env);
  assert.notEqual(executed.status, 2, executed.stderr);
  assert.doesNotMatch(executed.stderr, /unknown command --model-base64/);
  assert.equal(executed.status, 0, executed.stderr);
  assert.match(executed.stdout, /--list/);
});
