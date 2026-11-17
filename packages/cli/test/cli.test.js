import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeSamplePlugin } from './sample-plugin.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Creates a temporary home, a Git working tree, and a byline plugin for one CLI test.
 *
 * The test callback deletes both directories when it finishes.
 *
 * @param {import('node:test').TestContext} t Test context. Its `after` hook removes the temporary directories.
 * @returns {{home: string, cwd: string, plugin: string, config: string}} Paths for the home, the working tree, the plugin directory, and the project settings file.
 */
function isolated(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-cli-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cli-cwd-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  mkdirSync(path.join(cwd, '.git'));
  const plugin = path.join(cwd, 'byline');
  mkdirSync(plugin);
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'byline', version: '1.0.0', type: 'module', main: './index.js' }));
  writeFileSync(path.join(plugin, 'index.js'), `export const description = 'Show the plugin context';
export const examples = ['cosplaying hook --model "Example" -- byline'];
export default async function run(args, context) {
  if (args.includes('--message')) {
    const trailer = context.attribution.renderTrailer();
    const child = await context.spawn(process.execPath, ['-e', 'process.stdout.write(process.env.COSPLAYING_INSIDE_HOOK + "\\\\n" + process.argv[1])', trailer], {
      cwd: context.cwd, env: context.env, stdio: 'inherit',
    });
    return child.status;
  }
  context.stdout.write(JSON.stringify({ args, model: context.model }));
  return 0;
}
`);
  const config = path.join(cwd, '.cosplaying.json');
  writeFileSync(config, JSON.stringify({ plugins: [plugin] }));
  return { home, cwd, plugin, config };
}

/**
 * Runs the cosplaying CLI in an isolated home and working directory.
 *
 * `PATH` is empty so the test does not call a developer executable. The byline override points at the fixture plugin.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {{home: string, cwd: string, plugin: string}} context Paths from {@link isolated}.
 * @param {string} [input] Text written to the CLI stdin.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function runCli(args, context, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: context.cwd,
    input,
    encoding: 'utf8',
    env: { HOME: context.home, USERPROFILE: context.home, PATH: '', COSPLAYING_BYLINE_BIN: path.join(context.plugin, 'index.js') },
  });
}

test('version and help show the CLI and configured plugin', (t) => {
  const context = isolated(t);
  const version = runCli(['--version'], context);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(version.stderr, '');
  const help = runCli(['--help'], context);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: cosplaying/);
  assert.match(help.stdout, /byline {2}Show the plugin context/);
  assert.match(help.stdout, /^    cosplaying hook --model "Example" -- byline$/m);
  assert.equal(help.stderr, '');
});

test('a plugin receives hook arguments, model, and the child environment', (t) => {
  const context = isolated(t);
  const read = runCli(['hook', '--', 'byline', '--list'], context);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { args: ['--list'], model: '' });
  const write = runCli(['hook', '--model', 'Example', '--', 'byline', '--message', 'text'], context);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.stdout, '1\nAI-Assisted-By: Example via cosplaying (https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.');
  assert.equal(write.stderr, '');

  const blockedPlugin = writeSamplePlugin(path.join(context.home, 'blocked-plugin'));
  writeFileSync(context.config, JSON.stringify({ plugins: [blockedPlugin] }));
  const blocked = runCli(['hook', '--', 'byline', '--message', 'text'], context);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.stdout, '');
  assert.equal(blocked.stderr, 'cosplaying: BLOCKED (command not run)\nReason: byline --message writes text and needs a model. Pass --model <name> or set COSPLAYING_MODEL.\nIf no safe correction is stated, stop and ask the user; do not bypass cosplaying.\n');
});

test('agent-hook reads stdin, reuses the saved model, and preserves each response protocol', (t) => {
  const context = isolated(t);
  const session = runCli(['agent-hook', 'claude-code', 'SessionStart'], context, JSON.stringify({ session_id: 'abc', model: 'Example Model' }));
  assert.equal(session.status, 0, session.stderr);
  assert.match(session.stdout, /ASD-STE100/);
  const pre = runCli(['agent-hook', 'claude-code', 'PreToolUse'], context, JSON.stringify({ session_id: 'abc', tool_name: 'Bash', tool_input: { command: 'byline --list' } }));
  assert.equal(pre.status, 0, pre.stderr);
  const payload = JSON.parse(pre.stdout).hookSpecificOutput;
  assert.equal(payload.permissionDecision, 'allow');
  const encoded = payload.updatedInput.command.match(/hook --model-base64 (\S+) -- byline --list$/)[1];
  assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), 'Example Model');
  for (const [tool_input, expected] of [[{ command: 'echo hi' }, { permission: 'allow' }], [{}, { permission: 'deny' }]]) {
    const result = runCli(['agent-hook', 'cursor', 'preToolUse'], context, JSON.stringify({ tool_name: 'Shell', tool_input }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).permission, expected.permission);
    if (expected.permission === 'allow') assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  const invalid = runCli(['agent-hook', 'cursor', 'preToolUse'], context, '{');
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /invalid hook input/);
  const codex = runCli(['agent-hook', 'codex', 'PreToolUse'], context, JSON.stringify({ toolName: 'exec_command', toolInput: { cmd: 'byline --list', cwd: '/work' } }));
  assert.equal(codex.status, 0, codex.stderr);
  const updated = JSON.parse(codex.stdout).hookSpecificOutput;
  assert.equal(updated.permissionDecision, 'allow');
  assert.match(updated.updatedInput.cmd, /hook --model-base64 \S+ -- byline --list$/);
  assert.equal(updated.updatedInput.cwd, '/work');
});

test('hook order repair denies the command and a lookalike stays unchanged', (t) => {
  const context = isolated(t);
  const installed = runCli(['install', '--harness', 'claude-code'], context);
  assert.equal(installed.status, 0, installed.stderr);
  const file = path.join(context.home, '.claude', 'settings.json');
  for (const command of ['rtk hook claude', 'node /usr/bin/main.js agent-hook claude-code PreToolUse']) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    parsed.hooks.PreToolUse.push({ hooks: [{ type: 'command', command }] });
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
    if (command.startsWith('node')) {
      const session = runCli(['agent-hook', 'claude-code', 'SessionStart'], context, '{}');
      assert.equal(session.status, 0, session.stderr);
      assert.match(session.stdout, /ASD-STE100/);
      assert.match(session.stdout, /could not be verified/);
      assert.match(session.stdout, /denied/);
      assert.equal(session.stdout.includes(file), true);
    }
    const pre = runCli(['agent-hook', 'claude-code', 'PreToolUse'], context, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'byline --list' } }));
    assert.equal(pre.status, 0, pre.stderr);
    const payload = JSON.parse(pre.stdout).hookSpecificOutput;
    assert.equal(payload.permissionDecision, 'deny');
    assert.match(payload.permissionDecisionReason, /not run/);
    const after = readFileSync(file, 'utf8');
    assert.equal(after.includes(command), true);
    assert.match(after, /# cosplaying:claude-code/);
    if (command.startsWith('rtk')) assert.equal(after.lastIndexOf('# cosplaying:claude-code') > after.lastIndexOf(command), true);
  }
});

test('session config fills the executable, harness label, and sorted commands', (t) => {
  const context = isolated(t);
  writeFileSync(context.config, JSON.stringify({ plugins: [context.plugin, 'gh'], attribution: { templates: { session: '{harness}|{commands}|{executable}' } } }));
  const result = runCli(['agent-hook', 'cursor', 'sessionStart'], context, '{}');
  assert.equal(result.status, 0, result.stderr);
  const prompt = JSON.parse(result.stdout).additional_context;
  assert.match(prompt, /^Cursor\|byline, gh\|/);
  assert.equal(prompt.includes(process.execPath), true);
  assert.match(prompt, /main\.js["']$/);
  writeFileSync(context.config, JSON.stringify({ plugins: [], attribution: { templates: { session: 'SHOULD NOT APPEAR' } } }));
  const empty = runCli(['agent-hook', 'cursor', 'sessionStart'], context, '{}');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).additional_context, 'No cosplaying plugins are installed. Do not invent wrapped commands. Write authored text in ASD-STE100 Simplified Technical English.');

});

test('invalid install and doctor flags report parser errors without writes', (t) => {
  const context = isolated(t);
  for (const [args, flag] of [[['doctor', '--nope'], '--nope'], [['install', '--project-dir'], 'project-dir']]) {
    const result = runCli(args, context);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(flag), true);
    assert.match(result.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
    assert.equal(existsSync(path.join(context.cwd, 'true')), false);
  }
});
