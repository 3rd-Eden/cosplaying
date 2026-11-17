import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Runs the CLI with the developer `PATH` so doctor can probe `cosplaying` when it is installed.
 *
 * The home is temporary, so Cursor hooks are not written to the developer home.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
}

/**
 * Checks that a parsed Cursor hooks file has the two events this install writes.
 *
 * `sessionStart` is one command. `preToolUse` matches `Shell` and fails closed. Both commands end with the Cursor ownership marker.
 *
 * @param {unknown} parsed Parsed `.cursor/hooks.json`. It must be the object this install writes.
 * @returns {void} No value. A mismatch throws an assertion error.
 */
function assertCursorHooks(parsed) {
  const config = /** @type {{ version: number, hooks: Record<string, Array<Record<string, unknown>>> }} */ (parsed);
  assert.deepEqual(Object.keys(config), ['version', 'hooks']);
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks), ['sessionStart', 'preToolUse']);
  const start = config.hooks.sessionStart;
  const pre = config.hooks.preToolUse;
  assert.equal(start.length, 1);
  assert.deepEqual(Object.keys(start[0]), ['command']);
  assert.match(String(start[0].command), /agent-hook cursor sessionStart # cosplaying:cursor$/);
  assert.equal(pre.length, 1);
  assert.deepEqual(Object.keys(pre[0]), ['command', 'matcher', 'failClosed']);
  assert.equal(pre[0].matcher, 'Shell');
  assert.equal(pre[0].failClosed, true);
  assert.match(String(pre[0].command), /agent-hook cursor preToolUse # cosplaying:cursor$/);
}

test('cursor install, uninstall, and doctor use the hooks file Cursor reads', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-cursor-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cursor-cwd-'));
  const userFile = path.join(home, '.cursor', 'hooks.json');
  const projectFile = path.join(cwd, '.cursor', 'hooks.json');
  try {
    const installed = run(['install', '--harness', 'cursor'], home, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(existsSync(projectFile), false);
    assertCursorHooks(JSON.parse(readFileSync(userFile, 'utf8')));

    const project = run(['install', '--harness', 'cursor', '--project-dir', cwd], home, cwd);
    assert.equal(project.status, 0, project.stderr);
    assertCursorHooks(JSON.parse(readFileSync(projectFile, 'utf8')));

    const doctor = run(['doctor', '--project-dir', cwd], home, cwd);
    assert.equal(doctor.stderr.includes(`missing owned hook in ${userFile}`), false, doctor.stderr);
    assert.equal(doctor.stderr.includes(`missing owned hook in ${projectFile}`), false, doctor.stderr);

    const removedUser = run(['uninstall', '--harness', 'cursor'], home, cwd);
    assert.equal(removedUser.status, 0, removedUser.stderr);
    assert.deepEqual(JSON.parse(readFileSync(userFile, 'utf8')), { version: 1 });
    assert.match(readFileSync(projectFile, 'utf8'), /cosplaying:cursor/);

    const removedProject = run(['uninstall', '--harness', 'cursor', '--project-dir', cwd], home, cwd);
    assert.equal(removedProject.status, 0, removedProject.stderr);
    assert.deepEqual(JSON.parse(readFileSync(projectFile, 'utf8')), { version: 1 });

    const after = run(['doctor', '--project-dir', cwd], home, cwd);
    assert.match(after.stderr, new RegExp(`missing owned hook in ${userFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(after.stderr, new RegExp(`missing owned hook in ${projectFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
