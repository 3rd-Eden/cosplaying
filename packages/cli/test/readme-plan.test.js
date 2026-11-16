import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const readme = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');

test('README says this hook does not run for Cursor cloud agents', () => {
  assert.equal(
    readme.includes('This hook does not run for Cursor cloud agents. Project install is how a repo covers cloud agents'),
    true,
  );
});

test('README states the Codex, Claude Code, and Gemini trust steps', () => {
  for (const sentence of [
    'open `/hooks` and trust the command',
    'Codex must be trusted again because trust is pinned to the hook hash',
    'approval is separate and that a new agent session is required after install',
  ]) {
    assert.equal(readme.includes(sentence), true, sentence);
  }
});
