import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'unbash';

const cli = import.meta.resolve('cosplaying');

test('a company bin keeps its defaults across installed hooks and rewritten commands', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cosplaying-company-')));
  try {
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const plugin = path.join(root, 'byline');
    const wrapper = path.join(root, 'company cli.mjs');
    for (const directory of [home, cwd, plugin]) mkdirSync(directory);
    writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
      name: 'byline', version: '1.0.0', type: 'module', main: 'index.js',
    }));
    writeFileSync(path.join(plugin, 'index.js'), `export default function run(args, { attribution, stdout }) {
  stdout.write(JSON.stringify([attribution.annotateMarkdown('Text'), attribution.renderTrailer()]));
  return 0;
}`);
    writeFileSync(wrapper, `import { cosplaying } from ${JSON.stringify(cli)};
process.exitCode = await cosplaying({
  entrypoint: import.meta.url,
  defaults: {
    plugins: [${JSON.stringify(plugin)}, 'git'],
    attribution: {
      link: 'https://example.com/company-policy',
      templates: {
        markdown: '> AI-assisted by {model}. [Company policy]({link}).',
        trailer: '{model} ({link})',
      },
    },
  },
});`);
    const env = {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH,
      COSPLAYING_BYLINE_BIN: path.join(plugin, 'package.json'),
    };
    const run = (args) => spawnSync(process.execPath, [wrapper, ...args], { cwd, env, encoding: 'utf8' });
    const execute = (command, input) => {
      const { name, suffix } = parse(command).commands[0].command;
      const [executable, ...args] = [name, ...suffix].map((word) => word.value);
      return spawnSync(executable, args, { cwd, env, input, encoding: 'utf8' });
    };
    const success = (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout;
    };

    assert.match(success(run(['install'])), /installed codex hooks/);
    assert.match(success(run(['doctor'])), /no findings \(6 managed installs checked\)/);
    const hooks = JSON.parse(readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8')).hooks;
    const started = JSON.parse(success(execute(hooks.SessionStart[0].hooks[0].command, '{}')));
    assert.ok(started.hookSpecificOutput.additionalContext.includes(wrapper));
    for (const file of [
      path.join(home, '.pi', 'agent', 'extensions', 'cosplaying.js'),
      path.join(home, '.config', 'opencode', 'plugins', 'cosplaying.js'),
    ]) {
      assert.ok(readFileSync(file, 'utf8').includes(JSON.stringify([wrapper])));
    }

    const output = () => {
      const payload = JSON.stringify({ model: 'Example', tool_name: 'exec_command', tool_input: { cmd: 'byline' } });
      const result = JSON.parse(success(execute(hooks.PreToolUse[0].hooks[0].command, payload)));
      const rewritten = result.hookSpecificOutput.updatedInput.cmd;
      assert.equal(success(run(['rewrite', '--model', 'Example', '--shell', 'byline'])).trim(), rewritten);
      return JSON.parse(success(execute(rewritten)));
    };
    assert.deepEqual(output(), [
      'Text\n\n<!-- cosplaying:attribution -->\n> AI-assisted by Example. [Company policy](https://example.com/company-policy).\n<!-- /cosplaying:attribution -->\n',
      'AI-Assisted-By: Example (https://example.com/company-policy)',
    ]);
    const projectFile = path.join(cwd, '.cosplaying.json');
    writeFileSync(projectFile, JSON.stringify({
      plugins: [plugin],
      attribution: { link: 'https://example.com/project-policy', templates: { trailer: '{model} under project policy ({link})' } },
    }));
    const [markdown, trailer] = output();
    assert.match(markdown, /Company policy\]\(https:\/\/example\.com\/project-policy\)/);
    assert.equal(trailer, 'AI-Assisted-By: Example under project policy (https://example.com/project-policy)');
    assert.equal(success(run(['rewrite', '--shell', 'git status'])), 'git status\n');

    rmSync(projectFile);
    assert.match(success(run(['plugin', 'disable', 'git'])), /git/);
    const userFile = path.join(home, '.config', 'cosplaying', '.cosplaying.json');
    assert.deepEqual(JSON.parse(readFileSync(userFile, 'utf8')).plugins, [plugin]);
    assert.equal(success(run(['rewrite', '--shell', 'git status'])), 'git status\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
