import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv } from './spawn-stub.js';
import { writeSamplePlugin } from './sample-plugin.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const byline = writeSamplePlugin(mkdtempSync(path.join(tmpdir(), 'cosplaying-byline-')));
const onWindows = process.platform === 'win32';

/**
 * Builds the environment for a Windows hook-quoting test.
 *
 * The temporary directory is the home and the temp directory. `systemEnv` supplies `SystemRoot` when Windows needs it to start a process.
 *
 * @param {string} home Temporary directory used as home, profile, and temp.
 * @param {NodeJS.ProcessEnv} [extra={}] Values that replace the defaults, including `PATH`.
 * @returns {NodeJS.ProcessEnv} Environment for one CLI spawn.
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
 * Creates a temporary home and a temporary working directory.
 *
 * The test uses them so install does not write the developer hook files.
 *
 * @returns {{home: string, cwd: string}} Absolute paths of the two directories.
 */
function isolated() {
  return {
    home: mkdtempSync(path.join(tmpdir(), 'cosplaying-win-home-')),
    cwd: mkdtempSync(path.join(tmpdir(), 'cosplaying-win-cwd-')),
  };
}

/**
 * Runs the CLI with the Windows test environment.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home passed to {@link envFor}.
 * @param {string} cwd Working directory for the CLI.
 * @param {NodeJS.ProcessEnv} [extra] Extra environment values, such as an empty `PATH`.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd, extra) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: envFor(home, extra),
  });
}

/**
 * Escapes a path so it can be placed in a regular expression.
 *
 * Hook commands contain the Node executable path. The test matches that path as literal text.
 *
 * @param {string} value Text to escape, usually an absolute path.
 * @returns {string} `value` with regular-expression metacharacters escaped.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Appends every `command` string found in a hook settings value.
 *
 * Nested objects and arrays are searched. The test uses the list to check Windows quoting.
 *
 * @param {unknown} value Parsed JSON value, or one nested entry.
 * @param {string[]} commands Destination list. Each `command` string is appended.
 * @returns {void} No value. `commands` is updated in place.
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
    const quoted = '"C:\\Program Files\\cos""playing.cmd"';
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
    writeFileSync(path.join(binDir, 'byline.cmd'), '@echo off\r\necho FOUND:%~f0\r\n');
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [byline] }));

    const missed = run(['hook', '--', 'byline', '--list'], home, cwd, {
      PATH: binDir,
      PATHEXT: '.EXE',
    });
    assert.match(missed.stderr, /could not find the real byline executable/);
    assert.doesNotMatch(`${missed.stdout}${missed.stderr}`, /byline\.cmd/i);

    const found = run(['hook', '--', 'byline', '--list'], home, cwd, {
      PATH: binDir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    });
    const output = `${found.stdout}${found.stderr}`;
    assert.equal(found.status, 0, output);
    assert.match(found.stdout, /^FOUND:.*[\\/]byline\.cmd\r?\n$/i);
    assert.equal(found.stderr, '');
    assert.doesNotMatch(output, /could not find the real byline executable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
