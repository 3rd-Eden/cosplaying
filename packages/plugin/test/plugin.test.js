import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv, writeSpawnStub } from '../../cli/test/spawn-stub.js';
import { block, defaultSpawn, installPlugin, listPlugins, resolveRealBin, uninstallPlugin, withAttributedCopy } from '../src/index.js';

function home() {
  return mkdtempSync(path.join(tmpdir(), 'cosplaying-plugin-'));
}

test('a package named hook is not installed', async () => {
  const directory = home();
  const source = path.join(directory, 'hook');
  mkdirSync(source);
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'hook',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  }));
  writeFileSync(path.join(source, 'index.js'), 'export default function run() { return 0; }\n');
  const result = await installPlugin(source, { home: directory, platform: 'linux', env: {}, cwd: directory });
  assert.equal(result.ok, false);
  assert.match(result.error, /reserved/);
  rmSync(directory, { recursive: true, force: true });
});

test('block writes the standard message and withAttributedCopy removes its temp file', async () => {
  let text = '';
  block({ write(chunk) { text += chunk; } }, 'Pass --message <text>.');
  assert.match(text, /^cosplaying: BLOCKED \(command not run\)\nReason: Pass --message <text>\.\nIf no safe correction is stated, stop and ask the user; do not bypass cosplaying\.\n$/);
  const directory = home();
  const source = path.join(directory, 'body.md');
  writeFileSync(source, 'Hello\n');
  let copyPath = '';
  let copy = '';
  await withAttributedCopy(source, (value) => `${value.trim()}\nbyline\n`, (file) => {
    copyPath = file;
    copy = readFileSync(file, 'utf8');
    assert.equal(readFileSync(source, 'utf8'), 'Hello\n');
    assert.equal(path.extname(file), '.md');
    assert.match(path.basename(file), new RegExp(`^cosplaying-${process.pid}-[0-9a-f]{8}\\.md$`));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(path.dirname(file), tmpdir());
  });
  assert.match(copy, /byline/);
  assert.equal(existsSync(copyPath), false);
  await assert.rejects(withAttributedCopy(source, () => { throw new Error('bad template'); }, () => {
    throw new Error('spawned');
  }), /bad template/);
  await assert.rejects(
    () => withAttributedCopy(path.join(directory, 'missing.md'), (value) => value, () => {}),
    (error) => {
      assert.equal(error.name, 'LayerError');
      assert.equal(error.method, 'withAttributedCopy');
      assert.match(error.message, /missing\.md/);
      assert.match(error.message, /Check that the source file exists and is readable/);
      assert.match(error.message, /packages\/plugin\/README\.md#error-[0-9a-f]{6}/);
      return true;
    },
  );
});

test('withAttributedCopy keeps an extensionless name and rejects invalid UTF-8', async () => {
  const directory = home();
  try {
    const plain = path.join(directory, 'notes');
    writeFileSync(plain, 'Hello\n');
    let copyPath = '';
    await withAttributedCopy(plain, (value) => value, (file) => {
      copyPath = file;
      assert.equal(path.extname(file), '');
      assert.match(path.basename(file), new RegExp(`^cosplaying-${process.pid}-[0-9a-f]{8}$`));
      if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(readFileSync(file, 'utf8'), 'Hello\n');
    });
    assert.equal(existsSync(copyPath), false);

    const source = path.join(directory, 'body.md');
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    writeFileSync(source, bytes);
    let calls = 0;
    await assert.rejects(
      () => withAttributedCopy(source, () => {
        calls += 1;
        return 'rendered';
      }, () => {
        calls += 1;
        return 0;
      }),
      (error) => {
        assert.equal(error.name, 'LayerError');
        assert.equal(error.method, 'withAttributedCopy');
        assert.match(error.message, /body\.md/);
        assert.match(error.message, /file is not valid UTF-8/);
        assert.match(error.message, /packages\/plugin\/README\.md#error-[0-9a-f]{6}/);
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.deepEqual(readFileSync(source), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('defaultSpawn exits 127 when the program cannot be started', async () => {
  const directory = home();
  try {
    const missing = path.join(directory, 'missing-bin');
    const sentence = /cosplaying: could not run missing-bin: .+\. The command was not run\. Set COSPLAYING_MISSING_BIN_BIN to its executable path\./;
    let syncText = '';
    const sync = defaultSpawn(missing, ['--version'], {
      encoding: 'utf8',
      stderr: { write(chunk) { syncText += chunk; } },
    });
    assert.equal(sync.status, 127);
    assert.equal(sync.error && sync.error.code, 'ENOENT');
    assert.match(syncText, sentence);

    const entry = new URL('../src/index.js', import.meta.url).href;
    const script = path.join(directory, 'probe-spawn.mjs');
    writeFileSync(script, `import { defaultSpawn } from ${JSON.stringify(entry)};
const result = defaultSpawn(${JSON.stringify(missing)}, ['--version'], { encoding: 'utf8' });
const stderr = typeof result.stderr === 'string' ? result.stderr : '';
process.stdout.write(JSON.stringify({ status: result.status, code: result.error && result.error.code, stderr }));
`);
    const probe = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const bare = JSON.parse(probe.stdout);
    assert.equal(bare.status, 127);
    assert.equal(bare.code, 'ENOENT');
    assert.match(`${probe.stderr}${bare.stderr}`, sentence);

    let asyncText = '';
    const asyncResult = await defaultSpawn(missing, ['--version'], {
      stdio: 'inherit',
      stderr: { write(chunk) { asyncText += chunk; } },
    });
    assert.equal(asyncResult.status, 127);
    assert.equal(asyncResult.error && asyncResult.error.code, 'ENOENT');
    assert.match(asyncText, sentence);

    const syncOk = defaultSpawn(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
    assert.equal(syncOk.status, 0);
    const asyncOk = await defaultSpawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    assert.equal(asyncOk.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('install, list, and uninstall a local plugin without deleting the source', async () => {
  const directory = home();
  const source = path.join(directory, 'notify');
  mkdirSync(source);
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'notify',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  }));
  writeFileSync(path.join(source, 'index.js'), 'export default function run() { return 0; }\n// notify\n');
  const options = { home: directory, platform: 'linux', env: {}, cwd: directory };
  const installed = await installPlugin(source, options);
  assert.equal(installed.ok, true);
  const listed = await listPlugins(options);
  assert.equal(listed[0].command, 'notify');
  assert.equal(listed[0].kind, 'path');
  const again = await installPlugin(source, options);
  assert.equal(again.ok, false);
  assert.equal((await uninstallPlugin('notify', options)).ok, true);
  assert.equal(readFileSync(path.join(source, 'index.js'), 'utf8').includes('notify'), true);
  rmSync(directory, { recursive: true, force: true });
});

const cli = fileURLToPath(new URL('../../cli/bin/cosplaying.js', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} home
 * @param {string} cwd
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

test('plugin install rejects a TypeScript entry, a path outside the package, and a bad command token', () => {
  const homeDir = home();
  const cwd = home();
  try {
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
    const bin = writeSpawnStub(path.join(homeDir, 'localplug-bin'), '#!/bin/sh\nexit 0\n');
    const loaded = spawnSync(process.execPath, [cli, 'hook', '--', 'localplug'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...systemEnv(),
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR,
        COSPLAYING_LOCALPLUG_BIN: bin,
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
      name: '@docs/notify',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    writeFileSync(path.join(source, 'index.js'), 'export default function run() { return 0; }\n');
    const installed = runCli(['plugin', 'install', source], homeDir, cwd);
    assert.equal(installed.status, 0, installed.stderr);
    const directory = path.join(homeDir, '.local', 'share', 'cosplaying', 'plugins', '@docs', 'notify');
    assert.equal(installed.stdout, `notify\t${directory}\n`);
    const listed = runCli(['plugin', 'list'], homeDir, cwd);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, `notify\tnotify\tpath\t${directory}\n`);
    const rewritten = runCli(['rewrite', 'notify --list'], homeDir, cwd);
    assert.equal(rewritten.status, 0, rewritten.stderr);
    assert.match(rewritten.stdout, /hook -- notify --list\n$/);
    const again = runCli(['plugin', 'install', source], homeDir, cwd);
    assert.equal(again.status, 1, again.stdout);
    assert.match(again.stderr, /already installed/);
    assert.match(again.stderr, /plugin uninstall notify/);
    assert.equal(existsSync(path.join(directory, 'package.json')), true);
    assert.equal(readFileSync(path.join(source, 'index.js'), 'utf8').includes('run'), true);
    const removed = runCli(['plugin', 'uninstall', 'notify'], homeDir, cwd);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout, 'notify\n');
    assert.equal(runCli(['plugin', 'list'], homeDir, cwd).stdout, '');
    assert.equal(existsSync(directory), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveRealBin honors an absolute override and skips this CLI', () => {
  const directory = home();
  const bin = path.join(directory, 'notify');
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  const resolved = resolveRealBin('notify', {
    env: { COSPLAYING_NOTIFY_BIN: bin, PATH: directory },
    platform: 'linux',
  });
  assert.equal(resolved.bin, bin);
  const missing = resolveRealBin('notify', { env: { PATH: '' }, platform: 'linux' });
  assert.match(missing.error, /notify/);
});
