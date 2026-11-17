import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeSpawnStub } from './spawn-stub.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * @returns {{home: string, cwd: string, log: string, env: Record<string, string>}}
 */
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  const binDir = path.join(home, 'bin');
  const log = path.join(home, 'gh-log');
  mkdirSync(binDir);
  const script = path.join(binDir, 'gh');
  const shell = `#!/bin/sh
printf '%s\\n' "$@" > "$GH_LOG"
for arg in "$@"; do
  if [ -f "$arg" ]; then
    printf '\\n--file %s--\\n' "$arg" >> "$GH_LOG"
    cat "$arg" >> "$GH_LOG"
  fi
done
exit 0
`;
  const ghBin = writeSpawnStub(script, shell, {
    log,
    logLines: 'true',
    overwriteLog: 'true',
    fileArgs: 'true',
  });
  writeFileSync(path.join(cwd, '.cosplaying.json'), `${JSON.stringify({ plugins: ['gh'] })}\n`);
  return {
    home,
    cwd,
    log,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`,
      GH_LOG: log,
      COSPLAYING_GH_BIN: ghBin,
    },
  };
}

/**
 * @param {string[]} args
 * @param {ReturnType<typeof fixture>} context
 * @param {Record<string, string>} [extra]
 */
function run(args, context, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: context.cwd,
    encoding: 'utf8',
    env: { ...context.env, ...extra },
  });
}

test('gh text writes gain a byline and leave the source file unchanged', () => {
  const context = fixture();
  const created = run(['hook', '--model', 'Example', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body', 'The change is ready.'], context);
  assert.equal(created.status, 0, created.stderr);
  const inline = readFileSync(context.log, 'utf8');
  assert.match(inline, /<!-- cosplaying:attribution -->/);
  assert.match(inline, /Authored by Example via/);
  const source = path.join(context.cwd, 'body.md');
  const original = 'Hello from the file.\n';
  writeFileSync(source, original);
  const filed = run(['hook', '--model', 'Example', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body-file', source], context);
  assert.equal(filed.status, 0, filed.stderr);
  assert.equal(readFileSync(source, 'utf8'), original);
  const logged = readFileSync(context.log, 'utf8');
  assert.match(logged, /<!-- cosplaying:attribution -->/);
  assert.doesNotMatch(logged, new RegExp(`--file ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}--`));
});

test('a write without a model does not run gh, and a read does', () => {
  const context = fixture();
  const blocked = run(['hook', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body', 'Hello'], context);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.equal(existsSync(context.log), false);
  const viewed = run(['hook', '--', 'gh', 'pr', 'view', '1'], context);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.match(readFileSync(context.log, 'utf8'), /pr\nview\n1/);
});

test('workflow and job rerun APIs pass through without content', () => {
  const context = fixture();
  const cliRerun = run(['hook', '--', 'gh', 'run', 'rerun', '42'], context);
  assert.equal(cliRerun.status, 0, cliRerun.stderr);
  assert.match(readFileSync(context.log, 'utf8'), /run\nrerun\n42/);

  const endpoints = [
    'repos/owner/repo/actions/runs/42/rerun',
    'repos/owner/repo/actions/runs/42/rerun-failed-jobs',
    'repos/owner/repo/actions/jobs/7/rerun',
  ];
  for (const endpoint of endpoints) {
    const rerun = run(['hook', '--', 'gh', 'api', '--method', 'POST', endpoint], context);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(readFileSync(context.log, 'utf8'), new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const unsupported = run(['hook', '--', 'gh', 'api', 'repos/owner/repo/dispatches', '-XPOST'], context);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /blocked unsupported mutating gh api request: POST/);

  const comment = run(['hook', '--', 'gh', 'api', '--method', 'POST', 'repos/owner/repo/actions/runs/42/pending_deployments', '-fcomment=Deploy'], context);
  assert.equal(comment.status, 2);
  assert.match(comment.stderr, /COSPLAYING_MODEL|--model/);
});

test('GitHub CLI shorthand values are attributed', () => {
  const context = fixture();

  const apiComment = run(['hook', '--model', 'Example', '--', 'gh', 'api', 'repos/o/r/issues/1/comments', '-XPOST', '-fbody=hello'], context);
  assert.equal(apiComment.status, 0, apiComment.stderr);
  let forwarded = readFileSync(context.log, 'utf8');
  assert.match(forwarded, /-fbody=hello/);
  assert.match(forwarded, /<!-- cosplaying:attribution -->/);
  assert.match(forwarded, /Authored by Example via/);

  const issueEdit = run(['hook', '--model', 'Example', '--', 'gh', 'issue', 'edit', '1', '-bhello'], context);
  assert.equal(issueEdit.status, 0, issueEdit.stderr);
  forwarded = readFileSync(context.log, 'utf8');
  assert.match(forwarded, /-bhello/);
  assert.match(forwarded, /<!-- cosplaying:attribution -->/);
  assert.match(forwarded, /Authored by Example via/);

  const leadingFlagBody = run(['hook', '--model', 'Example', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body', '-b begins with a flag'], context);
  assert.equal(leadingFlagBody.status, 0, leadingFlagBody.stderr);
  forwarded = readFileSync(context.log, 'utf8');
  assert.equal((forwarded.match(/^--body$/gm) || []).length, 1);
  assert.match(forwarded, /-b begins with a flag/);
  assert.match(forwarded, /Authored by Example via/);
});

test('REST pull request merges add a trailer to explicit and default messages', () => {
  const context = fixture();
  const endpoint = 'repos/owner/repo/pulls/23/merge';
  const cases = [
    ['explicit.json', { commit_title: 'Merge change', commit_message: 'Merge details.' }],
    ['default.json', { commit_title: 'Merge change' }],
  ];

  for (const [name, body] of cases) {
    const input = path.join(context.cwd, name);
    const original = `${JSON.stringify(body, null, 2)}\n`;
    writeFileSync(input, original);

    const merged = run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'PUT', endpoint, '--input', input], context);

    assert.equal(merged.status, 0, merged.stderr);
    assert.match(readFileSync(context.log, 'utf8'), /AI-Assisted-By: Example via cosplaying/);
    assert.equal(readFileSync(input, 'utf8'), original);
  }
});

test('an unsupported gh api mutation does not run gh', () => {
  const context = fixture();
  const blocked = run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'repos/owner/name/dispatches'], context);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /blocked unsupported mutating gh api request/);
  assert.match(blocked.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
  assert.equal(existsSync(context.log), false);
});

test('gist file writes need an attributed description and keep the input unchanged', () => {
  const context = fixture();
  const input = path.join(context.cwd, 'gist.json');
  const original = `${JSON.stringify({ files: { 'example.js': { content: 'console.log("hello");' } } }, null, 2)}\n`;
  writeFileSync(input, original);

  const blocked = run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'gists', '--input', input], context);

  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /description/);
  assert.equal(existsSync(context.log), false);
  assert.equal(readFileSync(input, 'utf8'), original);
});

test('gist file writes attribute the description and keep source content unchanged', () => {
  const context = fixture();
  const input = path.join(context.cwd, 'gist.json');
  const original = `${JSON.stringify({ description: 'A small example.', files: { 'example.js': { content: 'console.log("hello");' } } }, null, 2)}\n`;
  writeFileSync(input, original);

  const created = run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'gists', '--input', input], context);

  assert.equal(created.status, 0, created.stderr);
  const forwarded = readFileSync(context.log, 'utf8');
  assert.match(forwarded, /<!-- cosplaying:attribution -->/);
  assert.match(forwarded, /Authored by Example via/);
  assert.match(forwarded, /"content": "console\.log/);
  assert.equal(readFileSync(input, 'utf8'), original);
});

test('gist file removal does not need a description', () => {
  const context = fixture();
  const input = path.join(context.cwd, 'gist.json');
  const original = `${JSON.stringify({ files: { 'old.js': null } }, null, 2)}\n`;
  writeFileSync(input, original);

  const removed = run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'PATCH', 'gists/123', '--input', input], context);

  assert.equal(removed.status, 0, removed.stderr);
  assert.match(readFileSync(context.log, 'utf8'), /"old.js": null/);
  assert.equal(readFileSync(input, 'utf8'), original);
});

test('gist create and edit need an attributed description', () => {
  const context = fixture();

  const created = run(['hook', '--model', 'Example', '--', 'gh', 'gist', 'create', 'example.js'], context);
  assert.equal(created.status, 2);
  assert.match(created.stderr, /needs explicit text/);
  assert.equal(existsSync(context.log), false);

  const edited = run(['hook', '--model', 'Example', '--', 'gh', 'gist', 'edit', 'abc123', '--add', 'example.js'], context);
  assert.equal(edited.status, 2);
  assert.match(edited.stderr, /needs explicit text/);
  assert.equal(existsSync(context.log), false);
});

test('agent task create accepts and attributes a positional description', () => {
  const context = fixture();

  const created = run(['hook', '--model', 'Example', '--', 'gh', 'agent-task', 'create', 'Write a short summary.'], context);

  assert.equal(created.status, 0, created.stderr);
  const forwarded = readFileSync(context.log, 'utf8');
  assert.match(forwarded, /Write a short summary\./);
  assert.match(forwarded, /<!-- cosplaying:attribution -->/);
  assert.match(forwarded, /Authored by Example via/);
});
