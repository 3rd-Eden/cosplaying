import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv, writeSpawnStub } from './spawn-stub.js';
import { main } from '../src/main.js';
import { EMPTY_SESSION, renderSession } from '../src/prompt.js';

const notify = fileURLToPath(new URL('../../../examples/notify', import.meta.url));
const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

function capture() {
  let text = '';
  return {
    write(chunk) { text += chunk; },
    text() { return text; },
  };
}

function isolated() {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-cli-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  mkdirSync(path.join(cwd, '.git'));
  const stub = writeSpawnStub(
    path.join(home, 'notify'),
    '#!/bin/sh\nprintf "inside:%s\\n" "$COSPLAYING_INSIDE_HOOK"\nprintf "%s\\n" "$@"\n',
    { inside: '1' },
  );
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [notify] }));
  return {
    home,
    cwd,
    platform: 'linux',
    env: { ...systemEnv(), PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, COSPLAYING_NOTIFY_BIN: stub },
  };
}

test('version and help list the core commands', async () => {
  const stdout = capture();
  const stderr = capture();
  const options = { ...isolated(), stdout, stderr };
  assert.equal(await main(['--version'], options), 0);
  assert.equal(stdout.text(), '0.1.0\n');
  const helpOut = capture();
  assert.equal(await main(['--help'], { ...options, stdout: helpOut }), 0);
  for (const name of ['hook', 'agent-hook', 'rewrite', 'install', 'uninstall', 'doctor', 'plugin']) {
    assert.match(helpOut.text(), new RegExp(`^  ${name}\\b`, 'm'));
  }
  assert.match(helpOut.text(), /notify {2}Append a byline/);
  assert.match(helpOut.text(), /^    cosplaying hook --model "Example"/m);
});

test('unknown harness text names the supported ids', async () => {
  const context = isolated();
  const stderr = capture();
  assert.equal(await main(['install', '--harness', 'nope'], { ...context, stdout: capture(), stderr }), 2);
  assert.match(stderr.text(), /unknown harness nope\. Supported harnesses: claude-code, codex, cursor, gemini, opencode, pi\./);
  assert.match(stderr.text(), /cosplaying install --harness/);
  assert.match(stderr.text(), /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
});

/**
 * @param {string[]} args
 * @param {ReturnType<typeof isolated>} context
 */
function runCli(args, context) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: context.cwd,
    encoding: 'utf8',
    env: {
      ...systemEnv(),
      HOME: context.home,
      USERPROFILE: context.home,
      PATH: context.env.PATH,
      TMPDIR: process.env.TMPDIR,
      COSPLAYING_NOTIFY_BIN: context.env.COSPLAYING_NOTIFY_BIN,
    },
  });
}

test('hook attributes notify writes, passes reads, and blocks an empty model', () => {
  const context = isolated();
  const write = runCli(['hook', '--model', 'Example', '--', 'notify', '--message', 'text'], context);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /^inside:1\n--message\ntext\nAI-Assisted-By: Example via cosplaying /);

  const read = runCli(['hook', '--model', 'Example', '--', 'notify', '--list'], context);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, 'inside:1\n--list\n');
  assert.doesNotMatch(read.stdout, /AI-Assisted-By/);

  const blocked = runCli(['hook', '--', 'notify', '--message', 'text'], context);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.stdout, '');
  assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.match(blocked.stderr, /--model/);
});

test('agent hooks rewrite shell commands and remember the Claude session model', async () => {
  const context = isolated();
  const sessionOut = capture();
  assert.equal(await main(['agent-hook', 'claude-code', 'SessionStart'], {
    ...context,
    stdout: sessionOut,
    stderr: capture(),
    input: JSON.stringify({ session_id: 'abc', model: 'Example Model' }),
  }), 0);
  assert.match(sessionOut.text(), /ASD-STE100/);
  assert.match(sessionOut.text(), /notify/);

  const pre = capture();
  assert.equal(await main(['agent-hook', 'claude-code', 'PreToolUse'], {
    ...context,
    stdout: pre,
    stderr: capture(),
    input: JSON.stringify({ session_id: 'abc', tool_name: 'Bash', tool_input: { command: 'notify --list' } }),
  }), 0);
  const payload = JSON.parse(pre.text());
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(payload.hookSpecificOutput.updatedInput.command, /hook --model-base64 \S+ -- notify --list$/);

  const cursor = capture();
  assert.equal(await main(['agent-hook', 'cursor', 'preToolUse'], {
    ...context,
    stdout: cursor,
    stderr: capture(),
    input: JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'echo hi' } }),
  }), 0);
  assert.deepEqual(JSON.parse(cursor.text()), { permission: 'allow' });

  const missing = capture();
  assert.equal(await main(['agent-hook', 'cursor', 'preToolUse'], {
    ...context,
    stdout: missing,
    stderr: capture(),
    input: JSON.stringify({ tool_name: 'Shell', tool_input: {} }),
  }), 0);
  assert.equal(JSON.parse(missing.text()).permission, 'deny');

  const invalid = capture();
  assert.equal(await main(['agent-hook', 'cursor', 'preToolUse'], {
    ...context, stdout: capture(), stderr: invalid, input: '{',
  }), 2);
  assert.match(invalid.text(), /invalid hook input/);
});

test('repair moves an rtk hook behind cosplaying and denies the current command', async () => {
  const context = isolated();
  assert.equal(await main(['install', '--harness', 'claude-code'], { ...context, stdout: capture(), stderr: capture() }), 0);
  const file = path.join(context.home, '.claude', 'settings.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  parsed.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'rtk hook claude' }] });
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  const stdout = capture();
  assert.equal(await main(['agent-hook', 'claude-code', 'PreToolUse'], {
    ...context,
    stdout,
    stderr: capture(),
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'notify --list' } }),
  }), 0);
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /not run/);
  const repaired = JSON.parse(readFileSync(file, 'utf8'));
  const commands = JSON.stringify(repaired.hooks.PreToolUse);
  assert.match(commands, /rtk hook claude/);
  assert.equal(commands.lastIndexOf('# cosplaying:claude-code') > commands.lastIndexOf('rtk hook claude'), true);
});

test('session start names an unverified hook and still prints the prompt', () => {
  const context = isolated();
  const installed = runCli(['install', '--harness', 'claude-code'], context);
  assert.equal(installed.status, 0, installed.stderr);
  const file = path.join(context.home, '.claude', 'settings.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const lookalike = 'node /usr/bin/main.js agent-hook claude-code PreToolUse';
  parsed.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: lookalike }] });
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  const result = spawnSync(process.execPath, [bin, 'agent-hook', 'claude-code', 'SessionStart'], {
    cwd: context.cwd,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'abc', model: 'Example Model' }),
    env: {
      HOME: context.home,
      USERPROFILE: context.home,
      PATH: context.env.PATH,
      TMPDIR: process.env.TMPDIR,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ASD-STE100/);
  assert.match(result.stdout, /could not be verified/);
  assert.match(result.stdout, /denied/);
  assert.match(result.stdout, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(readFileSync(file, 'utf8'), /node \/usr\/bin\/main\.js agent-hook claude-code PreToolUse/);
});

test('session text fills executable, harness, and commands', () => {
  assert.equal(renderSession({
    harness: 'pi',
    executable: 'exe',
    commands: [],
    template: 'Hello {team}',
  }), EMPTY_SESSION);
  assert.equal(renderSession({
    harness: 'cursor',
    executable: 'exe',
    commands: ['notify', 'gh'],
    template: '{executable} {harness} {commands}',
  }), 'exe Cursor gh, notify');
});

test('omitted -- does not run a write with its flags removed', () => {
  const context = isolated();
  const result = runCli(['hook', '--model', 'Example', 'notify', '--message', 'text'], context);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--message/);
  assert.match(result.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
});

test('invalid install and doctor options exit 2', async () => {
  const context = isolated();
  const doctorErr = capture();
  assert.equal(await main(['doctor', '--nope'], { ...context, stdout: capture(), stderr: doctorErr }), 2);
  assert.match(doctorErr.text(), /--nope/);
  assert.match(doctorErr.text(), /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
  const installErr = capture();
  assert.equal(await main(['install', '--project-dir'], { ...context, stdout: capture(), stderr: installErr }), 2);
  assert.match(installErr.text(), /project-dir/);
  assert.equal(existsSync(path.join(context.cwd, 'true')), false);
});

test('a lookalike hook after ours is reported and left in place', async () => {
  const context = isolated();
  assert.equal(await main(['install', '--harness', 'claude-code'], { ...context, stdout: capture(), stderr: capture() }), 0);
  const file = path.join(context.home, '.claude', 'settings.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const lookalike = 'node /usr/bin/main.js agent-hook claude-code PreToolUse';
  parsed.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: lookalike }] });
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  const stdout = capture();
  assert.equal(await main(['agent-hook', 'claude-code', 'PreToolUse'], {
    ...context,
    stdout,
    stderr: capture(),
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'notify --list' } }),
  }), 0);
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /not run/);
  const after = readFileSync(file, 'utf8');
  assert.match(after, /node \/usr\/bin\/main\.js agent-hook claude-code PreToolUse/);
  assert.match(after, /# cosplaying:claude-code/);
});

test('rewrite prints the command and doctor passes after install', async () => {
  const context = isolated();
  const stdout = capture();
  assert.equal(await main(['rewrite', '--shell', 'echo hi'], { ...context, stdout, stderr: capture() }), 0);
  assert.equal(stdout.text(), 'echo hi\n');
  const rewritten = capture();
  assert.equal(await main(['rewrite', 'notify', '--list'], { ...context, stdout: rewritten, stderr: capture() }), 0);
  assert.match(rewritten.text(), /hook -- notify --list\n$/);
  assert.equal(await main(['install'], { ...context, stdout: capture(), stderr: capture() }), 0);
  const doctorOut = capture();
  const doctorErr = capture();
  assert.equal(await main(['doctor'], { ...context, stdout: doctorOut, stderr: doctorErr }), 0, doctorErr.text());
  assert.match(doctorOut.text(), /cosplaying doctor: no findings \(6 managed installs checked\)/);
});

test('codex exec_command is read from toolName and padded base64 is rejected', async () => {
  const context = isolated();
  const stdout = capture();
  assert.equal(await main(['agent-hook', 'codex', 'PreToolUse'], {
    ...context,
    stdout,
    stderr: capture(),
    input: JSON.stringify({ toolName: 'exec_command', toolInput: { cmd: 'notify --list' } }),
  }), 0);
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(payload.hookSpecificOutput.updatedInput.cmd, /hook --model-base64 \S+ -- notify --list$/);

  const rejected = runCli(['hook', '--model-base64', 'YQ==', '--', 'notify', '--list'], context);
  assert.equal(rejected.status, 2);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /base64url/);
});
