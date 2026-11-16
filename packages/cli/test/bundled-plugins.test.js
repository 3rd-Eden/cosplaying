import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const gitPlugin = fileURLToPath(new URL('../../../plugins/git', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
 * @param {Record<string, string>} [env]
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
 * @returns {{home: string, cwd: string}}
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
  const file = path.join(home, '.config', 'cosplaying', 'config.json');
  const written = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(written).plugins, ['git']);
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
  const after = run(['plugin', 'list'], home, cwd);
  assert.equal(after.stdout, '');
});

test('enable refuses YAML, a second user file, and an installed copy', () => {
  const yamlHome = isolated();
  const directory = path.join(yamlHome.home, '.config', 'cosplaying');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'config.yaml'), 'plugins: []\n');
  const yaml = run(['plugin', 'enable', 'git'], yamlHome.home, yamlHome.cwd);
  assert.equal(yaml.status, 1);
  assert.match(yaml.stderr, /config\.yaml is YAML/);
  assert.equal(existsSync(path.join(directory, 'config.json')), false);

  const many = isolated();
  const manyDir = path.join(many.home, '.config', 'cosplaying');
  mkdirSync(manyDir, { recursive: true });
  writeFileSync(path.join(manyDir, 'config.json'), '{}\n');
  writeFileSync(path.join(manyDir, 'config.yml'), 'plugins: []\n');
  const both = run(['plugin', 'enable', 'gh'], many.home, many.cwd);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /more than one config file/);

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

test('disable names a project file that enables a shipped plugin', () => {
  const { home, cwd } = isolated();
  const project = path.join(cwd, '.cosplaying.json');
  writeFileSync(project, `${JSON.stringify({ plugins: ['gh'] })}\n`);
  const result = run(['plugin', 'disable', 'gh'], home, cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /enabled in/);
  assert.match(result.stderr, /\.cosplaying\.json/);
  assert.equal(readFileSync(project, 'utf8'), `${JSON.stringify({ plugins: ['gh'] })}\n`);
});
