import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Runs install or uninstall in a temporary home.
 *
 * `PATH` does not include a developer `cosplaying`, so the hook command uses this Node and this package.
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
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
}

/**
 * Creates a temporary home and working directory for an install-flag test.
 *
 * @returns {{home: string, cwd: string}} Absolute paths of the two directories.
 */
function isolated() {
  return {
    home: mkdtempSync(path.join(tmpdir(), 'cosplaying-install-home-')),
    cwd: mkdtempSync(path.join(tmpdir(), 'cosplaying-install-cwd-')),
  };
}

/**
 * Lists the hook commands stored in one settings file.
 *
 * JSON escapes backslashes in the file bytes. The returned strings are the commands the harness will run, after `JSON.parse`.
 *
 * @param {string} text UTF-8 contents of a hook settings file.
 * @returns {string[]} Command strings in visit order.
 */
function hookCommands(text) {
  /** @type {string[]} */
  const commands = [];
  /**
   * Appends `command` strings from one JSON value, including nested hook groups.
   *
   * @param {unknown} value Parsed JSON value or one nested entry.
   * @returns {void} No value. Matching commands are appended to `commands`.
   */
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value.command === 'string') commands.push(value.command);
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(JSON.parse(text));
  return commands;
}

test('repeated and comma-separated harness flags combine', () => {
  const { home, cwd } = isolated();
  const result = run(['install', '-H', 'codex,claude-code', '-a', 'cursor', '--harness', 'pi'], home, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed codex hooks \(/);
  assert.match(result.stdout, /installed claude-code hooks \(/);
  assert.match(result.stdout, /installed cursor hooks \(/);
  assert.match(result.stdout, /installed pi hooks \(/);
  assert.equal(existsSync(path.join(home, '.gemini', 'settings.json')), false);
  assert.equal(existsSync(path.join(home, '.config', 'opencode', 'plugins', 'cosplaying.js')), false);
  assert.match(result.stdout, /Codex CLI: run \/hooks, review cosplaying's PreToolUse command, then trust it\./);
  assert.match(result.stdout, /Claude Code runs settings hooks after workspace trust is accepted\./);
  assert.doesNotMatch(result.stdout, /Gemini CLI will warn/);

  const unknown = run(['install', '-H', 'codex,nope'], home, cwd);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown harness nope/);
});

test('--bin is the executable written into the hook file', () => {
  const { home, cwd } = isolated();
  const executable = "a b'c";
  const result = run(['install', '-H', 'codex', '--bin', executable], home, cwd);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
  const commands = hookCommands(text);
  assert.equal(commands.length > 0, true, text);
  const prefix = process.platform === 'win32' ? `"a b'c"` : "'a b'\\''c'";
  for (const command of commands) assert.equal(command.startsWith(`${prefix} agent-hook codex `), true, command);
  assert.match(text, /agent-hook codex /);
  assert.doesNotMatch(text, /main\.js/);
});

test('gemini warns only when hooks are installed for a project', () => {
  const { home, cwd } = isolated();
  const user = run(['install', '-H', 'gemini'], home, cwd);
  assert.equal(user.status, 0, user.stderr);
  assert.doesNotMatch(user.stdout, /Gemini CLI will warn/);
  const project = run(['install', '-H', 'gemini', '--project-dir', cwd], home, cwd);
  assert.equal(project.status, 0, project.stderr);
  assert.match(project.stdout, /Gemini CLI will warn before new or changed project hooks run; review the command\./);
});

test('install keeps foreign hooks, skips unchanged files, and reports removal', () => {
  const { home, cwd } = isolated();
  const file = path.join(home, '.claude', 'settings.json');
  const extension = path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js');
  mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { hooks: [{ type: 'command', command: 'rtk hook claude' }] };
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['read'] }, hooks: { PreToolUse: [foreign] } }));
  const first = run(['install', '-H', 'claude-code,pi'], home, cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /installed claude-code hooks \(/);
  const bytes = readFileSync(file);
  const parsed = JSON.parse(bytes);
  assert.deepEqual(Object.keys(parsed), ['permissions', 'hooks']);
  assert.deepEqual(parsed.permissions, { allow: ['read'] });
  assert.deepEqual(parsed.hooks.PreToolUse[0], foreign);
  assert.match(parsed.hooks.PreToolUse.at(-1).hooks[0].command, /# cosplaying:claude-code$/);
  const extensionBytes = readFileSync(extension);
  const past = new Date(Date.now() - 120_000);
  utimesSync(file, past, past);
  utimesSync(extension, past, past);
  const jsonTime = statSync(file).mtimeMs;
  const extensionTime = statSync(extension).mtimeMs;
  const second = run(['install', '-H', 'claude-code,pi'], home, cwd);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already configured claude-code hooks \(/);
  assert.doesNotMatch(second.stdout, /installed claude-code hooks/);
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readFileSync(extension), extensionBytes);
  assert.equal(statSync(file).mtimeMs, jsonTime);
  assert.equal(statSync(extension).mtimeMs, extensionTime);
  const repeated = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(repeated.hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes('# cosplaying:claude-code'))).length, 1);

  const removed = run(['uninstall', '-H', 'claude-code'], home, cwd);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed claude-code hooks \(/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    permissions: { allow: ['read'] }, hooks: { PreToolUse: [foreign] },
  });
  const again = run(['uninstall', '-H', 'claude-code'], home, cwd);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already configured claude-code hooks \(/);
  assert.doesNotMatch(again.stdout, /removed claude-code hooks/);
});

test('extension install and uninstall preserve unowned or invalid bytes while other harnesses install', () => {
  const { home, cwd } = isolated();
  const file = path.join(home, '.config', 'opencode', 'plugins', 'cosplaying.js');
  mkdirSync(path.dirname(file), { recursive: true });
  const original = 'export default function other() {}\n';
  writeFileSync(file, original);
  const result = run(['install', '-H', 'opencode', '-a', 'pi'], home, cwd);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /opencode/);
  assert.equal(readFileSync(file, 'utf8'), original);
  const pi = readFileSync(path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js'), 'utf8');
  assert.match(pi, /\/\/ cosplaying:pi/);

  const unowned = run(['uninstall', '-H', 'opencode'], home, cwd);
  assert.equal(unowned.status, 0, unowned.stderr);
  assert.equal(readFileSync(file, 'utf8'), original);

  const invalid = Buffer.concat([Buffer.from([0xff]), Buffer.from('// cosplaying:opencode\n')]);
  for (const action of ['install', 'uninstall']) {
    writeFileSync(file, invalid);
    const rejected = run([action, '-H', 'opencode'], home, cwd);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /not valid UTF-8/);
    assert.deepEqual(readFileSync(file), invalid);
  }

  writeFileSync(file, '// cosplaying:opencode\nold\n');
  const replaced = run(['install', '-H', 'opencode'], home, cwd);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(readFileSync(file, 'utf8'), /^\/\/ cosplaying:opencode\nimport /);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /\nold\n/);
  const removed = run(['uninstall', '-H', 'opencode'], home, cwd);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(file), false);
});

test('install refuses a symlink without changing its target', () => {
  const { home, cwd } = isolated();
  const file = path.join(home, '.cursor', 'hooks.json');
  const target = path.join(home, 'settings.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const original = '{}\n';
  writeFileSync(target, original);
  symlinkSync(target, file);
  const result = run(['install', '-H', 'cursor'], home, cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /symlink/);
  assert.match(result.stderr, /Replace the file with a regular file/);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), original);
});
