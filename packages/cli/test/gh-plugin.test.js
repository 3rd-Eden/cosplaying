import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * @returns {{home: string, cwd: string, log: string, env: Record<string, string>}}
 */
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  const binDir = path.join(home, 'bin');
  const log = path.join(home, 'gh-log');
  mkdirSync(binDir);
  const script = path.join(binDir, 'gh');
  writeFileSync(script, `#!/bin/sh
printf '%s\\n' "$@" > "$GH_LOG"
for arg in "$@"; do
  if [ -f "$arg" ]; then
    printf '\\n--file %s--\\n' "$arg" >> "$GH_LOG"
    cat "$arg" >> "$GH_LOG"
  fi
done
exit 0
`);
  chmodSync(script, 0o755);
  writeFileSync(path.join(cwd, '.cosplaying.json'), `${JSON.stringify({ plugins: ['gh'] })}\n`);
  return {
    home,
    cwd,
    log,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`,
      GH_LOG: log,
    },
  };
}

/**
 * @param {string[]} args
 * @param {ReturnType<typeof fixture>} context
 * @param {Record<string, string>} [extra]
 */
function run(args, context, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: context.cwd,
    encoding: 'utf8',
    env: { ...context.env, ...extra },
  });
}

test('gh text writes gain a byline and leave the source file unchanged', () => {
  const context = fixture();
  const created = run(['hook', '--model', 'Example', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body', 'The change is ready.'], context);
  assert.equal(created.status, 0, created.stderr);
  const inline = readFileSync(context.log, 'utf8');
  assert.match(inline, /<!-- cosplaying:attribution -->/);
  assert.match(inline, /Authored by Example via/);
  const source = path.join(context.cwd, 'body.md');
  const original = 'Hello from the file.\n';
  writeFileSync(source, original);
  const filed = run(['hook', '--model', 'Example', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body-file', source], context);
  assert.equal(filed.status, 0, filed.stderr);
  assert.equal(readFileSync(source, 'utf8'), original);
  const logged = readFileSync(context.log, 'utf8');
  assert.match(logged, /<!-- cosplaying:attribution -->/);
  assert.doesNotMatch(logged, new RegExp(`--file ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}--`));
});

test('a write without a model does not run gh, and a read does', () => {
  const context = fixture();
  const blocked = run(['hook', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body', 'Hello'], context);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.equal(existsSync(context.log), false);
  const viewed = run(['hook', '--', 'gh', 'pr', 'view', '1'], context);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.match(readFileSync(context.log, 'utf8'), /pr\nview\n1/);
});

test('an unsupported gh api mutation does not run gh', () => {
  const context = fixture();
  const blocked = run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'repos/owner/name/dispatches'], context);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /blocked unsupported mutating gh api request/);
  assert.equal(existsSync(context.log), false);
});
