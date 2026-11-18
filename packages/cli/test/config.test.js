import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));

/**
 * Creates one temporary directory for a settings-file test.
 *
 * The caller uses it as a home or as a working directory so the developer directories are not read.
 *
 * @returns {string} Absolute path of the new directory.
 */
function temp() {
  return mkdtempSync(path.join(tmpdir(), 'cosplaying-config-'));
}

test('hook renders defaults and selected JSON or YAML settings with user and project precedence', () => {
  const home = temp();
  const cwd = temp();
  const source = path.join(cwd, 'configview');
  const user = path.join(home, '.config', 'cosplaying');
  try {
    mkdirSync(source);
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'configview', version: '1.0.0', type: 'module', main: 'index.js',
    }));
    writeFileSync(path.join(source, 'index.js'), String.raw`export default function run(args, context) {
  context.stdout.write(JSON.stringify({
    markdown: context.attribution.annotateMarkdown('Hello'),
    trailer: context.attribution.renderTrailer(),
  }) + '\n');
  return 0;
}
`);
    const env = { HOME: home, USERPROFILE: home, COSPLAYING_CONFIGVIEW_BIN: path.join(source, 'package.json') };
    const installed = spawnSync(process.execPath, [bin, 'plugin', 'install', source], { cwd, env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const rows = [
      {
        name: 'defaults',
        markdown: '> 🤖 Authored by Example via [cosplaying](https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.',
        trailer: 'AI-Assisted-By: Example via cosplaying (https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.',
      },
      {
        name: 'user and nearest project',
        user: { variables: { team: 'user', owner: 'kept' }, attribution: { link: 'https://example.com/user', templates: { markdown: 'User {model} {team} {owner}' } } },
        project: { link: 'https://example.com/project', variables: { team: 'project' } },
        markdown: 'User Example project kept',
        trailer: 'AI-Assisted-By: Example via cosplaying (https://example.com/project). AI Assisted text may contain mistakes, please verify.',
      },
      {
        name: 'trailer variables',
        user: { variables: { team: 'user', owner: 'kept' }, attribution: { templates: { trailer: '{model} {team} {owner}' } } },
        project: { variables: { team: 'project' } },
        markdown: '> 🤖 Authored by Example via [cosplaying](https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.',
        trailer: 'AI-Assisted-By: Example project kept',
      },
      {
        name: 'YAML',
        yaml: 'link: https://example.com/yaml\n',
        markdown: '> 🤖 Authored by Example via [cosplaying](https://example.com/yaml). AI Assisted text may contain mistakes, please verify.',
        trailer: 'AI-Assisted-By: Example via cosplaying (https://example.com/yaml). AI Assisted text may contain mistakes, please verify.',
      },
      {
        name: 'first configured file',
        project: { link: 'https://example.com/json' },
        yaml: 'link: https://example.com/ignored\n',
        markdown: '> 🤖 Authored by Example via [cosplaying](https://example.com/json). AI Assisted text may contain mistakes, please verify.',
        trailer: 'AI-Assisted-By: Example via cosplaying (https://example.com/json). AI Assisted text may contain mistakes, please verify.',
      },
    ];
    const nested = path.join(cwd, 'nested');
    mkdirSync(nested);
    for (const row of rows) {
      rmSync(path.join(user, '.cosplaying.json'), { force: true });
      rmSync(path.join(cwd, '.cosplaying.json'), { force: true });
      rmSync(path.join(cwd, '.cosplaying.yaml'), { force: true });
      if (row.user) {
        mkdirSync(user, { recursive: true });
        writeFileSync(path.join(user, '.cosplaying.json'), JSON.stringify(row.user));
      }
      if (row.project) writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify(row.project));
      if (row.yaml) writeFileSync(path.join(cwd, '.cosplaying.yaml'), row.yaml);
      const result = spawnSync(process.execPath, [bin, 'hook', '--model', 'Example', '--', 'configview'], {
        cwd: nested, encoding: 'utf8',
        env: {
          ...env, COSPLAYING_LINK: 'https://example.com/env', COSPLAYING_ATTRIBUTION_TEMPLATE: 'env {model}',
          COSPLAYING_ATTRIBUTION_TEMPLATE_MARKDOWN: 'env markdown {model}', COSPLAYING_ATTRIBUTION_TEMPLATE_TRAILER: 'env trailer',
        },
      });
      assert.equal(result.status, 0, `${row.name}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        markdown: `Hello\n\n<!-- cosplaying:attribution -->\n${row.markdown}\n<!-- /cosplaying:attribution -->\n`,
        trailer: row.trailer,
      }, row.name);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a config model blocks the command', () => {
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
});

test('an optional config field of the wrong type does not stop the command', () => {
  const home = temp();
  const cwd = temp();
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ variables: 'team' }));
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
