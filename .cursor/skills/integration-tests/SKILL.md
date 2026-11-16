---
name: integration-tests
description: >-
  Requires cosplaying tests to run the real cosplaying process
  (`node packages/cli/bin/cosplaying.js` or the bin on PATH) in a temporary
  HOME and temporary cwd, and to assert the real exit code, stdout, stderr,
  and the files the command wrote. Forbids mocks, fakes, stubs, spies,
  polyfills, injected doubles such as spawnImpl, and tests whose only
  subject is a private helper, a type check, or a defensive throw that
  cannot happen because this repo controls the caller. Use when writing
  or changing tests in this repo, including node:test files under
  packages/*/test.
---

# Integration tests

Apply this when writing or changing a test. `pnpm test` runs `node --test` on `packages/*/test/*.test.js`.

Integration tests run the real cosplaying process (`node packages/cli/bin/cosplaying.js` or the bin on PATH), using a temporary HOME and temporary cwd so the developer's real Cursor, Claude, Codex, Gemini, Pi, and OpenCode config is untouched.

A temp directory is the isolation boundary, not a mock.

Assertions must use the real exit code, stdout, stderr, and the files the command wrote.

Forbid mocks, fakes, stubs, spies, polyfills, and injected doubles such as `spawnImpl`. This includes `mock` from `node:test`.

Forbid tests whose only subject is a private helper, a type check, or a defensive throw that cannot happen because this repo controls the caller.

A test you add or change runs the process below. Importing `main` and passing `spawnImpl`, a fake stdout, or a fake stderr is an injected double.

## Spawn

Create the temporary HOME and the temporary cwd with `os.tmpdir()`. Both must sit outside this repo. `gitRoot` walks up to `.git`, and install then writes harness files into that project.

Run `process.execPath` with the absolute path to `packages/cli/bin/cosplaying.js`. Resolve it from `import.meta.url`. From `packages/*/test/` the URL is `../../cli/bin/cosplaying.js`. The process `cwd` is the temporary cwd, so a repo-relative script path is not found.

Pass a new `env` with `HOME` set to the temporary HOME. That env is what the test injects. Do not spread `process.env`. `PI_CODING_AGENT_DIR` and `XDG_CONFIG_HOME` override the temporary HOME for Pi and OpenCode. Copy `PATH` only when the command needs an external binary.

`result.status` is the exit code. `result.stdout` and `result.stderr` are the process output when `encoding` is set. When the command writes a file, read that path under the temporary HOME or temporary cwd.

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../cli/bin/cosplaying.js', import.meta.url));

test('version prints a version line', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-cwd-'));
  const result = spawnSync(process.execPath, [bin, '--version'], {
    cwd,
    env: { HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, '');
});
```

The `cosplaying` bin on PATH is the same process when it is this repo's bin. Prefer the absolute `packages/cli/bin/cosplaying.js` path so the test runs this workspace.
