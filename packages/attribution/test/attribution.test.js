import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { systemEnv } from '../../cli/test/spawn-stub.js';
import {
  annotateMarkdown,
  renderTrailer,
  stripAttribution,
  validateLink,
} from '../src/index.js';

const bin = fileURLToPath(new URL('../../cli/bin/cosplaying.js', import.meta.url));

const template = 'Authored by {model} via [cosplaying]({link}). AI Assisted text may contain mistakes, please verify.';
const trailer = '{model} via cosplaying ({link}). AI Assisted text may contain mistakes, please verify.';
const link = 'https://www.npmjs.com/package/cosplaying';

test('annotateMarkdown adds and replaces one trailing block', () => {
  const once = annotateMarkdown('Hello', { model: 'Example Model', template, link });
  assert.match(once, /^Hello\n\n<!-- cosplaying:attribution -->\n/);
  assert.match(once, /<!-- \/cosplaying:attribution -->\n$/);
  assert.equal(annotateMarkdown(once, { model: 'Example Model', template, link }), once);
  assert.equal(stripAttribution(once), 'Hello');
});

test('an empty body has no leading blank line', () => {
  const text = annotateMarkdown('', { model: 'Example', template, link });
  assert.equal(text.startsWith('<!-- cosplaying:attribution -->\n'), true);
});

test('markdown escapes the model and encodes the link', () => {
  const text = annotateMarkdown('body', {
    model: 'Claude *Code*',
    template,
    link: 'https://example.com/a(b)',
  });
  assert.match(text, /Claude \\\*Code\\\*/);
  assert.match(text, /https:\/\/example.com\/a%28b%29/);
});

test('a marker pair that is not trailing stays in the body', () => {
  const body = 'keep <!-- cosplaying:attribution --> inner <!-- /cosplaying:attribution --> more';
  assert.equal(stripAttribution(body), body);
});

test('renderTrailer returns one AI-Assisted-By line', () => {
  assert.equal(
    renderTrailer('Example Model', { template: trailer, link }),
    'AI-Assisted-By: Example Model via cosplaying (https://www.npmjs.com/package/cosplaying). AI Assisted text may contain mistakes, please verify.',
  );
});

test('missing model, markers, and multiline trailers throw', () => {
  assert.throws(() => annotateMarkdown('x', { model: ' ', template, link }), /--model/);
  const plain = annotateMarkdown('x', { model: 'M', template: 'Hello', link });
  assert.match(plain, /\nHello\n/);
  assert.throws(() => annotateMarkdown('x', { model: 'M', template: '{model} <!-- cosplaying:attribution -->', link }), /marker/);
  assert.throws(() => renderTrailer('M', { template: '{model}\nmore', link }), /single line/);
  assert.throws(() => renderTrailer('M', { template: '{model} {team}', link, variables: { team: 'a\nb' } }), /single line/);
  assert.throws(() => validateLink('javascript:alert(1)'), /HTTP/);
});

test('templates can use declared variables', () => {
  const text = renderTrailer('M', { template: '{model} {team}', link: '', variables: { team: 'Docs' } });
  assert.equal(text, 'AI-Assisted-By: M Docs');
});

test('hook prints markdown markers, escaping, an empty body, and a non-trailing block', () => {
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
      '    annotated = context.attribution.annotateMarkdown(text);',
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
    const program = path.join(home, 'mdnote');
    writeFileSync(program, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(program, 0o755);
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
          ...systemEnv(),
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
    assert.match(once, /^Hello\n\n<!-- cosplaying:attribution -->\n/);
    assert.match(once, /<!-- \/cosplaying:attribution -->\n$/);
    assert.match(once, /Claude \\\*Code\\\*/);
    assert.match(once, /https:\/\/example.com\/a%28b%29/);
    const twice = attribute(once);
    assert.equal(twice, once);

    const empty = attribute('');
    assert.equal(empty, block);
    assert.equal(empty.startsWith('<!-- cosplaying:attribution -->\n'), true);

    const kept = 'keep <!-- cosplaying:attribution --> inner <!-- /cosplaying:attribution --> more';
    const inner = attribute(kept);
    assert.equal(inner, `${kept}\n\n${block}`);
    assert.equal(inner.startsWith(`${kept}\n\n<!-- cosplaying:attribution -->\n`), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
