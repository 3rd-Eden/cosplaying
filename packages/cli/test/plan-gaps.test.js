import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeSamplePlugin } from './sample-plugin.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const byline = writeSamplePlugin(mkdtempSync(path.join(tmpdir(), 'cosplaying-byline-')));
const nodeExecutable = path.join(byline, process.platform === 'win32' ? 'node.exe' : 'node');
copyFileSync(process.execPath, nodeExecutable);
const application = path.join(byline, 'note.mjs');
writeFileSync(application, String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const message = args.indexOf('--message');
if (message >= 0) writeFileSync('note.txt', args[message + 1] + '\n');
process.stdout.write(readFileSync('note.txt', 'utf8'));
`);
const bylineEnv = { COSPLAYING_BYLINE_BIN: nodeExecutable };
after(() => rmSync(byline, { recursive: true, force: true }));

/**
 * Runs the CLI in a temporary home, with optional stdin.
 *
 * Extra environment values select real executables or set the model for a run.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @param {NodeJS.ProcessEnv} [env={}] Extra environment variables.
 * @param {string} [input] Text written to the CLI stdin.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd, env = {}, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.windir ? { windir: process.env.windir } : {}),
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      ...env,
    },
  });
}

/**
 * @param {string[] | false} [plugins=[byline]]
 * @returns {{home: string, cwd: string, note: string}}
 */
function isolated(plugins = [byline]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-gap-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-gap-cwd-'));
  const note = path.join(cwd, 'note.txt');
  writeFileSync(note, 'Saved note.\n');
  if (plugins) writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins }));
  return { home, cwd, note };
}

test('hook resolves the model, rejects a bad flag, and skips a second attribution', () => {
  const { home, cwd, note } = isolated();
  try {
    const read = run(['hook', '--', 'byline', application, '--list'], home, cwd, bylineEnv);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, 'Saved note.\n');
    assert.equal(readFileSync(note, 'utf8'), 'Saved note.\n');

    const rows = [
      { flags: ['--model', '  Example   Model  '], model: 'Example Model' },
      { flags: ['--harness', 'gemini'], model: 'Gemini CLI' },
      { flags: [], env: { COSPLAYING_MODEL: 'Env Model' }, model: 'Env Model' },
      { flags: ['--model', 'Plain'], env: { COSPLAYING_MODEL: 'Env Model' }, model: 'Plain' },
      { flags: ['--model-base64', 'RnJvbTY0', '--model', 'Plain'], model: 'From64' },
    ];
    for (const row of rows) {
      const written = run(['hook', ...row.flags, '--', 'byline', application, '--message', 'hi'], home, cwd, {
        ...bylineEnv, ...row.env,
      });
      assert.equal(written.status, 0, written.stderr);
      const expected = `hi\nAI-Assisted-By: ${row.model} via cosplaying (https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.\n`;
      assert.equal(readFileSync(note, 'utf8'), expected);
      assert.equal(written.stdout, expected);
      assert.equal(written.stderr, '');
    }

    for (const value of ['', '-bad']) {
      rmSync(note);
      const rejected = run(['hook', '--model', value, '--', 'byline', application, '--message', 'hi'], home, cwd, bylineEnv);
      assert.equal(rejected.status, 2);
      assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, /--model/);
      assert.equal(existsSync(note), false);
      writeFileSync(note, 'Saved note.\n');
    }

    const again = run(['hook', '--model', 'Example', '--', 'byline', application, '--message', 'hi'], home, cwd, {
      ...bylineEnv, COSPLAYING_INSIDE_HOOK: '1',
    });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, 'hi\n');
    assert.equal(readFileSync(note, 'utf8'), 'hi\n');

    const missing = run(['hook', '--model', 'Example', '--', 'byline', application, '--list'], home, cwd, { PATH: '' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /byline/);
    assert.match(missing.stderr, /PATH/);
    assert.equal(readFileSync(note, 'utf8'), 'hi\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('rewrite reports missing text and keeps the spacing of one --shell argument', () => {
  const { home, cwd } = isolated(null);
  try {
    const empty = run(['rewrite'], home, cwd);
    assert.equal(empty.status, 2);
    assert.equal(empty.stdout, '');
    assert.match(empty.stderr, /expected a command/);

    const spaced = run(['rewrite', '--shell', 'echo  hi'], home, cwd);
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.equal(spaced.stdout, 'echo  hi\n');

    const joined = run(['rewrite', 'echo', 'a', 'b'], home, cwd);
    assert.equal(joined.status, 0, joined.stderr);
    assert.equal(joined.stdout, 'echo a b\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('agent-hook is silent for non-shell tools and prints the harness allow or session payload', () => {
  const context = isolated();
  const { home, cwd } = context;
  const env = bylineEnv;
  try {
    const claude = run(['agent-hook', 'claude-code', 'PreToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi', cwd: '/tmp' },
    }));
    assert.equal(claude.status, 0, claude.stderr);
    assert.equal(claude.stdout, '');

    const codexShell = run(['agent-hook', 'codex', 'PreToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'apply_patch',
      tool_input: { command: 'byline --list' },
    }));
    assert.equal(codexShell.status, 0, codexShell.stderr);
    assert.equal(codexShell.stdout, '');

    const codexSame = run(['agent-hook', 'codex', 'PreToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    }));
    assert.equal(codexSame.status, 0, codexSame.stderr);
    assert.equal(codexSame.stdout, '');

    const cursorOther = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'Read',
      tool_input: { command: 'byline --list' },
    }));
    assert.equal(cursorOther.status, 0, cursorOther.stderr);
    assert.equal(cursorOther.stdout, '');

    const geminiSame = run(['agent-hook', 'gemini', 'BeforeTool'], home, cwd, env, JSON.stringify({
      tool_name: 'run_shell_command',
      tool_input: { command: 'echo hi' },
    }));
    assert.equal(geminiSame.status, 0, geminiSame.stderr);
    assert.equal(geminiSame.stdout, '{"decision":"allow"}\n');

    const geminiOther = run(['agent-hook', 'gemini', 'BeforeTool'], home, cwd, env, JSON.stringify({
      tool_name: 'write_file',
      tool_input: { command: 'byline --list' },
    }));
    assert.equal(geminiOther.status, 0, geminiOther.stderr);
    assert.equal(geminiOther.stdout, '');

    const cursorRewrite = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'Shell',
      tool_input: { command: 'byline --list', cwd: '/work' },
    }));
    assert.equal(cursorRewrite.status, 0, cursorRewrite.stderr);
    const cursorBody = JSON.parse(cursorRewrite.stdout);
    assert.equal(cursorBody.permission, 'allow');
    assert.equal(cursorBody.updated_input.cwd, '/work');
    assert.match(cursorBody.updated_input.command, /hook --model-base64 \S+ -- byline --list$/);
    const cursorModel = cursorBody.updated_input.command.match(/--model-base64 (\S+)/)[1];
    assert.equal(Buffer.from(cursorModel, 'base64url').toString('utf8'), 'Cursor');

    const codexRewrite = run(['agent-hook', 'codex', 'PreToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'byline --list', cwd: '/work' },
    }));
    const codexBody = JSON.parse(codexRewrite.stdout);
    assert.equal(codexBody.hookSpecificOutput.updatedInput.cwd, '/work');
    assert.match(codexBody.hookSpecificOutput.updatedInput.command, /byline --list$/);

    const emptyHome = mkdtempSync(path.join(tmpdir(), 'cosplaying-gap-empty-'));
    const emptyCwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-gap-empty-cwd-'));
    const emptySession = run(['agent-hook', 'cursor', 'sessionStart'], emptyHome, emptyCwd, {}, '{}');
    assert.equal(emptySession.status, 0, emptySession.stderr);
    const emptyPrompt = JSON.parse(emptySession.stdout).additional_context;
    assert.match(emptyPrompt, /No cosplaying plugins are installed/);
    assert.doesNotMatch(emptyPrompt, /prefix the command/);

    const cursorStart = run(['agent-hook', 'cursor', 'sessionStart'], home, cwd, env, '{}');
    const cursorPrompt = JSON.parse(cursorStart.stdout).additional_context;
    assert.match(cursorPrompt, /byline/);
    assert.match(cursorPrompt, /You are running in Cursor/);

    const codexStart = run(['agent-hook', 'codex', 'SessionStart'], home, cwd, env, '{}');
    const codexPrompt = JSON.parse(codexStart.stdout);
    assert.equal(codexPrompt.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(codexPrompt.hookSpecificOutput.additionalContext, /You are running in Codex/);

    const piStart = run(['agent-hook', 'pi', 'session-start'], home, cwd, env, '{}');
    assert.equal(piStart.status, 0, piStart.stderr);
    assert.match(piStart.stdout, /You are running in Pi/);
    assert.equal(piStart.stdout.trimStart().startsWith('{'), false);

    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(emptyCwd, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('agent-hook uses model_id and toolInput, and rejects a non-object payload', () => {
  const context = isolated();
  const { home, cwd } = context;
  const env = bylineEnv;
  try {
    const direct = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, env, JSON.stringify({
      model: 'Direct',
      model_id: 'Other',
      tool_name: 'Shell',
      tool_input: { command: 'byline --list' },
    }));
    assert.equal(direct.status, 0, direct.stderr);
    const directModel = JSON.parse(direct.stdout).updated_input.command.match(/--model-base64 (\S+)/)[1];
    assert.equal(Buffer.from(directModel, 'base64url').toString('utf8'), 'Direct');

    const byId = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, env, JSON.stringify({
      tool_name: 'Shell',
      model_id: '  From   Id  ',
      tool_input: { command: 'byline --list' },
    }));
    assert.equal(byId.status, 0, byId.stderr);
    const encoded = JSON.parse(byId.stdout).updated_input.command.match(/--model-base64 (\S+)/)[1];
    assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), 'From Id');

    const camel = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, env, JSON.stringify({
      toolName: 'Shell',
      toolInput: { command: 'byline --list', cwd: '/work' },
    }));
    const camelBody = JSON.parse(camel.stdout);
    assert.equal(camelBody.permission, 'allow');
    assert.equal(camelBody.updated_input.cwd, '/work');
    assert.match(camelBody.updated_input.command, /byline --list$/);

    const unnamed = run(['agent-hook', 'claude-code', 'PreToolUse'], home, cwd, env, JSON.stringify({
      tool_input: { command: 'byline --list', cwd: '/tmp' },
    }));
    const unnamedBody = JSON.parse(unnamed.stdout);
    assert.equal(unnamedBody.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(unnamedBody.hookSpecificOutput.updatedInput.cwd, '/tmp');

    for (const payload of ['[]', 'null', '"text"']) {
      const bad = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, env, payload);
      assert.equal(bad.status, 2, payload);
      assert.equal(bad.stdout, '');
      assert.match(bad.stderr, /expected a JSON object/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('plugin install follows an absolute XDG_DATA_HOME and ignores a relative one', () => {
  const { home, cwd } = isolated(null);
  const source = path.join(cwd, 'extra');
  mkdirSync(source);
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'extra',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  }));
  writeFileSync(path.join(source, 'index.js'), 'export default function run() { return 0; }\n');
  const xdg = path.join(home, 'xdg-data');
  const fallback = path.join(home, '.local', 'share', 'cosplaying', 'plugins', 'extra', 'package.json');
  try {
    const relative = run(['plugin', 'install', source], home, cwd, { XDG_DATA_HOME: 'relative-data' });
    assert.equal(relative.status, 0, relative.stderr);
    assert.equal(existsSync(fallback), true);
    assert.equal(existsSync(path.join(cwd, 'relative-data', 'cosplaying', 'plugins', 'extra')), false);
    const installed = run(['plugin', 'install', source], home, cwd, { XDG_DATA_HOME: xdg });
    assert.equal(installed.status, 0, installed.stderr);
    const listed = run(['plugin', 'list'], home, cwd, { XDG_DATA_HOME: xdg });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, `extra\textra\tpath\t${path.join(xdg, 'cosplaying', 'plugins', 'extra')}\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor names a missing harness binary and still exits 0', () => {
  const { home, cwd } = isolated(null);
  try {
    const installed = run(['install'], home, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    const doctor = run(['doctor'], home, cwd);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(doctor.stderr, '');
    for (const id of ['claude-code', 'codex', 'cursor', 'gemini', 'opencode', 'pi']) {
      assert.match(doctor.stdout, new RegExp(`cosplaying doctor: ${id} executable not found`));
    }
    assert.match(doctor.stdout, /no findings \(6 managed installs checked\)/);
    assert.doesNotMatch(doctor.stdout + doctor.stderr, /approved|hook is trusted/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install quotes the hook, keeps an existing version, and does not write a bad file', () => {
  const { home, cwd } = isolated(null);
  try {
    const installed = run(['install', '--harness', 'claude-code,codex,gemini,cursor'], home, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    const claudeFile = path.join(home, '.claude', 'settings.json');
    if (process.platform !== 'win32') assert.equal(statSync(claudeFile).mode & 0o777, 0o600);
    const claude = JSON.parse(readFileSync(claudeFile, 'utf8'));
    const pre = claude.hooks.PreToolUse[0];
    assert.equal(pre.matcher, 'Bash|PowerShell');
    const command = pre.hooks[0].command;
    const quote = process.platform === 'win32' ? '"' : "'";
    const escaped = process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(command, new RegExp(`^${quote}${escaped}${quote} ${quote}`));
    assert.match(command, /agent-hook claude-code PreToolUse # cosplaying:claude-code$/);

    const codex = JSON.parse(readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(Object.hasOwn(codex.hooks.PreToolUse[0], 'matcher'), false);

    const gemini = JSON.parse(readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(gemini.hooks.BeforeTool[0].matcher, 'run_shell_command');

    const cursorFile = path.join(home, '.cursor', 'hooks.json');
    const cursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
    cursor.version = 7;
    cursor.custom = 'kept';
    writeFileSync(cursorFile, JSON.stringify(cursor));
    const again = run(['install', '--harness', 'cursor'], home, cwd);
    assert.equal(again.status, 0, again.stderr);
    const kept = JSON.parse(readFileSync(cursorFile, 'utf8'));
    assert.equal(kept.version, 7);
    assert.equal(kept.custom, 'kept');
    assert.match(JSON.stringify(kept.hooks), /# cosplaying:cursor/);

    const geminiFile = path.join(home, '.gemini', 'settings.json');
    const broken = JSON.parse(readFileSync(geminiFile, 'utf8'));
    broken.hooks.BeforeTool = { not: 'array' };
    const brokenText = JSON.stringify(broken);
    writeFileSync(geminiFile, brokenText);
    const rejected = run(['install', '--harness', 'gemini'], home, cwd);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /hooks\.BeforeTool must be an array/);
    assert.equal(readFileSync(geminiFile, 'utf8'), brokenText);

    const arrayFile = path.join(home, '.claude', 'settings.json');
    const arrayText = '[1]\n';
    writeFileSync(arrayFile, arrayText);
    const arrayRoot = run(['install', '--harness', 'claude-code'], home, cwd);
    assert.equal(arrayRoot.status, 1);
    assert.match(arrayRoot.stderr, /top-level object/);
    assert.equal(readFileSync(arrayFile, 'utf8'), arrayText);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a cursor pre-tool event repairs an rtk hook that was appended to the Claude file', () => {
  const context = isolated();
  const { home, cwd } = context;
  try {
    const installed = run(['install', '--harness', 'claude-code,cursor'], home, cwd, bylineEnv);
    assert.equal(installed.status, 0, installed.stderr);
    const file = path.join(home, '.claude', 'settings.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    parsed.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'rtk hook claude' }] });
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run(['agent-hook', 'cursor', 'preToolUse'], home, cwd, bylineEnv, JSON.stringify({
      tool_name: 'Shell',
      tool_input: { command: 'byline --list' },
    }));
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.permission, 'deny');
    assert.match(payload.agent_message, /not run/);
    assert.match(payload.agent_message, /Retry/);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.lastIndexOf('# cosplaying:claude-code') > text.lastIndexOf('rtk hook claude'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('intercept false stays out of the rewrite, a duplicate command fails, and a bad import does not spawn', () => {
  const context = isolated();
  const { home, cwd } = context;
  const quietDir = path.join(cwd, 'quiet');
  mkdirSync(quietDir);
  writeFileSync(path.join(quietDir, 'package.json'), JSON.stringify({
    name: 'quiet',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  }));
  writeFileSync(path.join(quietDir, 'index.js'), `export const intercept = false;
export const description = 'quiet';
export const examples = ['quiet --list'];
export default async function run(args, context) {
  const result = await context.spawn(context.realBin, args, { cwd: context.cwd, env: context.env, stdio: 'inherit' });
  return result?.status ?? 1;
}
`);
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [byline, quietDir] }));
  try {
    const rewritten = run(['rewrite', 'quiet --list; byline --list'], home, cwd, {
      ...bylineEnv,
      COSPLAYING_QUIET_BIN: nodeExecutable,
    });
    assert.equal(rewritten.status, 0, rewritten.stderr);
    assert.match(rewritten.stdout, /^quiet --list; /);
    assert.match(rewritten.stdout, /hook -- byline --list\n$/);
    assert.doesNotMatch(rewritten.stdout, /hook -- quiet/);

    const ran = run(['hook', '--', 'quiet', application, '--message', 'A quiet note.'], home, cwd, {
      ...bylineEnv,
      COSPLAYING_QUIET_BIN: nodeExecutable,
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, 'A quiet note.\n');
    assert.equal(readFileSync(context.note, 'utf8'), 'A quiet note.\n');

    const left = path.join(cwd, 'dup-a');
    const right = path.join(cwd, 'dup-b');
    for (const directory of [left, right]) {
      mkdirSync(directory);
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name: 'samebyline',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
      }));
      writeFileSync(path.join(directory, 'index.js'), 'export default function run() { return 0; }\n');
    }
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [left, right] }));
    const duplicate = run(['rewrite', 'echo', 'hi'], home, cwd);
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.stdout, '');
    assert.match(duplicate.stderr, /samebyline/);
    assert.match(duplicate.stderr, /more than one plugin/);

    const broken = path.join(cwd, 'broken');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'package.json'), JSON.stringify({
      name: 'broken',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(broken, 'index.js'), 'export default =\n');
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [broken] }));
    rmSync(context.note);
    const imported = run(['hook', '--model', 'Example', '--', 'broken', application, '--message', 'Do not write.'], home, cwd, {
      COSPLAYING_BROKEN_BIN: nodeExecutable,
    });
    assert.equal(imported.status, 1);
    assert.equal(imported.stdout, '');
    assert.match(imported.stderr, /could not import plugin/);
    assert.match(imported.stderr, /index\.js/);
    assert.equal(existsSync(context.note), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('session start stores a hashed model file and the project trailer stays', () => {
  const context = isolated();
  const { home, cwd } = context;
  const env = bylineEnv;
  try {
    const sessionId = 'abc/../x';
    const started = run(['agent-hook', 'claude-code', 'SessionStart'], home, cwd, env, JSON.stringify({
      session_id: sessionId,
      model: '  Example   Model  ',
    }));
    assert.equal(started.status, 0, started.stderr);
    const root = path.join(home, '.config', 'cosplaying');
    const sessions = path.join(root, 'sessions');
    if (process.platform !== 'win32') {
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(sessions).mode & 0o777, 0o700);
    }
    const hash = createHash('sha256').update(sessionId).digest('hex');
    const file = path.join(sessions, `${hash}.json`);
    assert.equal(readFileSync(file, 'utf8'), '{"model":"Example Model"}');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);

    const cleared = run(['agent-hook', 'claude-code', 'SessionStart'], home, cwd, env, JSON.stringify({ session_id: sessionId }));
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(existsSync(file), false);

    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({
      plugins: [byline],
      variables: { team: 'Docs' },
      attribution: { templates: { trailer: '{model} {team} file' } },
    }));
    const fromFile = run(['hook', '--model', 'Example', '--', 'byline', application, '--message', 'hi'], home, cwd, env);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.equal(fromFile.stdout, 'hi\nAI-Assisted-By: Example Docs file\n');
    assert.equal(readFileSync(context.note, 'utf8'), 'hi\nAI-Assisted-By: Example Docs file\n');
    const fromEnv = run(['hook', '--model', 'Example', '--', 'byline', application, '--message', 'hi'], home, cwd, {
      ...env,
      COSPLAYING_ATTRIBUTION_TEMPLATE: 'env {model}',
      COSPLAYING_ATTRIBUTION_TEMPLATE_MARKDOWN: 'env markdown {model}',
      COSPLAYING_ATTRIBUTION_TEMPLATE_TRAILER: '{model} only',
      COSPLAYING_LINK: 'https://example.com/env',
    });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(fromEnv.stdout, 'hi\nAI-Assisted-By: Example Docs file\n');
    assert.equal(readFileSync(context.note, 'utf8'), 'hi\nAI-Assisted-By: Example Docs file\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Pi and OpenCode extensions rewrite a command, and install follows their directories', () => {
  const context = isolated();
  const { home, cwd } = context;
  const env = bylineEnv;
  try {
    const installed = run(['install', '--harness', 'pi,opencode'], home, cwd, env);
    assert.equal(installed.status, 0, installed.stderr);
    const piFile = path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js');
    const openFile = path.join(home, '.config', 'opencode', 'plugins', 'cosplaying.js');
    const script = fileURLToPath(new URL('./fixtures/extension-host.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [script, piFile, openFile, 'byline --list'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.windir ? { windir: process.env.windir } : {}),
        HOME: home,
        USERPROFILE: home,
        PATH: '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const body = JSON.parse(child.stdout);
    assert.equal(body.piBlock, null);
    const piModel = body.piCommand.match(/--model-base64 (\S+)/)[1];
    assert.equal(Buffer.from(piModel, 'base64url').toString('utf8'), 'Example Model');
    assert.match(body.piCommand, /byline --list$/);
    assert.match(body.piPrompt, /^SYS\n\n/);
    assert.match(body.piPrompt, /byline/);
    const openModel = body.openCommand.match(/--model-base64 (\S+)/)[1];
    assert.equal(Buffer.from(openModel, 'base64url').toString('utf8'), 'OpenCode');
    assert.match(body.openSystem, /^SYS\n\n/);
    assert.match(body.openSystem, /byline/);

    const extra = path.join(cwd, 'extra');
    mkdirSync(extra);
    writeFileSync(path.join(extra, 'package.json'), JSON.stringify({
      name: 'extra',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(extra, 'index.js'), 'export const intercept = true;\nexport default function run() { return 0; }\n');
    const added = run(['plugin', 'install', extra], home, cwd, env);
    assert.equal(added.status, 0, added.stderr);
    const config = path.join(cwd, '.cosplaying.json');
    const configText = readFileSync(config, 'utf8');
    writeFileSync(config, '{');
    for (const command of ['extra', 'byline']) {
      const text = `sudo -u root ${command} --list`;
      const refreshed = spawnSync(process.execPath, [script, piFile, openFile, text, 'Shell'], {
        cwd,
        encoding: 'utf8',
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.windir ? { windir: process.env.windir } : {}), HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin' },
      });
      assert.equal(refreshed.status, 0, refreshed.stderr);
      const guarded = JSON.parse(refreshed.stdout);
      assert.equal(guarded.piBlock, true, command);
      assert.match(guarded.piReason, /cosplaying hook/);
      assert.match(guarded.openError, /cosplaying hook/);
      assert.equal(guarded.piLiteralBlock, null);
      assert.equal(guarded.openLiteral, `echo ${text}`);
    }
    writeFileSync(config, configText);

    const missing = run(['install', '--harness', 'pi,opencode', '--bin', path.join(home, 'missing-cosplaying')], home, cwd, env);
    assert.equal(missing.status, 0, missing.stderr);
    const failed = spawnSync(process.execPath, [script, piFile, openFile, 'sudo -u root byline --list', 'Shell'], {
      cwd,
      encoding: 'utf8',
      env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.windir ? { windir: process.env.windir } : {}), HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin' },
    });
    assert.equal(failed.status, 0, failed.stderr);
    const denied = JSON.parse(failed.stdout);
    assert.equal(denied.piBlock, true);
    assert.match(denied.piReason, /cosplaying hook/);
    assert.match(denied.openError, /cosplaying hook/);
    assert.equal(denied.piLiteralBlock, null);
    assert.equal(denied.openLiteral, 'echo sudo -u root byline --list');

    const piRoot = path.join(home, 'pi-root');
    const xdg = path.join(home, 'xdg');
    const piOverride = run(['install', '--harness', 'pi'], home, cwd, { ...env, PI_CODING_AGENT_DIR: piRoot });
    assert.equal(piOverride.status, 0, piOverride.stderr);
    assert.equal(existsSync(path.join(piRoot, 'extensions', 'cosplaying.js')), true);
    const openOverride = run(['install', '--harness', 'opencode'], home, cwd, { ...env, XDG_CONFIG_HOME: xdg });
    assert.equal(openOverride.status, 0, openOverride.stderr);
    assert.equal(existsSync(path.join(xdg, 'opencode', 'plugins', 'cosplaying.js')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
