import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Runs the CLI with a temporary home and a fixed `PATH`.
 *
 * Extra environment values are added after the defaults, so a test can set a plugin override.
 *
 * @param {string[]} args Arguments after the program name.
 * @param {string} home Temporary home directory. It is both `HOME` and `USERPROFILE`.
 * @param {string} cwd Working directory for the CLI.
 * @param {NodeJS.ProcessEnv} [env={}] Extra environment variables. They replace defaults of the same name.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} The CLI result. `stdout` and `stderr` are strings.
 */
function run(args, home, cwd, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
      ...env,
    },
  });
}

test('the emitted hook command runs with its model and arguments', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-prefix-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-prefix-cwd-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const plugin = path.join(cwd, 'byline');
  mkdirSync(plugin);
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'byline', version: '1.0.0', type: 'module', main: './index.js' }));
  writeFileSync(path.join(plugin, 'index.js'), 'export default function run(args, context) { context.stdout.write(JSON.stringify({ args, model: context.model })); return 0; }\n');
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [plugin] }));
  const env = { COSPLAYING_BYLINE_BIN: path.join(plugin, 'index.js') };
  const rewritten = run(['rewrite', '--model', 'Example Model', '--', 'byline --list'], home, cwd, env);
  assert.equal(rewritten.status, 0, rewritten.stderr);
  assert.equal(rewritten.stderr, '');
  const executed = spawnSync(rewritten.stdout.trim(), {
    shell: true, cwd, encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stderr, '');
  assert.deepEqual(JSON.parse(executed.stdout), { args: ['--list'], model: 'Example Model' });
});
