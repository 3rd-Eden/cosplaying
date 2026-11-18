import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const gitPlugin = fileURLToPath(new URL('../../../plugins/git', import.meta.url));

/**
 * Runs the CLI with the developer `PATH`, so a real `git` can be found when a test needs one.
 *
 * Extra environment values can select an isolated executable.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @param {Record<string, string>} [env={}] Extra environment variables.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH || '/usr/bin:/bin',
      ...env,
    },
  });
}

/**
 * Creates a temporary home and working directory for a shipped-plugin test.
 *
 * Enable and disable write the user settings under this home.
 *
 * @returns {{home: string, cwd: string}} Absolute paths of the two directories.
 */
function isolated() {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  return { home, cwd };
}

test('git and gh stay off until they are named', () => {
  const { home, cwd } = isolated();
  const git = run(['rewrite', '--shell', 'git commit -m hi'], home, cwd);
  assert.equal(git.status, 0);
  assert.equal(git.stdout, 'git commit -m hi\n');
  const gh = run(['rewrite', '--shell', 'gh pr create --body hi'], home, cwd);
  assert.equal(gh.status, 0);
  assert.equal(gh.stdout, 'gh pr create --body hi\n');
  const blocked = run(['hook', '--', 'git', 'status'], home, cwd);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /shipped plugin git is off/);
  assert.match(blocked.stderr, /cosplaying plugin enable git/);
  const ghBlocked = run(['hook', '--', 'gh', 'pr', 'view'], home, cwd);
  assert.equal(ghBlocked.status, 1);
  assert.match(ghBlocked.stderr, /cosplaying plugin enable gh/);
});

test('plugin enable writes the user config and disable removes the name', () => {
  const { home, cwd } = isolated();
  const enabled = run(['plugin', 'enable', 'git'], home, cwd);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stdout, `git\t${gitPlugin}\n`);
  const file = path.join(home, '.config', 'cosplaying', '.cosplaying.json');
  const written = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(written).plugins, ['git']);
  const piExtension = path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js');
  const openCodeExtension = path.join(home, '.config', 'opencode', 'plugins', 'cosplaying.js');
  {
    const project = path.join(cwd, '.cosplaying.json');
    writeFileSync(project, '{');
    const probe = spawnSync(process.execPath, [
      fileURLToPath(new URL('./fixtures/extension-host.mjs', import.meta.url)),
      piExtension, openCodeExtension, 'git status', 'Shell',
    ], {
      cwd, encoding: 'utf8',
      env: { HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    rmSync(project);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stderr, '');
    const state = JSON.parse(probe.stdout);
    assert.equal(state.piBlock, true);
    assert.match(state.piReason, /cosplaying hook/);
    assert.match(state.openError, /cosplaying hook/);
    assert.equal(state.piLiteralBlock, null);
    assert.equal(state.openLiteral, 'echo git status');
  }
  const listed = run(['plugin', 'list'], home, cwd);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, `git\tgit\tbundled\t${gitPlugin}\n`);
  const help = run(['--help'], home, cwd);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /git {2}Attribute Git commits/);
  assert.match(help.stdout, /cosplaying hook --model "Example" -- git commit -m "Add retry support"/);
  const rewritten = run(['rewrite', '--shell', 'git status'], home, cwd);
  assert.equal(rewritten.status, 0, rewritten.stderr);
  assert.match(rewritten.stdout, /hook -- git status/);
  const stamp = statSync(file).mtimeMs;
  const again = run(['plugin', 'enable', 'git'], home, cwd);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(file, 'utf8'), written);
  assert.equal(statSync(file).mtimeMs, stamp);
  const disabled = run(['plugin', 'disable', 'git'], home, cwd);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout, 'git\n');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).plugins, []);
  {
    const project = path.join(cwd, '.cosplaying.json');
    writeFileSync(project, '{');
    const probe = spawnSync(process.execPath, [
      fileURLToPath(new URL('./fixtures/extension-host.mjs', import.meta.url)),
      piExtension, openCodeExtension, 'git status', 'Shell',
    ], {
      cwd, encoding: 'utf8',
      env: { HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    rmSync(project);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stderr, '');
    const state = JSON.parse(probe.stdout);
    assert.equal(state.piBlock, null);
    assert.equal(state.openError, '');
    assert.equal(state.piCommand, 'git status');
    assert.equal(state.openCommand, 'git status');
    assert.equal(state.piLiteralBlock, null);
    assert.equal(state.openLiteral, 'echo git status');
  }
  const after = run(['plugin', 'list'], home, cwd);
  assert.equal(after.stdout, '');
});

test('plugin enable reports when a project plugins list keeps it disabled', () => {
  const { home, cwd } = isolated();
  const project = path.join(cwd, '.cosplaying.json');
  writeFileSync(project, `${JSON.stringify({ plugins: [] })}\n`);

  const result = run(['plugin', 'enable', 'git'], home, cwd);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /project settings/);
  assert.equal(result.stderr.includes(project), true);
  assert.match(result.stderr, /Add "git" to the plugins list/);
  assert.equal(existsSync(path.join(home, '.config', 'cosplaying', '.cosplaying.json')), false);
});

test('enable edits a yaml settings file, selects the first config file, and rejects an installed copy', () => {
  const yamlHome = isolated();
  const directory = path.join(yamlHome.home, '.config', 'cosplaying');
  mkdirSync(directory, { recursive: true });
  const yamlFile = path.join(directory, '.cosplaying.yaml');
  writeFileSync(yamlFile, 'plugins: []\n');
  const yaml = run(['plugin', 'enable', 'git'], yamlHome.home, yamlHome.cwd);
  assert.equal(yaml.status, 0, yaml.stderr);
  assert.equal(existsSync(path.join(directory, '.cosplaying.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(yamlFile, 'utf8')).plugins, ['git']);

  const many = isolated();
  const manyDir = path.join(many.home, '.config', 'cosplaying');
  mkdirSync(manyDir, { recursive: true });
  const jsonFile = path.join(manyDir, '.cosplaying.json');
  const multipleYamlFile = path.join(manyDir, '.cosplaying.yml');
  writeFileSync(jsonFile, '{}\n');
  writeFileSync(multipleYamlFile, 'plugins: []\n');
  const selected = run(['plugin', 'enable', 'gh'], many.home, many.cwd);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(readFileSync(jsonFile, 'utf8')).plugins, ['gh']);
  assert.equal(readFileSync(multipleYamlFile, 'utf8'), 'plugins: []\n');

  const installed = isolated();
  const source = path.join(installed.cwd, 'git-plugin');
  mkdirSync(source);
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'git',
    version: '0.0.0',
    type: 'module',
    main: './index.js',
  }));
  writeFileSync(path.join(source, 'index.js'), 'export default function run() { return 0; }\n');
  const copied = run(['plugin', 'install', source], installed.home, installed.cwd);
  assert.equal(copied.status, 0, copied.stderr);
  const refused = run(['plugin', 'enable', 'git'], installed.home, installed.cwd);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already installed/);
  assert.match(refused.stderr, /plugin uninstall git/);
});

test('disable removes the user setting and reports a project setting that still enables the plugin', () => {
  const { home, cwd } = isolated();
  const user = path.join(home, '.config', 'cosplaying', '.cosplaying.json');
  const project = path.join(cwd, '.cosplaying.json');
  mkdirSync(path.dirname(user), { recursive: true });
  writeFileSync(user, `${JSON.stringify({ plugins: ['git'] })}\n`);
  writeFileSync(project, `${JSON.stringify({ plugins: ['git'] })}\n`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(['plugin', 'disable', 'git'], home, cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /enabled in/);
    assert.equal(result.stderr.includes(project), true);
    assert.deepEqual(JSON.parse(readFileSync(user, 'utf8')).plugins, []);
    assert.equal(readFileSync(project, 'utf8'), `${JSON.stringify({ plugins: ['git'] })}\n`);
  }
});
