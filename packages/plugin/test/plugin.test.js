import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Creates a temporary directory that a plugin test can use as a home or a working directory.
 *
 * @returns {string} Absolute path of the new directory.
 */
function home() {
  return mkdtempSync(path.join(tmpdir(), 'cosplaying-plugin-'));
}

const cli = fileURLToPath(new URL('../../cli/bin/cosplaying.js', import.meta.url));

/**
 * Runs the cosplaying CLI against a temporary home.
 *
 * `PATH` is the system path only, so plugin lookup does not use a developer install.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory.
 * @param {string} cwd Working directory for the CLI.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function runCli(args, home, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
}

test('plugin install and loading reject reserved names, TypeScript, escaping entries, and invalid command tokens', () => {
  const homeDir = home();
  const cwd = home();
  try {
    const reserved = path.join(cwd, 'reserved');
    mkdirSync(reserved);
    writeFileSync(path.join(reserved, 'package.json'), JSON.stringify({
      name: 'hook', version: '1.0.0', type: 'module', main: './index.js',
    }));
    writeFileSync(path.join(reserved, 'index.js'), 'export default function run() { return 0; }\n');
    const refusal = runCli(['plugin', 'install', reserved], homeDir, cwd);
    assert.equal(refusal.status, 1);
    assert.match(refusal.stderr, /reserved/);
    assert.equal(existsSync(path.join(homeDir, '.local', 'share', 'cosplaying', 'plugins', 'hook')), false);

    const typed = path.join(cwd, 'typed');
    mkdirSync(typed);
    writeFileSync(path.join(typed, 'package.json'), JSON.stringify({
      name: 'typed',
      version: '1.0.0',
      type: 'module',
      main: './index.ts',
    }));
    writeFileSync(path.join(typed, 'index.ts'), 'export default function run() { return 0; }\n');
    const typescript = runCli(['plugin', 'install', typed], homeDir, cwd);
    assert.equal(typescript.status, 1, typescript.stderr);
    assert.match(typescript.stderr, /TypeScript/);
    assert.match(typescript.stderr, /JavaScript/);
    assert.equal(existsSync(path.join(homeDir, '.local', 'share', 'cosplaying', 'plugins', 'typed')), false);

    const escaped = path.join(cwd, 'escaped');
    mkdirSync(escaped);
    writeFileSync(path.join(cwd, 'outside.js'), 'export default function run() { return 0; }\n');
    writeFileSync(path.join(escaped, 'package.json'), JSON.stringify({
      name: 'escaped',
      version: '1.0.0',
      type: 'module',
      main: '../outside.js',
    }));
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [escaped] }));
    const outside = runCli(['rewrite', 'echo hi'], homeDir, cwd);
    assert.equal(outside.status, 1, outside.stderr);
    assert.match(outside.stderr, /outside/);
    assert.equal(outside.stdout, '');

    const dotted = path.join(cwd, 'dotted');
    mkdirSync(dotted);
    writeFileSync(path.join(dotted, 'package.json'), JSON.stringify({
      name: 'bad.name',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(dotted, 'index.js'), 'export default function run() { return 0; }\n');
    const token = runCli(['plugin', 'install', dotted], homeDir, cwd);
    assert.equal(token.status, 1, token.stderr);
    assert.match(token.stderr, /bad\.name/);
    assert.match(token.stderr, /single token/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('plugin install installs a local git repository', () => {
  const homeDir = home();
  const cwd = home();
  try {
    const repo = path.join(cwd, 'localgit');
    mkdirSync(repo);
    const git = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    assert.equal(existsSync(path.join(repo, '.git', 'HEAD')), true);
    const body = 'export const marker = "from-git-repo";\nexport default function run() { return 0; }\n';
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      name: 'localgit',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(repo, 'index.js'), body);
    const installed = runCli(['plugin', 'install', repo], homeDir, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    const [name, directory] = installed.stdout.trim().split('\t');
    assert.equal(name, 'localgit');
    assert.equal(readFileSync(path.join(directory, 'index.js'), 'utf8'), body);
    assert.equal(readFileSync(path.join(repo, 'index.js'), 'utf8'), body);
    assert.equal(existsSync(path.join(repo, '.git', 'HEAD')), true);
    const listed = runCli(['plugin', 'list'], homeDir, cwd);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^localgit\tlocalgit\tpath\t/m);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('plugin install installs a local file dependency and the command can load it', () => {
  const homeDir = home();
  const cwd = home();
  try {
    const dep = path.join(cwd, 'local-dep');
    mkdirSync(dep);
    writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
      name: 'local-dep',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(dep, 'index.js'), 'export const marker = "loaded-local-dep";\n');
    const source = path.join(cwd, 'localplug');
    mkdirSync(source);
    writeFileSync(path.join(source, 'package.json'), `${JSON.stringify({
      name: 'localplug',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      dependencies: { 'local-dep': 'file:../local-dep' },
    }, null, 2)}\n`);
    writeFileSync(path.join(source, 'index.js'), [
      'import { marker } from "local-dep";',
      'export default async function run(_args, context) {',
      '  context.stdout.write(`${marker}\\n`);',
      '  return 0;',
      '}',
      '',
    ].join('\n'));
    const installed = runCli(['plugin', 'install', source], homeDir, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    const [name, directory] = installed.stdout.trim().split('\t');
    assert.equal(name, 'localplug');
    assert.equal(existsSync(path.join(directory, 'node_modules', 'local-dep', 'package.json')), true);
    assert.equal(existsSync(path.join(source, 'node_modules')), false);
    assert.match(readFileSync(path.join(source, 'package.json'), 'utf8'), /file:\.\.\/local-dep/);
    const loaded = spawnSync(process.execPath, [cli, 'hook', '--', 'localplug'], {
      cwd,
      encoding: 'utf8',
      env: {
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR,
        COSPLAYING_LOCALPLUG_BIN: path.join(source, 'package.json'),
      },
    });
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout, 'loaded-local-dep\n');
    const removed = runCli(['plugin', 'uninstall', 'localplug'], homeDir, cwd);
    assert.equal(removed.status, 0, removed.stderr);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('plugin uninstall refuses a name outside the data directory', () => {
  const homeDir = home();
  const cwd = home();
  try {
    const keep = path.join(homeDir, 'keep.txt');
    writeFileSync(keep, 'safe');
    const result = runCli(['plugin', 'uninstall', '..'], homeDir, cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the data directory/);
    assert.equal(readFileSync(keep, 'utf8'), 'safe');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a scoped package is listed, rewritten, and removed by its unscoped name', () => {
  const homeDir = home();
  const cwd = home();
  try {
    const source = path.join(cwd, 'scoped');
    mkdirSync(source);
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: '@docs/byline',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(source, 'index.js'), 'export default function run() { return 0; }\n');
    const installed = runCli(['plugin', 'install', source], homeDir, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    const directory = path.join(homeDir, '.local', 'share', 'cosplaying', 'plugins', '@docs', 'byline');
    assert.equal(installed.stdout, `byline\t${directory}\n`);
    const listed = runCli(['plugin', 'list'], homeDir, cwd);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, `byline\tbyline\tpath\t${directory}\n`);
    const rewritten = runCli(['rewrite', 'byline --list'], homeDir, cwd);
    assert.equal(rewritten.status, 0, rewritten.stderr);
    assert.match(rewritten.stdout, /hook -- byline --list\n$/);
    const again = runCli(['plugin', 'install', source], homeDir, cwd);
    assert.equal(again.status, 1, again.stdout);
    assert.match(again.stderr, /already installed/);
    assert.match(again.stderr, /plugin uninstall byline/);
    assert.equal(existsSync(path.join(directory, 'package.json')), true);
    assert.equal(readFileSync(path.join(source, 'index.js'), 'utf8'), 'export default function run() { return 0; }\n');
    const removed = runCli(['plugin', 'uninstall', 'byline'], homeDir, cwd);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout, 'byline\n');
    assert.equal(runCli(['plugin', 'list'], homeDir, cwd).stdout, '');
    assert.equal(existsSync(directory), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});


test('plugin spawn returns real child statuses and reports sync and async launch failures', () => {
  const homeDir = home();
  const cwd = home();
  const source = path.join(cwd, 'runprocess');
  try {
    mkdirSync(source);
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'runprocess', version: '1.0.0', type: 'module', main: 'index.js',
    }));
    writeFileSync(path.join(source, 'index.js'), String.raw`
import path from 'node:path';
export default async function run(args, context) {
  const missing = args[0] === 'missing';
  const command = missing ? path.join(context.cwd, 'absent-command') : process.execPath;
  const options = { cwd: context.cwd, env: context.env };
  if (args[1] === 'sync') options.encoding = 'utf8';
  else options.stdio = 'inherit';
  const result = await context.spawn(command, missing ? [] : ['-e', 'process.exit(7)'], options);
  context.stdout.write(JSON.stringify({ status: result.status, code: result.error?.code }) + '\n');
  return result.status;
}
`);
    writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [source] }));
    for (const mode of ['sync', 'async']) {
      for (const outcome of ['missing', 'success']) {
        const result = spawnSync(process.execPath, [cli, 'hook', '--', 'runprocess', outcome, mode], {
          cwd,
          encoding: 'utf8',
          env: {
            HOME: homeDir, USERPROFILE: homeDir,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            COSPLAYING_RUNPROCESS_BIN: path.join(source, 'package.json'),
          },
        });
        assert.equal(result.status, outcome === 'missing' ? 127 : 7, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), outcome === 'missing'
          ? { status: 127, code: 'ENOENT' }
          : { status: 7 });
        if (outcome === 'missing') {
          assert.match(result.stderr, /cosplaying: could not run absent-command: .+\. The command was not run\. Set COSPLAYING_ABSENT_COMMAND_BIN to its executable path\./);
        } else {
          assert.equal(result.stderr, '');
        }
      }
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
