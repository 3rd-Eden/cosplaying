import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotateMarkdown,
  renderTrailer,
  stripAttribution,
  validateLink,
} from '../src/index.js';

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
