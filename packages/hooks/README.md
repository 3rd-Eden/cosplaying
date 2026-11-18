# Hook file API

Import `cosplaying/hooks` to update a harness configuration file. The [harness adapters](../adapters/README.md) select the path, event names, and command text. This package writes the file and uses an ownership marker to identify entries from the same installation.

## Add hooks to a JSON file

This example updates a Codex-style hook list. Use the adapter when you also need it to select the file path and form the command.

```js
import { installJsonHooks, uninstallJsonHooks } from 'cosplaying/hooks';

const file = './.codex/hooks.json';
const owner = '# cosplaying:codex';

installJsonHooks(file, owner, {
  PreToolUse: [{
    hooks: [{
      type: 'command',
      command: `cosplaying agent-hook codex PreToolUse ${owner}`,
    }],
  }],
});

// To remove these hooks later:
// uninstallJsonHooks(file, owner);
```

An entry belongs to the caller if its `command`, `bash`, or `powershell` string contains the owner marker. This check also looks inside nested `hooks` arrays. On install, the package removes the old entries with that marker and appends the replacements after the other hooks. A supplied `version` fills a missing version. Other configuration keys keep their values.

On uninstall, the package removes the marked hooks and prunes empty groups, event arrays, and the empty `hooks` object. It writes the resulting JSON to the same path. A missing file is read as an empty object, so uninstall on a missing file can create a file containing `{}`.

Invalid UTF-8, invalid JSON, or a root value other than an object stops the update. Install also stops if `hooks` has the wrong shape or an event it must update is not an array. Uninstall preserves event values that are not arrays.

## Install a standalone extension

Use `installHookFile(file, marker, contents)` for a complete generated file, such as a Pi or OpenCode extension. Put the marker in the generated source. The function returns `true` after a write and `false` if the existing contents already match. If the existing file differs and lacks the marker, the function throws.

Use `uninstallHookFile(file, marker)` to delete a marked file. It returns `false` for a missing or unmarked file. Both functions stop on invalid UTF-8.

<details>
<summary>Ownership and file utilities</summary>

| Export | Use |
| --- | --- |
| `isOwned(entry, owner)`, `stripOwned(entries, owner)` | Test one entry or filter an array to keep entries without the marker. |
| `reconcileHooks(value, owner, additions, { version })`, `removeOwnedHooks(value, owner)` | Calculate the JSON install or uninstall result in memory. The file functions return the object too. |
| `readJsonConfig(file)`, `readUtf8File(file)` | Read a JSON object or check that a text file is valid UTF-8. A missing JSON file yields `{}`. |
| `writeJsonAtomic(file, value)` | Write two-space JSON with a final newline. Returns `false` for identical text and `true` after a write. |
| `writeTextAtomic(file, text)` | Write UTF-8 atomically. Creates parent directories with mode `0700` and writes the file with mode `0600`. Rejects a symlink at the destination. |
| `fileExists(file)` | Returns whether `stat` succeeds. |
| `quoteShell(value, platform)` | Quote one shell argument. On Windows, wrap it in double quotes and double each embedded double quote. On other platforms, use single quotes and escape embedded single quotes. |

File operations can throw `CosplayError` or propagate a filesystem error.

</details>
