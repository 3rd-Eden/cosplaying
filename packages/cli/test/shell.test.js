import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rewriteShellCommand } from '../src/shell.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

test('a route matches the raw word before the basename', () => {
  assert.equal(
    rewriteShellCommand('/opt/homebrew/bin/gh pr view 1', { '/opt/homebrew/bin/gh': 'FULL', gh: 'MP gh' }).command,
    'FULL pr view 1',
  );
});

/**
 * Writes a plugin whose command name is `name` and whose `run` function does nothing.
 *
 * Rewrite tests use these plugins so `git`, `gh`, and `jira` become routes. The plugin does not spawn a real tool.
 *
 * @param {string} directory Directory that will contain the plugin. It is created by this function.
 * @param {string} name Package name and command name.
 * @returns {void} No value. `package.json` and `index.js` are written.
 */
function writeRoutePlugin(directory, name) {
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  })}\n`);
  writeFileSync(path.join(directory, 'index.js'), [
    `export const description = 'Route ${name}';`,
    `export const examples = ['cosplaying hook -- ${name}'];`,
    'export default function run() { return 0; }',
    '',
  ].join('\n'));
}

/**
 * Runs the CLI `rewrite` command in a temporary home.
 *
 * The working directory holds the route plugins and the project settings.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function runRewrite(args, home, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
    },
  });
}

/**
 * Returns the hook prefix that rewrite inserts before one command.
 *
 * The command is run as `<command> SENTINEL`. The sentinel is removed so the result is only the prefix. A non-zero status or unexpected shape fails the test.
 *
 * @param {string} command Command name, for example `git`.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory that contains the route plugins.
 * @returns {string} The rewritten command without the trailing ` SENTINEL`.
 */
function routePrefix(command, home, cwd) {
  const result = runRewrite(['rewrite', '--shell', `${command} SENTINEL`], home, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const suffix = ' SENTINEL\n';
  assert.equal(result.stdout.endsWith(suffix), true, result.stdout);
  const prefix = result.stdout.slice(0, -suffix.length);
  assert.match(prefix, new RegExp(`hook -- ${command}$`));
  return prefix;
}

/**
 * Replaces the placeholder route prefixes in an expected shell string.
 *
 * A function replacement keeps `$` in the real hook prefix literal. String replacement would treat `$` as a pattern.
 *
 * @param {string} expected Shell text that still contains `MP git`, `MP gh`, or `MP jira`.
 * @param {Record<string, string>} prefixes Real prefixes keyed by `git`, `gh`, and `jira`.
 * @returns {string} `expected` with each placeholder replaced by the prefix from this install.
 */
function withRealRoutes(expected, prefixes) {
  // A function replacement keeps `$` in the hook prefix literal.
  return expected
    .replaceAll('MP jira', () => prefixes.jira)
    .replaceAll('MP git', () => prefixes.git)
    .replaceAll('MP gh', () => prefixes.gh);
}

test('rewrite --shell prints the shell corpus, including a quoted heredoc', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-shell-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-shell-cwd-'));
  try {
    const plugins = ['gh', 'git', 'jira'].map((name) => {
      const directory = path.join(cwd, name);
      writeRoutePlugin(directory, name);
      return directory;
    });
    writeFileSync(path.join(cwd, '.cosplaying.json'), `${JSON.stringify({ plugins })}\n`);
    const prefixes = {
      gh: routePrefix('gh', home, cwd),
      git: routePrefix('git', home, cwd),
      jira: routePrefix('jira', home, cwd),
    };

    /**
     * @param {string} input
     * @param {string} expected
     */
    function expectShell(input, expected) {
      const result = runRewrite(['rewrite', '--shell', input], home, cwd);
      assert.equal(result.status, 0, `${input}\n${result.stderr}`);
      assert.equal(result.stderr, '', input);
      assert.equal(result.stdout, `${withRealRoutes(expected, prefixes)}\n`, input);
    }

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
    for (const [input, expected] of cases) expectShell(input, expected);

    const quoted = readFileSync(new URL('./fixtures/quoted-heredoc.sh', import.meta.url), 'utf8');
    expectShell(quoted, quoted.replace('gh issue create --body-file note.md', 'MP gh issue create --body-file note.md'));
    const literal = "cat > note.md <<'EOF'\ngh pr create is how we open PRs.\nEOF\n";
    expectShell(literal, literal);

    const unquoted = 'cat > note.md <<EOF\nPR: $(gh pr view 1)\nEOF\ngh issue create --body-file note.md\n';
    expectShell(
      unquoted,
      'cat > note.md <<EOF\nPR: $(MP gh pr view 1)\nEOF\nMP gh issue create --body-file note.md\n',
    );

    const rtkCases = [
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
    for (const [input, expected] of rtkCases) expectShell(input, expected);

    expectShell('gh pr view 1 &&', 'MP gh pr view 1 &&');
    const backtick = 'echo `echo \\$HOME; gh pr view 1`\n';
    expectShell(backtick, backtick);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
