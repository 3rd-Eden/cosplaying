import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv, writeSpawnStub } from './spawn-stub.js';
import { DEFAULT_LINK, DEFAULT_TRAILER, loadConfig, userConfigDirectory } from '../src/config.js';

const notify = fileURLToPath(new URL('../../../examples/notify', import.meta.url));

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

function temp() {
  return mkdtempSync(path.join(tmpdir(), 'cosplaying-config-'));
}

test('defaults, then the user file, then the nearest project file', () => {
  const home = temp();
  const cwd = temp();
  const user = userConfigDirectory({ home });
  mkdirSync(user, { recursive: true });
  writeFileSync(path.join(user, '.cosplaying.json'), JSON.stringify({
    link: 'https://example.com/user',
    variables: { team: 'user', owner: 'kept' },
    attribution: { templates: { markdown: 'user {model}' } },
  }));
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({
    link: 'https://example.com/project',
    variables: { team: 'project' },
    plugins: ['./notify'],
  }));
  const config = loadConfig({
    cwd,
    home,
    env: {
      COSPLAYING_LINK: 'https://example.com/env',
      COSPLAYING_ATTRIBUTION_TEMPLATE: 'env {model}',
      COSPLAYING_ATTRIBUTION_TEMPLATE_MARKDOWN: 'env markdown {model}',
      COSPLAYING_ATTRIBUTION_TEMPLATE_TRAILER: 'env trailer',
    },
  });
  assert.equal(config.link, 'https://example.com/project');
  assert.equal(config.markdown, 'user {model}');
  assert.equal(config.trailer, DEFAULT_TRAILER);
  assert.equal(config.variables.team, 'project');
  assert.equal(config.variables.owner, 'kept');
  assert.deepEqual(config.plugins, ['./notify']);
});

test('missing files keep the default link', () => {
  const config = loadConfig({ cwd: temp(), home: temp(), env: {} });
  assert.equal(config.link, DEFAULT_LINK);
});

test('a project yaml file supplies the link', () => {
  const home = temp();
  const cwd = temp();
  writeFileSync(path.join(cwd, '.cosplaying.yaml'), 'link: https://example.com/yaml\n');
  const config = loadConfig({ cwd, home, env: {} });
  assert.equal(config.link, 'https://example.com/yaml');
});

test('a config model and a second project file block the command', () => {
  const home = temp();
  const cwd = temp();
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ model: 'FromConfig' }));
  const model = spawnSync(process.execPath, [bin, 'rewrite', 'echo hi'], {
    cwd,
    env: { HOME: home },
    encoding: 'utf8',
  });
  assert.equal(model.status, 1);
  assert.match(model.stderr, /cannot set the model/);
  assert.match(model.stderr, /COSPLAYING_MODEL/);
  assert.equal(model.stdout, '');

  const nestedHome = temp();
  const nestedCwd = temp();
  writeFileSync(path.join(nestedCwd, '.cosplaying.json'), JSON.stringify({
    attribution: { model: 'FromConfig' },
  }));
  const nested = spawnSync(process.execPath, [bin, 'rewrite', 'echo hi'], {
    cwd: nestedCwd,
    env: { HOME: nestedHome },
    encoding: 'utf8',
  });
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /cannot set the model/);

  const duplicateHome = temp();
  const duplicateCwd = temp();
  writeFileSync(path.join(duplicateCwd, '.cosplaying.json'), JSON.stringify({ link: 'https://example.com/json' }));
  writeFileSync(path.join(duplicateCwd, '.cosplaying.yaml'), 'link: https://example.com/yaml\n');
  const duplicate = spawnSync(process.execPath, [bin, 'rewrite', 'echo hi'], {
    cwd: duplicateCwd,
    env: { HOME: duplicateHome },
    encoding: 'utf8',
  });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /more than one config file/);
  assert.match(duplicate.stderr, /\.cosplaying\.json/);
  assert.match(duplicate.stderr, /\.cosplaying\.yaml/);
  assert.equal(duplicate.stdout, '');
});

test('an optional config field of the wrong type does not stop the command', () => {
  const home = temp();
  const cwd = temp();
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ variables: 'notify' }));
  const result = spawnSync(process.execPath, [bin, 'rewrite', 'echo hi'], {
    cwd,
    env: { HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'echo hi\n');
  assert.equal(result.stderr, '');
});

test('invalid JSON and invalid YAML config files fail and name the file', () => {
  const jsonHome = temp();
  const jsonCwd = temp();
  const jsonFile = path.join(jsonCwd, '.cosplaying.json');
  writeFileSync(jsonFile, '{');
  const json = spawnSync(process.execPath, [bin, 'rewrite', 'echo hi'], {
    cwd: jsonCwd,
    env: { HOME: jsonHome },
    encoding: 'utf8',
  });
  assert.equal(json.status, 1);
  assert.equal(json.stdout, '');
  assert.match(json.stderr, /could not be read/);
  assert.match(json.stderr, /JSON Error in/);
  assert.equal(json.stderr.includes(realpathSync(jsonFile)), true);

  const yamlHome = temp();
  const yamlCwd = temp();
  const yamlFile = path.join(yamlCwd, '.cosplaying.yaml');
  writeFileSync(yamlFile, 'link: [\n');
  const yaml = spawnSync(process.execPath, [bin, 'rewrite', 'echo hi'], {
    cwd: yamlCwd,
    env: { HOME: yamlHome },
    encoding: 'utf8',
  });
  assert.equal(yaml.status, 1);
  assert.equal(yaml.stdout, '');
  assert.match(yaml.stderr, /could not be read/);
  assert.match(yaml.stderr, /YAML Error in/);
  assert.equal(yaml.stderr.includes(realpathSync(yamlFile)), true);
});

test('hook trailer keeps a user variable and lets the project replace the same key', () => {
  const home = temp();
  const cwd = temp();
  try {
    const userDir = userConfigDirectory({ home });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, '.cosplaying.json'), `${JSON.stringify({
      variables: { team: 'user', owner: 'kept' },
      attribution: { templates: { trailer: '{model} {team} {owner}' } },
    })}\n`);
    writeFileSync(path.join(cwd, '.cosplaying.json'), `${JSON.stringify({
      variables: { team: 'project' },
      plugins: [notify],
    })}\n`);
    const program = writeSpawnStub(path.join(home, 'notify'), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    const result = spawnSync(process.execPath, [
      bin, 'hook', '--model', 'Example', '--', 'notify', '--message', 'hi',
    ], {
      cwd,
      encoding: 'utf8',
      env: {
        ...systemEnv(),
        HOME: home,
        USERPROFILE: home,
        COSPLAYING_NOTIFY_BIN: program,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '--message\nhi\nAI-Assisted-By: Example project kept\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
