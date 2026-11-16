import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * @param {string} home
 */
function gitEnv(home) {
  const blank = path.join(home, 'gitconfig');
  writeFileSync(blank, '');
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: process.env.PATH || '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: blank,
    GIT_CONFIG_SYSTEM: blank,
    GIT_AUTHOR_NAME: 'Cosplaying Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Cosplaying Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} cwd
 */
function git(args, env, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * @returns {{home: string, repo: string, env: Record<string, string>}}
 */
function repository() {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'cosplaying-repo-'));
  const env = gitEnv(home);
  git(['init', '--quiet', '--initial-branch=main'], env, repo);
  git(['config', 'user.name', 'Cosplaying Test'], env, repo);
  git(['config', 'user.email', 'test@example.com'], env, repo);
  git(['config', 'commit.gpgsign', 'false'], env, repo);
  writeFileSync(path.join(repo, '.cosplaying.json'), `${JSON.stringify({ plugins: ['git'] })}\n`);
  return { home, repo, env };
}

/**
 * @param {string[]} args
 * @param {{repo: string, env: Record<string, string>}} fixture
 * @param {Record<string, string>} [extra]
 */
function run(args, fixture, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    env: { ...fixture.env, ...extra },
  });
}

/**
 * @param {string} repo
 * @param {Record<string, string>} env
 * @param {string} subject
 */
function unattributed(repo, env, subject) {
  const parent = git(['rev-parse', 'HEAD'], env, repo).trim();
  const tree = git(['write-tree'], env, repo).trim();
  const sha = git(['commit-tree', tree, '-p', parent, '-m', subject], env, repo).trim();
  git(['update-ref', 'HEAD', sha, parent], env, repo);
  return sha;
}

test('commit adds a trailer, amend replaces it, and a missing model does not commit', () => {
  const fixture = repository();
  const message = path.join(fixture.repo, 'message.txt');
  const original = 'Commit subject\n\nCommit details.\n';
  writeFileSync(message, original);
  const committed = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-F', message], fixture);
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(readFileSync(message, 'utf8'), original);
  let body = git(['log', '-1', '--format=%B'], fixture.env, fixture.repo);
  assert.match(body, /Commit subject/);
  assert.match(body, /AI-Assisted-By: Example via cosplaying/);
  const amended = run(['hook', '--model', 'Other', '--', 'git', 'commit', '--quiet', '--allow-empty', '--amend', '--no-edit'], fixture);
  assert.equal(amended.status, 0, amended.stderr);
  body = git(['log', '-1', '--format=%B'], fixture.env, fixture.repo);
  assert.match(body, /AI-Assisted-By: Other via cosplaying/);
  assert.doesNotMatch(body, /AI-Assisted-By: Example/);
  assert.equal((body.match(/AI-Assisted-By:/g) || []).length, 1);
  const head = git(['rev-parse', 'HEAD'], fixture.env, fixture.repo);
  const blocked = run(['hook', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'no model'], fixture);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.match(blocked.stderr, /COSPLAYING_MODEL/);
  assert.equal(git(['rev-parse', 'HEAD'], fixture.env, fixture.repo), head);
  const status = run(['hook', '--', 'git', 'status', '--porcelain'], fixture);
  assert.equal(status.status, 0, status.stderr);
});

test('cherry-pick keeps the existing trailer and adds the current model', () => {
  const fixture = repository();
  const base = run(['hook', '--model', 'Source', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  git(['checkout', '-q', '-b', 'feature'], fixture.env, fixture.repo);
  writeFileSync(path.join(fixture.repo, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], fixture.env, fixture.repo);
  const feature = run(['hook', '--model', 'Source', '--', 'git', 'commit', '--quiet', '-m', 'feature'], fixture);
  assert.equal(feature.status, 0, feature.stderr);
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);
  const picked = run(['hook', '--model', 'Replay', '--', 'git', 'cherry-pick', '--quiet', 'feature'], fixture);
  assert.equal(picked.status, 0, picked.stderr);
  const body = git(['log', '-1', '--format=%B'], fixture.env, fixture.repo);
  assert.match(body, /AI-Assisted-By: Source via cosplaying/);
  assert.match(body, /AI-Assisted-By: Replay via cosplaying/);
});

test('push blocks an unattributed local commit when a model is set', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const committed = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(committed.status, 0, committed.stderr);
  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture);
  assert.equal(pushed.status, 0, pushed.stderr);
  const published = git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim();
  const sha = unattributed(fixture.repo, fixture.env, 'Unattributed local commit');
  const blocked = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet'], fixture);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.match(blocked.stderr, new RegExp(sha.slice(0, 12)));
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim(), published);
  const allowed = run(['hook', '--', 'git', 'push', '--quiet'], fixture);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim(), sha);
});
