import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../../cli/bin/cosplaying.js', import.meta.url));

test('hook renders markdown and trailers and rejects invalid attribution', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-markdown-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-markdown-cwd-'));
  try {
    const pluginDir = path.join(cwd, 'mdnote');
    mkdirSync(pluginDir);
    writeFileSync(path.join(pluginDir, 'package.json'), `${JSON.stringify({
      name: 'mdnote',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }, null, 2)}\n`);
    writeFileSync(path.join(pluginDir, 'index.js'), [
      "import { readFileSync } from 'node:fs';",
      '',
      "export const description = 'Attribute a markdown file';",
      'export const examples = [\'cosplaying hook --model "Example" -- mdnote --file body.md\'];',
      '',
      'export default async function run(args, context) {',
      "  const index = args.indexOf('--file');",
      '  const file = index >= 0 ? args[index + 1] : undefined;',
      '  if (!file) {',
      "    context.stderr.write('mdnote needs --file <path>.\\n');",
      '    return 2;',
      '  }',
      "  const text = readFileSync(file, 'utf8');",
      '  let annotated;',
      '  try {',
      "    annotated = args.includes('--trailer') ? context.attribution.renderTrailer() : context.attribution.annotateMarkdown(text);",
      '  } catch (error) {',
      '    context.stderr.write(String(error.message) + \'\\n\');',
      '    return 2;',
      '  }',
      '  context.stdout.write(annotated);',
      '  return 0;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(path.join(cwd, '.cosplaying.json'), `${JSON.stringify({
      link: 'https://example.com/a(b)',
      plugins: [pluginDir],
    })}\n`);
    const program = path.join(pluginDir, 'index.js');
    const body = path.join(cwd, 'body.md');
    const rendered = 'Authored by Claude \\*Code\\* via [cosplaying](https://example.com/a%28b%29). AI Assisted text may contain mistakes, please verify.';
    const block = `<!-- cosplaying:attribution -->\n${rendered}\n<!-- /cosplaying:attribution -->\n`;

    /**
     * @param {string} contents
     */
    function attribute(contents) {
      writeFileSync(body, contents);
      const result = spawnSync(process.execPath, [
        bin, 'hook', '--model', 'Claude *Code*', '--', 'mdnote', '--file', body,
      ], {
        cwd,
        encoding: 'utf8',
        env: {
          HOME: home,
          USERPROFILE: home,
          COSPLAYING_MDNOTE_BIN: program,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(readFileSync(body, 'utf8'), contents);
      return result.stdout;
    }

    const once = attribute('Hello');
    assert.equal(once, `Hello\n\n${block}`);
    const twice = attribute(once);
    assert.equal(twice, once);

    const empty = attribute('');
    assert.equal(empty, block);

    const kept = 'keep <!-- cosplaying:attribution --> inner <!-- /cosplaying:attribution --> more';
    const inner = attribute(kept);
    assert.equal(inner, `${kept}\n\n${block}`);

    const cases = [
      { mode: '--trailer', model: 'Example Model', config: {}, text: 'AI-Assisted-By: Example Model via cosplaying (https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.' },
      { mode: '--trailer', model: 'M', config: { link: '', variables: { team: 'Docs' }, attribution: { templates: { trailer: '{model} {team}' } } }, text: 'AI-Assisted-By: M Docs' },
      { model: 'M', config: { attribution: { templates: { markdown: 'Hello' } } }, text: `${kept}\n\n<!-- cosplaying:attribution -->\nHello\n<!-- /cosplaying:attribution -->\n` },
      { config: {}, error: /--model/ },
      { model: 'M', config: { attribution: { templates: { markdown: '{model} <!-- cosplaying:attribution -->' } } }, error: /marker/ },
      { mode: '--trailer', model: 'M', config: { attribution: { templates: { trailer: '{model}\nmore' } } }, error: /single line/ },
      { mode: '--trailer', model: 'M', config: { variables: { team: 'a\nb' }, attribution: { templates: { trailer: '{model} {team}' } } }, error: /single line/ },
      { model: 'M', config: { link: 'javascript:alert(1)' }, error: /HTTP/ },
    ];
    for (const item of cases) {
      writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: [pluginDir], ...item.config }));
      const result = spawnSync(process.execPath, [bin, 'hook', ...(item.model ? ['--model', item.model] : []), '--', 'mdnote', '--file', body, ...(item.mode ? [item.mode] : [])], {
        cwd, encoding: 'utf8', env: { HOME: home, USERPROFILE: home, COSPLAYING_MDNOTE_BIN: program },
      });
      if (item.error) {
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, item.error);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, item.text);
      }
      assert.equal(readFileSync(body, 'utf8'), kept);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
