import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../cli/bin/cosplaying.js', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * @param {string[]} args
 */
function run(args) {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { HOME: home },
    encoding: 'utf8',
  });
}

test('a rejected command explains the mistake and the next action', () => {
  const result = run(['install', '--harness', 'nope']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /cosplaying\/cli\(install\): unknown harness nope\. Supported harnesses: claude-code, codex, cursor, gemini, opencode, pi\./);
  assert.match(result.stderr, /Run cosplaying install --harness <name> with one of those harness names\./);
  assert.match(result.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
  assert.doesNotMatch(result.stderr, /discord\.gg|stackoverflow\.com|mailto:/i);
  const page = path.join(root, 'docs', 'errors.md');
  assert.equal(statSync(page).isFile(), true);
  assert.equal(existsSync(path.join(root, 'docs', 'errors')), false);
});

test('the docs anchor stays the same when the bad value changes', () => {
  const first = run(['install', '--harness', 'nope']);
  const second = run(['install', '--harness', 'other']);
  const anchor = first.stderr.match(/error-[0-9a-f]{6}/);
  assert.ok(anchor);
  assert.match(second.stderr, new RegExp(anchor[0]));
  assert.match(second.stderr, /unknown harness other/);
  assert.doesNotMatch(second.stderr, /unknown harness nope/);
});
