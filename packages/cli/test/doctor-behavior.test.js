import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemEnv, writeSpawnStub } from './spawn-stub.js';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(args, home, cwd, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...systemEnv(),
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      ...env,
    },
  });
}

/**
 * @returns {{home: string, cwd: string}}
 */
function isolated() {
  return {
    home: mkdtempSync(path.join(tmpdir(), 'cosplaying-doctor-home-')),
    cwd: mkdtempSync(path.join(tmpdir(), 'cosplaying-doctor-cwd-')),
  };
}

/**
 * @param {unknown} value
 * @param {(command: string) => string} visitCommand
 */
function mapCommands(value, visitCommand) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) mapCommands(entry, visitCommand);
    return;
  }
  if (typeof value.command === 'string') value.command = visitCommand(value.command);
  for (const entry of Object.values(value)) mapCommands(entry, visitCommand);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function commandStrings(value) {
  /** @type {string[]} */
  const commands = [];
  mapCommands(value, (command) => {
    commands.push(command);
    return command;
  });
  return commands;
}

test('doctor reports an unrecognized hook command without running it', () => {
  const { home, cwd } = isolated();
  const installed = run(['install', '-H', 'claude-code'], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const file = path.join(home, '.claude', 'settings.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const marker = path.join(home, 'ran');
  const script = path.join(home, 'ran.sh');
  writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(script, 0o755);
  const command = `${script} agent-hook claude-code PreToolUse # cosplaying:claude-code`;
  const assigned = `FOO=bar ${command}`;
  const visit = (value, next) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, next);
      return;
    }
    if (typeof value.command === 'string') value.command = next;
    for (const entry of Object.values(value)) visit(entry, next);
  };
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    visit(entries, event === 'SessionStart' ? assigned : command);
  }
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  const doctor = run(['doctor'], home, cwd);
  assert.notEqual(doctor.status, 0, doctor.stderr);
  assert.equal(existsSync(marker), false);
  assert.match(doctor.stderr, /unexpected executable/);
  assert.match(doctor.stderr, /direct invocation/);
});

test('doctor --repair rewrites the inspected project scope', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-repair-home-'));
  const project = path.join(home, 'project');
  mkdirSync(project);
  const userInstall = run(['install', '-H', 'codex'], home, project);
  assert.equal(userInstall.status, 0, userInstall.stderr);
  const projectInstall = run(['install', '-H', 'codex', '--project-dir', project], home, project);
  assert.equal(projectInstall.status, 0, projectInstall.stderr);
  const userFile = path.join(home, '.codex', 'hooks.json');
  const projectFile = path.join(project, '.codex', 'hooks.json');
  const userBefore = readFileSync(userFile, 'utf8');
  const stale = path.join(home, 'missing-node', 'node');
  const projectParsed = JSON.parse(readFileSync(projectFile, 'utf8'));
  mapCommands(projectParsed, (command) => command.replaceAll(process.execPath, stale));
  const rewritten = `${JSON.stringify(projectParsed, null, 2)}\n`;
  assert.notEqual(rewritten, userBefore);
  assert.match(rewritten, /missing-node/);
  writeFileSync(projectFile, rewritten);
  const doctor = run(['doctor', '--repair', '--project-dir', project], home, project);
  const projectAfter = readFileSync(projectFile, 'utf8');
  const after = commandStrings(JSON.parse(projectAfter));
  assert.equal(after.length > 0, true, projectAfter);
  assert.equal(after.some((command) => command.includes(stale)), false, projectAfter);
  assert.equal(after.every((command) => command.includes(process.execPath)), true, projectAfter);
  assert.equal(readFileSync(userFile, 'utf8'), userBefore);
  assert.equal(doctor.stdout.includes(`cosplaying doctor: repaired ${projectFile}`), true, doctor.stdout);
  const trust = 'Codex CLI: run /hooks, review cosplaying\'s updated hook definitions, then trust them again.';
  assert.equal(doctor.stdout.split(trust).length - 1, 1, doctor.stdout);
});

test('a managed file missing an event is a finding', () => {
  const { home, cwd } = isolated();
  const installed = run(['install', '-H', 'claude-code'], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const file = path.join(home, '.claude', 'settings.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  delete parsed.hooks.SessionStart;
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  const doctor = run(['doctor'], home, cwd);
  assert.notEqual(doctor.status, 0);
  assert.match(doctor.stderr, /missing managed SessionStart hook/);
});

test('PATH cosplaying with a different version is a finding', () => {
  const { home, cwd } = isolated();
  const installed = run(['install'], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const binDir = path.join(home, 'bin');
  mkdirSync(binDir);
  const log = path.join(home, 'path-log');
  const shell = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '9.9.9'\n  exit 0\nfi\nexit 0\n`;
  writeSpawnStub(path.join(binDir, 'cosplaying'), shell, { log, version: '9.9.9' });
  const doctor = run(['doctor'], home, cwd, { PATH: binDir });
  assert.match(doctor.stderr, /PATH: version 9\.9\.9 differs from 0\.1\.0/);
  const recorded = readFileSync(log, 'utf8');
  assert.match(recorded, /--version/);
  assert.doesNotMatch(recorded, /--help/);
});

test('doctor with no findings names the managed installs', () => {
  const { home, cwd } = isolated();
  const installed = run(['install'], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const doctor = run(['doctor'], home, cwd);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /cosplaying doctor: no findings \(6 managed installs checked\)/);
});

test('doctor does not claim Codex, Claude Code, or Gemini hooks are approved', () => {
  const { home, cwd } = isolated();
  const installed = run(['install'], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const doctor = run(['doctor'], home, cwd);
  assert.equal(doctor.status, 0, doctor.stderr);
  const output = `${doctor.stdout}${doctor.stderr}`;
  assert.equal(output.includes('Codex, Claude Code, or Gemini hooks are approved'), false, output);
  assert.equal(output.includes('hook is trusted'), false, output);
  assert.equal(output.includes('approved'), false, output);
});

test('--project-dir must be a directory', () => {
  const { home, cwd } = isolated();
  const missing = path.join(cwd, 'no-such-dir');
  const doctor = run(['doctor', '--project-dir', missing], home, cwd);
  assert.equal(doctor.status, 2, doctor.stderr);
  assert.match(doctor.stderr, /not a directory/);
  assert.doesNotMatch(doctor.stderr, /missing owned hook/);
  const file = path.join(cwd, 'not-a-dir');
  writeFileSync(file, 'x');
  const again = run(['doctor', '--project-dir', file], home, cwd);
  assert.equal(again.status, 2, again.stderr);
  assert.doesNotMatch(again.stderr, /missing owned hook/);
});

test('doctor probes a hook whose executable is this cosplaying bin', {
  skip: process.platform === 'win32' ? 'Windows will not execute the shebang cosplaying.js bin' : false,
}, () => {
  const { home, cwd } = isolated();
  const nodeDir = path.join(home, 'node-bin');
  mkdirSync(nodeDir);
  symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  const pathEnv = `${nodeDir}${path.delimiter}/usr/bin:/bin`;
  const installed = run(['install', '--bin', bin], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const text = readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
  assert.match(text, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(text, /main\.js/);
  const doctor = run(['doctor', '--bin', bin], home, cwd, { PATH: pathEnv });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /cosplaying doctor: no findings \(6 managed installs checked\)/);
});

test('Pi and OpenCode block a wrapped command when rewrite cannot start', async () => {
  const { home, cwd } = isolated();
  const notify = fileURLToPath(new URL('../../../examples/notify', import.meta.url));
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [notify] }));
  const missing = path.join(home, 'missing-cosplaying');
  const installed = run(['install', '--harness', 'pi,opencode', '--bin', missing], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const piFile = path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js');
  const openFile = path.join(home, '.config', 'opencode', 'plugins', 'cosplaying.js');
  for (const file of [piFile, openFile]) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^\/\/ cosplaying:/);
    assert.doesNotMatch(text, /from ['"]cosplaying/);
    assert.match(text, /COMMANDS = \["notify"\]/);
  }
  const pi = await import(pathToFileURL(piFile).href);
  /** @type {Record<string, Function>} */
  const handlers = {};
  pi.default({ on(name, fn) { handlers[name] = fn; } });
  const blocked = handlers.tool_call(
    { toolName: 'bash', input: { command: 'sudo -u root notify --list' } },
    { model: { id: 'Example' } },
  );
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /cosplaying hook/);
  assert.equal(handlers.tool_call(
    { toolName: 'bash', input: { command: 'echo notify' } },
    { model: { id: 'Example' } },
  ), undefined);
  const open = await import(pathToFileURL(openFile).href);
  const api = await open.Plugin();
  await assert.rejects(
    () => api['tool.execute.before']({ tool: 'Shell' }, { args: { command: 'notify --message hi' } }),
    /cosplaying hook/,
  );
  const args = { command: 'echo notify' };
  await api['tool.execute.before']({ tool: 'bash' }, { args });
  assert.equal(args.command, 'echo notify');
});

test('doctor --repair does not rewrite an invalid UTF-8 Pi extension', () => {
  const { home, cwd } = isolated();
  const installed = run(['install', '-H', 'pi'], home, cwd);
  assert.equal(installed.status, 0, installed.stderr);
  const file = path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js');
  const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from('// cosplaying:pi\n')]);
  writeFileSync(file, bytes);
  const doctor = run(['doctor', '--repair'], home, cwd);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(doctor.stdout.includes(`repaired ${file}`), false, doctor.stdout);
  assert.equal(doctor.stderr.includes(`invalid config ${file}: file is not valid UTF-8`), true, doctor.stderr);
  assert.equal(doctor.stderr.includes('Replace the file with UTF-8 JSON, or move it aside and run cosplaying install again.'), true, doctor.stderr);
  assert.notEqual(doctor.status, 0);
});
