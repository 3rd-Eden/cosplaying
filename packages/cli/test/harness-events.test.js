import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeSamplePlugin } from './sample-plugin.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const byline = writeSamplePlugin(mkdtempSync(path.join(tmpdir(), 'cosplaying-byline-')));
const python = '/usr/bin/python3';

/**
 * Creates a temporary home and working directory for one harness-event test.
 *
 * The CLI reads and writes hook files and session files under this home.
 *
 * @returns {{home: string, cwd: string}} Absolute paths of the two directories.
 */
function isolated() {
  return {
    home: mkdtempSync(path.join(tmpdir(), 'cosplaying-home-')),
    cwd: mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-')),
  };
}

/**
 * Builds the environment that keeps the CLI off the developer home and PATH.
 *
 * @param {string} home Temporary home directory.
 * @returns {{HOME: string, USERPROFILE: string, PATH: string}} Environment for one CLI spawn.
 */
function envFor(home) {
  return { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin' };
}

/**
 * Runs one `agent-hook` or other CLI command and waits for it to exit.
 *
 * The hook payload is passed as stdin.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {{home: string, cwd: string, input?: string}} context Temporary paths and optional stdin text.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, context) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: context.cwd,
    input: context.input,
    encoding: 'utf8',
    env: envFor(context.home),
  });
}

/**
 * Returns the path of the stored model for one session id.
 *
 * The file name is the SHA-256 of the id, matching the CLI. The test can then read or confirm the file without embedding the hash.
 *
 * @param {string} home Temporary home directory.
 * @param {string} sessionId Session id sent in the hook payload.
 * @returns {string} Absolute path of `<home>/.config/cosplaying/sessions/<hash>.json`.
 */
function sessionFile(home, sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex');
  return path.join(home, '.config', 'cosplaying', 'sessions', `${hash}.json`);
}

test('Claude PostModelSwitch stores to_model or model and SessionEnd deletes that file', () => {
  const context = isolated();
  const preferred = 'session/to-model';
  const switched = run(['agent-hook', 'claude-code', 'PostModelSwitch'], {
    ...context,
    input: JSON.stringify({ session_id: preferred, to_model: 'To Model', model: 'Other Model' }),
  });
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(switched.stdout, '');
  assert.equal(switched.stderr, '');
  const preferredFile = sessionFile(context.home, preferred);
  assert.equal(preferredFile.includes(preferred), false);
  assert.equal(readFileSync(preferredFile, 'utf8'), '{"model":"To Model"}');
  if (process.platform !== 'win32') assert.equal(statSync(preferredFile).mode & 0o777, 0o600);

  const fallback = 'session/fallback-model';
  const onlyModel = run(['agent-hook', 'claude-code', 'PostModelSwitch'], {
    ...context,
    input: JSON.stringify({ session_id: fallback, model: 'Fallback Model' }),
  });
  assert.equal(onlyModel.status, 0, onlyModel.stderr);
  assert.equal(onlyModel.stdout, '');
  const fallbackFile = sessionFile(context.home, fallback);
  assert.equal(readFileSync(fallbackFile, 'utf8'), '{"model":"Fallback Model"}');

  const ended = run(['agent-hook', 'claude-code', 'SessionEnd'], {
    ...context,
    input: JSON.stringify({ session_id: preferred }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, '');
  assert.equal(ended.stderr, '');
  assert.equal(existsSync(preferredFile), false);
  assert.equal(readFileSync(fallbackFile, 'utf8'), '{"model":"Fallback Model"}');
});

test('Gemini BeforeTool allows a command, denies a missing command, and SessionStart prints JSON', () => {
  const context = isolated();
  writeFileSync(path.join(context.cwd, '.cosplaying.json'), JSON.stringify({ plugins: [byline] }));
  const allow = run(['agent-hook', 'gemini', 'BeforeTool'], {
    ...context,
    input: JSON.stringify({
      tool_name: 'run_shell_command',
      tool_input: { command: 'byline --list', cwd: '/work' },
    }),
  });
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(allow.stderr, '');
  const allowed = JSON.parse(allow.stdout);
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.hookSpecificOutput.tool_input.cwd, '/work');
  const command = allowed.hookSpecificOutput.tool_input.command;
  assert.match(command, /hook --model-base64 \S+ -- byline --list$/);
  assert.notEqual(command, 'byline --list');

  const deny = run(['agent-hook', 'gemini', 'BeforeTool'], {
    ...context,
    input: JSON.stringify({
      tool_name: 'run_shell_command',
      tool_input: { cwd: '/work' },
    }),
  });
  assert.equal(deny.status, 0, deny.stderr);
  assert.equal(deny.stderr, '');
  assert.deepEqual(JSON.parse(deny.stdout), {
    decision: 'deny',
    reason: 'cosplaying could not read the shell command. The command was not run. Retry it through cosplaying.',
  });

  const start = run(['agent-hook', 'gemini', 'SessionStart'], {
    ...context,
    input: '{}',
  });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stderr, '');
  const started = JSON.parse(start.stdout);
  assert.deepEqual(Object.keys(started), ['hookSpecificOutput']);
  assert.match(started.hookSpecificOutput.additionalContext, /Gemini CLI/);
  assert.match(started.hookSpecificOutput.additionalContext, /byline/);
  assert.match(started.hookSpecificOutput.additionalContext, /ASD-STE100/);
});

test('Codex exec_command without cmd denies and does not rewrite', () => {
  const context = isolated();
  const result = run(['agent-hook', 'codex', 'PreToolUse'], {
    ...context,
    input: JSON.stringify({ toolName: 'exec_command', toolInput: { cwd: '/work' } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'cosplaying could not read the shell command. The command was not run. Retry it through cosplaying.',
    },
  });
});

/**
 * Starts the CLI with a nonblocking stdin so an empty read returns `EAGAIN`.
 *
 * Node's `child_process` gives the child a blocking stdin description. A Python wrapper sets `O_NONBLOCK` on that description and then execs Node.
 *
 * @param {string[]} args Arguments for the Node process, starting with the CLI script.
 * @param {{readFd: number, home: string, cwd: string}} context Open read end of the FIFO, plus the temporary home and working directory.
 * @returns {import('node:child_process').ChildProcess} The Python process after it has become the CLI. `stdout` and `stderr` are UTF-8 streams.
 */
function spawnNonblocking(args, context) {
  const wrapper = [
    'import os, fcntl, sys',
    'flags = fcntl.fcntl(0, fcntl.F_GETFL)',
    'fcntl.fcntl(0, fcntl.F_SETFL, flags | os.O_NONBLOCK)',
    'os.execv(sys.argv[1], sys.argv[1:])',
  ].join('\n');
  const child = spawn(python, ['-c', wrapper, process.execPath, ...args], {
    cwd: context.cwd,
    env: envFor(context.home),
    stdio: [context.readFd, 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

/**
 * Waits for a child process to exit and returns its status.
 *
 * A process that has already exited resolves immediately.
 *
 * @param {import('node:child_process').ChildProcess} child Process started by {@link spawnNonblocking}.
 * @returns {Promise<number>} Exit status. `1` when the status is null.
 */
function exitCode(child) {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
    if (child.exitCode !== null) resolve(child.exitCode);
  });
}

/**
 * Waits so a nonblocking read can observe `EAGAIN` before stdin is closed.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collects stdout and stderr from a long-running CLI child.
 *
 * The streams are decoded as UTF-8 by the caller. `text` returns what has arrived so far.
 *
 * @param {import('node:child_process').ChildProcess} child Process whose stdout and stderr are piped.
 * @returns {{text: () => {stdout: string, stderr: string}}} A reader for the text collected since this function was called.
 */
function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    /**
     * Returns the stdout and stderr collected so far.
     *
     * @returns {{stdout: string, stderr: string}} Text received from the child.
     */
    text() { return { stdout, stderr }; },
  };
}

test('agent-hook retries EAGAIN on an empty nonblocking pipe', {
  skip: process.platform !== 'win32' && existsSync(python) ? false : 'python3 and mkfifo are required to make stdin nonblocking',
}, async () => {
  assert.equal(existsSync(python), true);
  const context = isolated();
  const fifo = path.join(mkdtempSync(path.join(tmpdir(), 'cosplaying-fifo-')), 'pipe');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writeFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  try {
    const probe = spawnNonblocking(['-e', `
import { readSync } from 'node:fs';
const buffer = Buffer.alloc(8);
try {
  const count = readSync(0, buffer, 0, buffer.length, null);
  console.log('READ', count);
} catch (error) {
  console.log('CODE', error.code);
}
`], { ...context, readFd });
    const probed = capture(probe);
    const probeCode = await Promise.race([
      exitCode(probe),
      delay(2000).then(() => {
        probe.kill();
        return null;
      }),
    ]);
    assert.equal(probeCode, 0, probed.text().stderr);
    assert.match(probed.text().stdout, /^CODE (?:EAGAIN|EWOULDBLOCK)\n$/);

    child = spawnNonblocking([bin, 'agent-hook', 'codex', 'PreToolUse'], { ...context, readFd });
    const hooked = capture(child);
    const early = await Promise.race([
      exitCode(child).then((code) => code),
      delay(1000).then(() => null),
    ]);
    assert.equal(early, null, `${hooked.text().stderr}${hooked.text().stdout}`);
    writeSync(writeFd, JSON.stringify({ toolName: 'exec_command', toolInput: { cwd: '/work' } }));
    closeSync(writeFd);
    const status = await Promise.race([
      exitCode(child),
      delay(5000).then(() => {
        child.kill();
        return null;
      }),
    ]);
    assert.equal(status, 0, hooked.text().stderr);
    assert.equal(hooked.text().stderr, '');
    assert.deepEqual(JSON.parse(hooked.text().stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'cosplaying could not read the shell command. The command was not run. Retry it through cosplaying.',
      },
    });
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { closeSync(readFd); } catch { /* already closed */ }
    try { closeSync(writeFd); } catch { /* already closed */ }
  }
});

const seatbelt = '/usr/bin/sandbox-exec';

test('Claude session start stores the model when chmod is denied', { skip: existsSync(seatbelt) ? false : 'seatbelt is not installed, so chmod cannot be denied' }, () => {
  const context = isolated();
  const profile = path.join(context.cwd, 'chmod-deny.sb');
  const probe = path.join(context.cwd, 'probe');
  try {
    writeFileSync(profile, '(version 1)\n(allow default)\n(deny file-write-mode)\n');
    writeFileSync(probe, 'x');
    const env = { HOME: context.home, USERPROFILE: context.home };
    const denied = spawnSync(seatbelt, [
      '-f', profile,
      process.execPath,
      '-e',
      'const fs = require("node:fs"); try { fs.chmodSync(process.argv[1], 0o600); } catch (error) { process.stderr.write(String(error.code)); process.exit(1); }',
      probe,
    ], { encoding: 'utf8', env });
    assert.equal(denied.status, 1, denied.stderr);
    assert.equal(denied.stderr, 'EPERM');

    const sessionId = 'chmod-denied';
    const result = spawnSync(seatbelt, [
      '-f', profile,
      process.execPath,
      bin,
      'agent-hook',
      'claude-code',
      'SessionStart',
    ], {
      cwd: context.cwd,
      input: JSON.stringify({ session_id: sessionId, model: 'Seatbelt Model' }),
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'No cosplaying plugins are installed. Do not invent wrapped commands. Write authored text in ASD-STE100 Simplified Technical English.\n');
    assert.equal(readFileSync(sessionFile(context.home, sessionId), 'utf8'), '{"model":"Seatbelt Model"}');
  } finally {
    rmSync(context.home, { recursive: true, force: true });
    rmSync(context.cwd, { recursive: true, force: true });
  }
});
