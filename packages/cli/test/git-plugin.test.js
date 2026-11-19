import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Builds a Git environment that ignores the developer Git config.
 *
 * An empty global and system config file is written under `home`. The author and committer are fixed so trailer checks see a known email.
 *
 * @param {string} home Temporary home directory. The blank Git config is written here.
 * @returns {Record<string, string>} Environment for `git` and for the CLI.
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
 * Runs real Git and returns stdout.
 *
 * A non-zero status fails the test. The helper is for setup, not for the command under test.
 *
 * @param {string[]} args Git arguments, without the `git` word.
 * @param {Record<string, string>} env Environment from {@link gitEnv}.
 * @param {string} cwd Repository directory.
 * @returns {string} Git stdout.
 */
function git(args, env, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * Creates a temporary Git repository with the git plugin enabled.
 *
 * Signing is off. The identity matches {@link gitEnv}. The project settings name the shipped `git` plugin.
 *
 * @returns {{home: string, repo: string, env: Record<string, string>}} The temporary home, the repository directory, and the Git environment.
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
 * Runs the CLI inside a Git fixture repository.
 *
 * Extra environment values can set the model or a command override.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {{repo: string, env: Record<string, string>}} fixture Repository from {@link repository}.
 * @param {Record<string, string>} [extra={}] Environment values merged over the fixture environment.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, fixture, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    env: { ...fixture.env, ...extra },
  });
}

/**
 * Creates a commit that has no attribution trailer and points `HEAD` at it.
 *
 * The push check should refuse this commit when the local committer matches. The commit is built with `commit-tree` so the git plugin does not add a trailer.
 *
 * @param {string} repo Repository directory.
 * @param {Record<string, string>} env Git environment.
 * @param {string} subject Commit subject.
 * @returns {string} Id of the new commit.
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

test('a commit after a supported global option receives a trailer', () => {
  const fixture = repository();

  const committed = run(['hook', '--model', 'Example', '--', 'git', '--no-advice', 'commit', '--quiet', '--allow-empty', '-m', 'global option'], fixture);

  assert.equal(committed.status, 0, committed.stderr);
  assert.match(git(['log', '-1', '--format=%B'], fixture.env, fixture.repo), /AI-Assisted-By: Example via cosplaying/);
});

test('separated Git global options work, and attached -C and -c forms fail closed', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const supported = ['-C', fixture.repo, '-c', 'user.name=Example'];
  const committed = run(['hook', '--model', 'Example', '--', 'git', ...supported, 'commit', '--quiet', '--allow-empty', '-m', 'separated globals'], fixture);
  assert.equal(committed.status, 0, committed.stderr);
  const pushed = run(['hook', '--model', 'Example', '--', 'git', ...supported, 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture);
  assert.equal(pushed.status, 0, pushed.stderr);

  const local = unattributed(fixture.repo, fixture.env, 'Local commit for blocked pushes');
  const remoteHead = git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim();
  for (const option of [`-C${fixture.repo}`, '-cuser.name=Example']) {
    for (const command of ['commit', 'push']) {
      const args = command === 'commit'
        ? [command, '--quiet', '--allow-empty', '-m', 'must not run']
        : [command, '--quiet'];
      const blocked = run(['hook', '--model', 'Example', '--', 'git', option, ...args], fixture);
      assert.equal(blocked.status, 2, blocked.stderr);
      assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
      assert.match(blocked.stderr, /cannot classify the Git command after option/);
    }
  }
  assert.equal(git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim(), local);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim(), remoteHead);
});

test('git version remains available without attribution', () => {
  const fixture = repository();

  const version = run(['hook', '--', 'git', '--version'], fixture);

  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^git version /);
});

test('an unknown leading Git option blocks the command', () => {
  const fixture = repository();

  const blocked = run(['hook', '--model', 'Example', '--', 'git', '--unknown-global-option', 'commit', '--quiet', '--allow-empty', '-m', 'must not run'], fixture);

  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.match(blocked.stderr, /--unknown-global-option/);
  assert.match(blocked.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: fixture.repo, encoding: 'utf8', env: fixture.env });
  assert.notEqual(head.status, 0);
});

test('an option separator cannot hide a commit from the guard', () => {
  const fixture = repository();

  const blocked = run(['hook', '--', 'git', '--', 'commit', '--quiet', '--allow-empty', '-m', 'must not run'], fixture);

  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: fixture.repo, encoding: 'utf8', env: fixture.env });
  assert.notEqual(head.status, 0);
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
  const blocked = run(['hook', '--model', 'Example', '--', 'git', '--no-advice', 'push', '--quiet'], fixture);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.match(blocked.stderr, new RegExp(sha.slice(0, 12)));
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim(), published);
  const allowed = run(['hook', '--', 'git', 'push', '--quiet'], fixture);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main'], fixture.env, fixture.repo).trim(), sha);
});

test('push inspection works with the system Git executable', () => {
  const systemGit = '/usr/bin/git';
  if (!existsSync(systemGit)) return;
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture, { COSPLAYING_GIT_BIN: systemGit });
  assert.equal(pushed.status, 0, pushed.stderr);
  const sha = unattributed(fixture.repo, fixture.env, 'Unattributed system Git commit');
  const blocked = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet'], fixture, { COSPLAYING_GIT_BIN: systemGit });
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, new RegExp(sha.slice(0, 12)));
});

test('fast-forward merge keeps an incoming merge commit unchanged', () => {
  const fixture = repository();
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  git(['checkout', '-q', '-b', 'side'], fixture.env, fixture.repo);
  writeFileSync(path.join(fixture.repo, 'side.txt'), 'side\n');
  git(['add', 'side.txt'], fixture.env, fixture.repo);
  git(['commit', '--quiet', '-m', 'side'], fixture.env, fixture.repo);
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);
  git(['checkout', '-q', '-b', 'incoming'], fixture.env, fixture.repo);
  git(['merge', '--quiet', '--no-ff', '--no-edit', 'side'], fixture.env, fixture.repo);
  const incoming = git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim();
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);

  const merged = run(['hook', '--model', 'Example', '--', 'git', 'merge', '--ff-only', 'incoming'], fixture);

  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim(), incoming);
});

test('merge commit created by Git receives the current model trailer', () => {
  const fixture = repository();
  const base = run(['hook', '--model', 'Base', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  git(['checkout', '-q', '-b', 'feature'], fixture.env, fixture.repo);
  writeFileSync(path.join(fixture.repo, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], fixture.env, fixture.repo);
  const feature = run(['hook', '--model', 'Feature', '--', 'git', 'commit', '--quiet', '-m', 'feature'], fixture);
  assert.equal(feature.status, 0, feature.stderr);
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);

  const merged = run(['hook', '--model', 'Merge', '--', 'git', 'merge', '--quiet', '--no-ff', '--no-edit', 'feature'], fixture);

  assert.equal(merged.status, 0, merged.stderr);
  const body = git(['log', '-1', '--format=%B'], fixture.env, fixture.repo);
  assert.match(body, /AI-Assisted-By: Merge via cosplaying/);
});

test('pull --rebase=false preserves the local commit and attributes only the merge', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  git(['config', 'pull.ff', 'false'], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Base', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const baseSha = git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim();
  const pushedBase = run(['hook', '--model', 'Base', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture);
  assert.equal(pushedBase.status, 0, pushedBase.stderr);
  const local = run(['hook', '--model', 'Local', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'local'], fixture);
  assert.equal(local.status, 0, local.stderr);
  const localSha = git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim();
  git(['checkout', '-q', '-b', 'upstream', baseSha], fixture.env, fixture.repo);
  writeFileSync(path.join(fixture.repo, 'remote.txt'), 'remote\n');
  git(['add', 'remote.txt'], fixture.env, fixture.repo);
  git(['commit', '--quiet', '-m', 'remote'], fixture.env, fixture.repo);
  const remoteSha = git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim();
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], fixture.env, fixture.repo);
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);
  git(['fetch', '--quiet', 'origin'], fixture.env, fixture.repo);

  const pulled = run(['hook', '--model', 'Merge', '--', 'git', 'pull', '--quiet', '--rebase=false'], fixture);

  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(git(['rev-parse', 'HEAD^1'], fixture.env, fixture.repo).trim(), localSha);
  assert.equal(git(['rev-parse', 'HEAD^2'], fixture.env, fixture.repo).trim(), remoteSha);
  assert.match(git(['log', '-1', '--format=%B'], fixture.env, fixture.repo), /AI-Assisted-By: Merge via cosplaying/);
});

test('push to a new remote checks commits known only to another remote', () => {
  const fixture = repository();
  const known = path.join(fixture.home, 'known.git');
  const destination = path.join(fixture.home, 'destination.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', known], fixture.env, fixture.repo);
  git(['init', '--quiet', '--bare', '--initial-branch=main', destination], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', known], fixture.env, fixture.repo);
  git(['remote', 'add', 'destination', destination], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const publishedBase = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture);
  assert.equal(publishedBase.status, 0, publishedBase.stderr);
  const sha = unattributed(fixture.repo, fixture.env, 'Known to another remote');
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/known'], fixture.env, fixture.repo);
  git(['fetch', '--quiet', 'origin'], fixture.env, fixture.repo);

  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'destination', 'HEAD:refs/heads/new'], fixture);

  assert.equal(pushed.status, 2);
  assert.match(pushed.stderr, /BLOCKED \(command not run\)/);
  assert.match(pushed.stderr, new RegExp(sha.slice(0, 12)));
  const remoteRef = git(['--git-dir', destination, 'for-each-ref', '--format=%(refname)', 'refs/heads/new'], fixture.env, fixture.repo);
  assert.equal(remoteRef, '');
});

test('push ignores advertised remote commits that are not in the local object database', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Base', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  git(['push', '--quiet', '--set-upstream', 'origin', 'main'], fixture.env, fixture.repo);

  const foreign = path.join(fixture.home, 'foreign');
  mkdirSync(foreign);
  git(['init', '--quiet', '--initial-branch=main'], fixture.env, foreign);
  git(['config', 'user.name', 'Cosplaying Test'], fixture.env, foreign);
  git(['config', 'user.email', 'test@example.com'], fixture.env, foreign);
  writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign\n');
  git(['add', 'foreign.txt'], fixture.env, foreign);
  git(['commit', '--quiet', '-m', 'foreign'], fixture.env, foreign);
  git(['push', '--quiet', remote, 'HEAD:refs/pull/1/merge'], fixture.env, foreign);

  const local = run(['hook', '--model', 'Local', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'local'], fixture);
  assert.equal(local.status, 0, local.stderr);
  const localSha = git(['rev-parse', 'HEAD'], fixture.env, fixture.repo).trim();
  const pushed = run(['hook', '--model', 'Pusher', '--', 'git', 'push', '--quiet'], fixture);

  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], fixture.env, fixture.repo).trim(), localSha);
});

test('push checks configured push urls instead of the fetch url', () => {
  const fixture = repository();
  const fetchRemote = path.join(fixture.home, 'fetch.git');
  const pushRemote = path.join(fixture.home, 'push.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', fetchRemote], fixture.env, fixture.repo);
  git(['init', '--quiet', '--bare', '--initial-branch=main', pushRemote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', fetchRemote], fixture.env, fixture.repo);
  git(['remote', 'set-url', '--push', 'origin', pushRemote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const sha = unattributed(fixture.repo, fixture.env, 'Known at fetch url only');
  git(['push', '--quiet', fetchRemote, 'HEAD:refs/heads/known'], fixture.env, fixture.repo);
  git(['fetch', '--quiet', 'origin'], fixture.env, fixture.repo);

  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'origin', 'HEAD:refs/heads/new'], fixture);

  assert.equal(pushed.status, 2);
  assert.match(pushed.stderr, new RegExp(sha.slice(0, 12)));
  const remoteRef = git(['--git-dir', pushRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads/new'], fixture.env, fixture.repo);
  assert.equal(remoteRef, '');
});

test('push checks every configured push url', () => {
  const fixture = repository();
  const fetchRemote = path.join(fixture.home, 'fetch.git');
  const knownPushRemote = path.join(fixture.home, 'known-push.git');
  const emptyPushRemote = path.join(fixture.home, 'empty-push.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', fetchRemote], fixture.env, fixture.repo);
  git(['init', '--quiet', '--bare', '--initial-branch=main', knownPushRemote], fixture.env, fixture.repo);
  git(['init', '--quiet', '--bare', '--initial-branch=main', emptyPushRemote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', fetchRemote], fixture.env, fixture.repo);
  git(['remote', 'set-url', '--push', 'origin', knownPushRemote], fixture.env, fixture.repo);
  git(['remote', 'set-url', '--add', '--push', 'origin', emptyPushRemote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const sha = unattributed(fixture.repo, fixture.env, 'Known at one push url');
  git(['push', '--quiet', knownPushRemote, 'HEAD:refs/heads/known'], fixture.env, fixture.repo);

  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'origin', 'HEAD:refs/heads/new'], fixture);

  assert.equal(pushed.status, 2);
  assert.match(pushed.stderr, new RegExp(sha.slice(0, 12)));
  const remoteRef = git(['--git-dir', emptyPushRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads/new'], fixture.env, fixture.repo);
  assert.equal(remoteRef, '');
});

test('push inspects configured remote refspecs before sending them', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const pushedBase = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture);
  assert.equal(pushedBase.status, 0, pushedBase.stderr);
  git(['checkout', '-q', '-b', 'other'], fixture.env, fixture.repo);
  const sha = unattributed(fixture.repo, fixture.env, 'Unattributed other branch');
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);
  git(['config', '--add', 'remote.origin.push', 'refs/heads/other:refs/heads/published'], fixture.env, fixture.repo);

  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'origin'], fixture);

  assert.equal(pushed.status, 2);
  assert.match(pushed.stderr, /BLOCKED \(command not run\)/);
  assert.match(pushed.stderr, new RegExp(sha.slice(0, 12)));
  const remoteRef = git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/published'], fixture.env, fixture.repo);
  assert.equal(remoteRef, '');
});

test('push blocks the matching refspec because it can publish other branches', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'origin', ':'], fixture);

  assert.equal(pushed.status, 2);
  assert.match(pushed.stderr, /BLOCKED \(command not run\)/);
  assert.match(pushed.stderr, /matching push refspecs/);
  assert.equal(git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)'], fixture.env, fixture.repo), '');
});

test('push handles large remote ref lists, excludes published commits, and blocks unpublished commits', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Base', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  git(['push', '--quiet', '--set-upstream', 'origin', 'main'], fixture.env, fixture.repo);
  const sha = unattributed(fixture.repo, fixture.env, 'Already on another remote branch');
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/known'], fixture.env, fixture.repo);
  const refs = Array.from({ length: 16000 }, (_, index) => `create refs/heads/published-history-${String(index).padStart(5, '0')}-branch ${sha}`).join('\n');
  const created = spawnSync('git', ['--git-dir', remote, 'update-ref', '--stdin'], {
    cwd: fixture.repo, env: fixture.env, encoding: 'utf8', input: `${refs}\n`,
  });
  assert.equal(created.status, 0, created.stderr);
  const advertised = spawnSync('git', ['ls-remote', '--refs', remote], {
    cwd: fixture.repo, env: fixture.env, encoding: 'utf8', maxBuffer: Infinity,
  });
  assert.equal(advertised.status, 0, advertised.stderr);
  assert.ok(Buffer.byteLength(advertised.stdout) > 1024 * 1024);

  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'origin', 'HEAD:refs/heads/new'], fixture);

  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.stdout, '');
  assert.equal(pushed.stderr, '');
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/new'], fixture.env, fixture.repo).trim(), sha);

  const unpublished = unattributed(fixture.repo, fixture.env, 'Not on the selected remote');
  const blocked = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', 'origin', 'HEAD:refs/heads/new'], fixture);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.stdout, '');
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.match(blocked.stderr, new RegExp(unpublished.slice(0, 12)));
  assert.doesNotMatch(blocked.stderr, new RegExp(sha.slice(0, 12)));
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/new'], fixture.env, fixture.repo).trim(), sha);
});

test('push blocks matching branches when another branch has no trailer', () => {
  const fixture = repository();
  const remote = path.join(fixture.home, 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], fixture.env, fixture.repo);
  git(['remote', 'add', 'origin', remote], fixture.env, fixture.repo);
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  const pushedMain = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], fixture);
  assert.equal(pushedMain.status, 0, pushedMain.stderr);
  git(['checkout', '-q', '-b', 'other'], fixture.env, fixture.repo);
  const otherBase = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'other base'], fixture);
  assert.equal(otherBase.status, 0, otherBase.stderr);
  const pushedOther = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet', '--set-upstream', 'origin', 'other'], fixture);
  assert.equal(pushedOther.status, 0, pushedOther.stderr);
  const published = git(['--git-dir', remote, 'rev-parse', 'other'], fixture.env, fixture.repo).trim();
  unattributed(fixture.repo, fixture.env, 'Unattributed other branch');
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);
  git(['config', 'push.default', 'matching'], fixture.env, fixture.repo);

  const pushed = run(['hook', '--model', 'Example', '--', 'git', 'push', '--quiet'], fixture);

  assert.equal(pushed.status, 2);
  assert.match(pushed.stderr, /BLOCKED \(command not run\)/);
  assert.match(pushed.stderr, /push\.default=matching/);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'other'], fixture.env, fixture.repo).trim(), published);
});

test('merge inspection failure is reported after Git completes', () => {
  const fixture = repository();
  const base = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'base'], fixture);
  assert.equal(base.status, 0, base.stderr);
  git(['checkout', '-q', '-b', 'feature'], fixture.env, fixture.repo);
  const feature = run(['hook', '--model', 'Example', '--', 'git', 'commit', '--quiet', '--allow-empty', '-m', 'feature'], fixture);
  assert.equal(feature.status, 0, feature.stderr);
  git(['checkout', '-q', 'main'], fixture.env, fixture.repo);
  const hook = path.join(fixture.repo, '.git', 'hooks', 'post-merge');
  writeFileSync(hook, `#!/bin/sh\nsha=$(git rev-parse HEAD) || exit 1\nobjects=$(git rev-parse --git-path objects)\nprefix=$(printf '%s' "$sha" | cut -c1-2)\nsuffix=$(printf '%s' "$sha" | cut -c3-)\nrm -f "$objects/$prefix/$suffix"\n`);
  chmodSync(hook, 0o755);

  const merged = run(['hook', '--model', 'Example', '--', 'git', 'merge', '--no-ff', '--no-edit', 'feature'], fixture);

  assert.equal(merged.status, 2);
  assert.match(merged.stderr, /Attribution repair failed/);
  assert.match(merged.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
});
