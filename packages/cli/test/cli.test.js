import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const application = path.join(plugin, 'save-note.mjs');
  writeFileSync(application, "import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], process.argv[3]);\nprocess.stdout.write(readFileSync(process.argv[2], 'utf8'));\n");
  copyFileSync(process.execPath, path.join(plugin, process.platform === 'win32' ? 'node.exe' : 'node'));
  writeFileSync(path.join(cwd, 'manual.txt'), 'Saved note.\n');
  writeFileSync(path.join(plugin, 'index.js'), `import { readFileSync } from 'node:fs';
import path from 'node:path';
export const description = 'Save notes by model';
export const examples = ['cosplaying hook --model "Example" -- byline'];
export default async function run(args, context) {
  const note = path.join(context.cwd, (context.model || 'manual') + '.txt');
  if (args.includes('--list')) {
    context.stdout.write(readFileSync(note, 'utf8'));
    return 0;
  }
  const message = args.indexOf('--message');
  if (message < 0) return 0;
  const text = args[message + 1] + '\\n' + context.attribution.renderTrailer() + '\\n';
  const child = await context.spawn(process.execPath, [
    ${JSON.stringify(bin)}, 'hook', '--model', context.model, '--', 'byline',
    ${JSON.stringify(application)}, note, text,
  ], { cwd: context.cwd, env: context.env, stdio: 'inherit' });
  return child.status;
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
    env: { HOME: context.home, USERPROFILE: context.home, PATH: '', COSPLAYING_BYLINE_BIN: path.join(context.plugin, process.platform === 'win32' ? 'node.exe' : 'node') },
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
  assert.match(help.stdout, /byline {2}Save notes by model/);
  assert.match(help.stdout, /^    cosplaying hook --model "Example" -- byline$/m);
  assert.equal(help.stderr, '');
});

test('a plugin saves the note under its model and the child hook does not attribute it twice', (t) => {
  const context = isolated(t);
  const read = runCli(['hook', '--', 'byline', '--list'], context);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, 'Saved note.\n');
  assert.equal(readFileSync(path.join(context.cwd, 'manual.txt'), 'utf8'), 'Saved note.\n');
  const write = runCli(['hook', '--model', 'Example', '--', 'byline', '--message', 'text'], context);
  assert.equal(write.status, 0, write.stderr);
  const expected = 'text\nAI-Assisted-By: Example via cosplaying (https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.\n';
  assert.equal(write.stdout, expected);
  assert.equal(readFileSync(path.join(context.cwd, 'Example.txt'), 'utf8'), expected);
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

test('configured session prompts replace the built-in session and empty text', (t) => {
  const context = isolated(t);
  writeFileSync(context.config, JSON.stringify({
    plugins: [context.plugin],
    link: 'https://example.com/a(b)',
    variables: { team: 'Docs' },
    prompts: {
      session: '{harness}|{commands}|{team}|{link}|{model}|{executable}',
      empty: 'NOT THE EMPTY PROMPT',
    },
    attribution: { templates: { session: 'OLD SESSION' } },
  }));
  const result = runCli(['agent-hook', 'cursor', 'sessionStart'], context, JSON.stringify({ model: 'Claude *Code*' }));
  assert.equal(result.status, 0, result.stderr);
  const prompt = JSON.parse(result.stdout).additional_context;
  assert.equal(prompt.startsWith('Cursor|byline|Docs|https://example.com/a(b)|Claude *Code*|'), true);
  assert.equal(prompt.includes(process.execPath), true);
  assert.match(prompt, /main\.js["']$/);
  assert.equal(prompt.includes('OLD SESSION'), false);
  assert.equal(prompt.includes('NOT THE EMPTY PROMPT'), false);

  writeFileSync(context.config, JSON.stringify({
    plugins: [],
    link: 'https://example.com/a(b)',
    variables: { team: 'Docs' },
    prompts: {
      session: 'SHOULD NOT APPEAR',
      empty: 'none|{harness}|{team}|{link}|{commands}',
    },
  }));
  const empty = runCli(['agent-hook', 'cursor', 'sessionStart'], context, '{}');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).additional_context, 'none|Cursor|Docs|https://example.com/a(b)|');

  writeFileSync(context.config, JSON.stringify({
    plugins: [],
    attribution: { templates: { empty: 'from-attribution|{harness}' } },
  }));
  const alias = runCli(['agent-hook', 'cursor', 'sessionStart'], context, '{}');
  assert.equal(alias.status, 0, alias.stderr);
  assert.equal(JSON.parse(alias.stdout).additional_context, 'from-attribution|Cursor');
});

test('session prompts include generic and adapter-specific model lookup guidance', (t) => {
  const context = isolated(t);
  writeFileSync(context.config, JSON.stringify({
    plugins: [context.plugin],
    prompts: { session: 'Custom session prompt.{modelGuidance}' },
  }));

  const cursor = runCli(['agent-hook', 'cursor', 'sessionStart'], context, '{}');
  assert.equal(cursor.status, 0, cursor.stderr);
  assert.match(JSON.parse(cursor.stdout).additional_context, /JSONL conversation/);

  const codex = runCli(['agent-hook', 'codex', 'SessionStart'], context, '{}');
  assert.equal(codex.status, 0, codex.stderr);
  const codexPrompt = JSON.parse(codex.stdout).hookSpecificOutput.additionalContext;
  assert.match(codexPrompt, /Custom session prompt\./);
  assert.match(codexPrompt, /payload\.state\.model\.model/);
  assert.match(codexPrompt, /payload\.thread_settings\.model/);

  const claude = runCli(['agent-hook', 'claude-code', 'SessionStart'], context, JSON.stringify({ session_id: 'session' }));
  assert.equal(claude.status, 0, claude.stderr);
  assert.match(claude.stdout, /params\.model/);
  assert.match(claude.stdout, /message\.model/);
  assert.match(claude.stdout, /attachment\.identity\.modelId/);
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
