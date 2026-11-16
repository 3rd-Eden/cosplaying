import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rewriteModelFlags, rewriteShellCommand } from '../src/shell.js';

const routes = { gh: 'MP gh', git: 'MP git' };
const rtk = { gh: 'MP gh', git: 'MP git', jira: 'MP jira' };

test('rewrites wrapped commands and leaves data, comments, and constructors unchanged', () => {
  const cases = [
    ['cd /tmp && gh pr create --body-file f.md', 'cd /tmp && MP gh pr create --body-file f.md'],
    ['echo a; gh issue comment 1 -b x\ngit commit -m y', 'echo a; MP gh issue comment 1 -b x\nMP git commit -m y'],
    ['(cd w && gh pr create --body-file f.md)', '(cd w && MP gh pr create --body-file f.md)'],
    ['url=$(gh pr create --body-file f.md)', 'url=$(MP gh pr create --body-file f.md)'],
    ['echo "$(gh pr view 1 --json url)"', 'echo "$(MP gh pr view 1 --json url)"'],
    ['echo ${url:-$(gh pr view 1)}', 'echo ${url:-$(MP gh pr view 1)}'],
    ['url=`gh pr create --body-file f.md`', 'url=`MP gh pr create --body-file f.md`'],
    ['/opt/homebrew/bin/gh pr view 1', 'MP gh pr view 1'],
    ['GH_REPO=o/r command gh pr create', 'GH_REPO=o/r command MP gh pr create'],
    ['/usr/bin/env GH_REPO=o/r gh pr create', '/usr/bin/env GH_REPO=o/r MP gh pr create'],
    ['if true; then gh pr create --body-file f.md; fi', 'if true; then MP gh pr create --body-file f.md; fi'],
    ['for n in 1; do gh issue comment $n -b x; done', 'for n in 1; do MP gh issue comment $n -b x; done'],
    ['time gh pr create --body-file f.md', 'time MP gh pr create --body-file f.md'],
    ['! gh pr create --body-file f.md', '! MP gh pr create --body-file f.md'],
    ['echo 1 | xargs gh issue close', 'echo 1 | xargs MP gh issue close'],
    ["echo 'run gh pr create later'", "echo 'run gh pr create later'"],
    ['constructor --version', 'constructor --version'],
    ["# don't forget the runbook\ngh issue create --body-file f.md", "# don't forget the runbook\nMP gh issue create --body-file f.md"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(rewriteShellCommand(input, routes).command, expected, input);
  }
});

test('quoted heredoc text stays literal and the following command is rewritten', () => {
  const input = readFileSync(new URL('./fixtures/quoted-heredoc.sh', import.meta.url), 'utf8');
  const expected = input.replace('gh issue create --body-file note.md', 'MP gh issue create --body-file note.md');
  assert.equal(rewriteShellCommand(input, routes).command, expected);
  const line = "cat > note.md <<'EOF'\ngh pr create is how we open PRs.\nEOF\n";
  assert.equal(rewriteShellCommand(line, routes).command, line);
});

test('unquoted heredoc substitutions and the following command are rewritten', () => {
  const input = 'cat > note.md <<EOF\nPR: $(gh pr view 1)\nEOF\ngh issue create --body-file note.md\n';
  const expected = 'cat > note.md <<EOF\nPR: $(MP gh pr view 1)\nEOF\nMP gh issue create --body-file note.md\n';
  assert.equal(rewriteShellCommand(input, routes).command, expected);
});

test('rtk gets a proxy segment unless proxy is already present', () => {
  const cases = [
    ['rtk gh issue view 1', 'rtk proxy MP gh issue view 1'],
    ['rtk proxy /opt/homebrew/bin/gh issue view 1', 'rtk proxy MP gh issue view 1'],
    ['rtk git commit -m "example"', 'rtk proxy MP git commit -m "example"'],
    ['rtk proxy gh issue view 1', 'rtk proxy MP gh issue view 1'],
    ['rtk proxy git commit -m "example"', 'rtk proxy MP git commit -m "example"'],
    ['rtk --ultra-compact gh issue view 1 && rtk proxy jira issue create', 'rtk --ultra-compact proxy MP gh issue view 1 && rtk proxy MP jira issue create'],
    ['rtk run "gh issue view 1"', 'rtk run "gh issue view 1"'],
    ['echo gh issue view 1', 'echo gh issue view 1'],
    ['sudo -u root gh pr view 1', 'sudo -u root MP gh pr view 1'],
    ['sudo --user root gh pr view 1', 'sudo --user root MP gh pr view 1'],
    ['env -u FOO gh pr view 1', 'env -u FOO MP gh pr view 1'],
    ['xargs -n 1 gh issue close', 'xargs -n 1 MP gh issue close'],
    ['xargs -n1 gh issue close', 'xargs -n1 MP gh issue close'],
    ['time -f "%e" gh pr view 1', 'time -f "%e" MP gh pr view 1'],
    ['exec -a gh gh pr view 1', 'exec -a gh MP gh pr view 1'],
    ['sudo -u root -- gh pr view 1', 'sudo -u root -- MP gh pr view 1'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(rewriteShellCommand(input, rtk).command, expected, input);
  }
});

test('a route matches the raw word before the basename', () => {
  assert.equal(
    rewriteShellCommand('/opt/homebrew/bin/gh pr view 1', { '/opt/homebrew/bin/gh': 'FULL', gh: 'MP gh' }).command,
    'FULL pr view 1',
  );
});

test('a harness-label model flag is replaced only when the real model is known', () => {
  const input = `node /usr/local/bin/main.js hook --model 'Claude Code' -- gh pr view 1`;
  const rewritten = rewriteModelFlags(input, 'Example Model');
  assert.match(rewritten, /--model-base64 /);
  assert.doesNotMatch(rewritten, /Claude Code/);
  assert.equal(rewriteModelFlags(input, 'Claude Code'), input);
  assert.equal(rewriteModelFlags(`node /usr/local/bin/main.js hook --model 'gpt-5' -- gh`, 'Example Model'), `node /usr/local/bin/main.js hook --model 'gpt-5' -- gh`);
});

test('malformed scripts rewrite only recovered commands', () => {
  assert.equal(rewriteShellCommand('gh pr view 1 &&', routes).command, 'MP gh pr view 1 &&');
});

test('a backtick body with backslash escapes is left unchanged', () => {
  const input = 'echo `echo \\$HOME; gh pr view 1`\n';
  assert.equal(rewriteShellCommand(input, routes).command, input);
});
