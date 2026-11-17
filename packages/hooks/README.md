# @cosplaying/hooks

Private workspace package. Import it as `cosplaying/hooks`.

## What it does

Reads and writes harness config files. It removes entries that contain the caller’s owner marker, appends the replacements last, and refuses to replace a generated file that lacks its marker.

## Scope

In scope: ownership checks, JSON reconcile, atomic text and JSON writes, and install or delete of a generated JavaScript file when the marker is present.

`@cosplaying/adapters` chooses the harness paths, events, command strings, and Pi or OpenCode source, then passes them in. This package does not load settings, plugins, or attribution templates. The CLI uses `cosmiconfig` for settings.

Uninstall rewrites a JSON config and leaves the file in place. A missing JSON file is read as `{}` and then written as `{}`. An empty event array is removed. A nested entry whose `hooks` array is empty is removed. An empty `hooks` object is removed.

Invalid UTF-8, invalid JSON, or a non-object root throws from the read and does not write. `reconcileHooks` throws if `hooks` is not an object. It also throws if an event in `additions` already has a non-array value. `removeOwnedHooks` leaves a non-array event unchanged.

## Public API

- `quoteShell(value, platform)` quotes one value. On Windows the value is wrapped in double quotes and each embedded quote is doubled. On other platforms the value is wrapped in single quotes and an embedded single quote is written as `'\''`.
- `isOwned(entry, owner)` is true when `command`, `bash`, or `powershell` contains `owner`, or a nested `hooks` entry is owned.
- `stripOwned(entries, owner)` returns the entries that are not owned.
- `readJsonConfig(file)` returns `{}` when the file is missing. It returns the object root otherwise.
- `reconcileHooks(value, owner, additions, { version })` copies the root and keeps foreign keys. It sets `version` only if you supply the option and the key is absent. It appends `additions` after the unowned entries for each event.
- `removeOwnedHooks(value, owner)` drops owned entries. A non-array event is left as it is. A value with no `hooks` object is returned unchanged.
- `readUtf8File(file)` reads the file as bytes and returns UTF-8 text. If UTF-8 encoding of that text does not match the source bytes, it throws `CosplayError` from `readUtf8File`.
- `writeTextAtomic(file, text)` creates the parent directory at mode `0700` and writes UTF-8 text at mode `0600` through `write-file-atomic`. It does not compare the previous contents. If the destination is a symlink, it throws and does not write. A `chmod` failure is ignored.
- `writeJsonAtomic(file, value)` writes `JSON.stringify(value, null, 2)` plus a newline. Equal text is not rewritten. It returns `false` when the text is unchanged and `true` after a write.
- `installJsonHooks(file, owner, additions, options)` reads, reconciles, writes, and returns the reconciled object.
- `uninstallJsonHooks(file, owner)` reads, removes owned entries, writes, and returns the reconciled object.
- `installHookFile(file, marker, contents)` writes `contents` when the file is missing, or when it contains `marker` and the text differs. A file that lacks `marker` and differs throws. Equal contents return `false` without a write. Invalid UTF-8 throws and does not write. A write returns `true`.
- `uninstallHookFile(file, marker)` deletes the file only when `marker` is present. A missing file, or a file without `marker`, returns `false`. Invalid UTF-8 throws and does not delete the file.
- `fileExists(file)` is `stat` success.

`owner` is the marker string from the caller, such as `# cosplaying:<harness>` or `// cosplaying:<harness>`.

## Related packages

`@cosplaying/adapters` calls these functions to install and remove harness files. The CLI uses them for doctor, configuration updates, and session-model files.

File operations can throw `CosplayError`. Direct file reads, deletes, and atomic writes can also propagate file-system errors.
