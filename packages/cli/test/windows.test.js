import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv } from './spawn-stub.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const notify = fileURLToPath(new URL('../../../examples/notify', import.meta.url));
const onWindows = process.platform === 'win32';

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [extra]
 */
function envFor(home, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    ...systemEnv(),
    ...extra,
  };
}

/**
 * @returns {{home: string, cwd: string}}
 */
function isolated() {
  return {
    home: mkdtempSync(path.join(tmpdir(), 'cosplaying-win-home-')),
    cwd: mkdtempSync(path.join(tmpdir(), 'cosplaying-win-cwd-')),
  };
}

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [extra]
 */
function run(args, home, cwd, extra) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: envFor(home, extra),
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {unknown} value
 * @param {string[]} commands
 */
function collectCommands(value, commands) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectCommands(entry, commands);
    return;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.command === 'string') commands.push(record.command);
  for (const entry of Object.values(record)) collectCommands(entry, commands);
}

test('install writes double-quoted hook commands and doubles embedded quotes', {
  skip: onWindows ? false : 'win32 quoteShell runs on Windows',
}, () => {
  const { home, cwd } = isolated();
  try {
    const installed = run(['install', '-H', 'codex'], home, cwd, { PATH: '' });
    assert.equal(installed.status, 0, installed.stderr);
    const file = path.join(home, '.codex', 'hooks.json');
    /** @type {string[]} */
    const commands = [];
    collectCommands(JSON.parse(readFileSync(file, 'utf8')).hooks, commands);
    assert.equal(commands.length > 0, true);
    for (const command of commands) {
      assert.match(command, new RegExp(`^"${escapeRegExp(process.execPath)}" "`));
      assert.match(command, / agent-hook codex \S+ # cosplaying:codex$/);
    }

    const binPath = 'C:\\Program Files\\cos"playing.cmd';
    const quoted = `"${binPath.replaceAll('"', '""')}"`;
    const custom = run(['install', '-H', 'codex', '--bin', binPath], home, cwd, { PATH: '' });
    assert.equal(custom.status, 0, custom.stderr);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /cos\\"\\"playing/);
    /** @type {string[]} */
    const rewritten = [];
    collectCommands(JSON.parse(text).hooks, rewritten);
    assert.equal(rewritten.length, commands.length);
    for (const command of rewritten) {
      assert.equal(command.startsWith(`${quoted} agent-hook codex `), true, command);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('executable lookup uses PATHEXT to find a .cmd on PATH', {
  skip: onWindows ? false : 'PATHEXT lookup runs on Windows',
}, () => {
  const { home, cwd } = isolated();
  const binDir = path.join(cwd, 'bin');
  try {
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, 'notify.cmd'), '@echo off\r\necho FOUND:%~f0\r\n');
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [notify] }));

    const missed = run(['hook', '--', 'notify', '--list'], home, cwd, {
      PATH: binDir,
      PATHEXT: '.EXE',
    });
    assert.match(missed.stderr, /could not find the real notify executable/);
    assert.doesNotMatch(`${missed.stdout}${missed.stderr}`, /notify\.cmd/i);

    const found = run(['hook', '--', 'notify', '--list'], home, cwd, {
      PATH: binDir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    });
    const output = `${found.stdout}${found.stderr}`;
    assert.match(output, /notify\.cmd/i, output);
    assert.doesNotMatch(output, /could not find the real notify executable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

if (onWindows) {
  test('Claude SessionStart ignores a chmod failure on the session file', {
    skip: 'Windows chmod is SetFileAttributes on the session file just written. Denying that access also denies the write, so the failure cannot be forced without a mock. The darwin seatbelt test still covers EPERM.',
  }, () => {});
}
