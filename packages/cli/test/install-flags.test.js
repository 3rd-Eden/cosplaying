import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
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
 * @returns {{home: string, cwd: string}}
 */
function isolated() {
  return {
    home: mkdtempSync(path.join(tmpdir(), 'cosplaying-install-home-')),
    cwd: mkdtempSync(path.join(tmpdir(), 'cosplaying-install-cwd-')),
  };
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
  const fake = path.join(home, 'cosplaying');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const result = run(['install', '-H', 'codex', '--bin', fake], home, cwd);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
  assert.match(text, new RegExp(fake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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

test('a second install is already configured and uninstall reports removal', () => {
  const { home, cwd } = isolated();
  const first = run(['install', '-H', 'cursor'], home, cwd);
  assert.match(first.stdout, /installed cursor hooks \(/);
  const second = run(['install', '-H', 'cursor'], home, cwd);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already configured cursor hooks \(/);
  assert.doesNotMatch(second.stdout, /installed cursor hooks/);

  const removed = run(['uninstall', '-H', 'cursor'], home, cwd);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed cursor hooks \(/);
  // already configured means the file bytes did not change: the owned hooks were already absent
  const again = run(['uninstall', '-H', 'cursor'], home, cwd);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already configured cursor hooks \(/);
  assert.doesNotMatch(again.stdout, /removed cursor hooks/);
});

test('an unmarked OpenCode file does not prevent Pi from being installed', () => {
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
});
