import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';
import writeFileAtomic from 'write-file-atomic';

/**
 * Quotes one shell token so the harness runs it as a single argument.
 *
 * Installed hooks quote every token, including plain paths. Windows uses doubled quotes inside a `cmd.exe` string. Other platforms use single quotes and escape an embedded apostrophe.
 *
 * @param {string} value Token to quote. It can contain spaces, quotes, or an apostrophe.
 * @param {NodeJS.Platform} [platform=process.platform] Platform whose quoting rules are applied. `win32` selects the `cmd.exe` form.
 * @returns {string} `value` wrapped so the shell does not split it.
 */
export function quoteShell(value, platform = process.platform) {
  if (platform === 'win32') return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Reports whether a JSON value is a plain object.
 *
 * Arrays are excluded. Hook entries are objects, and an array in their place must not be treated as a record.
 *
 * @param {unknown} value Value from a hook file or from a caller.
 * @returns {value is Record<string, unknown>} True when `value` is a non-null object and not an array.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reports whether a hook entry belongs to this install.
 *
 * An entry is owned when its command text contains the harness marker, for example `# cosplaying:codex`. Nested `hooks` arrays are checked too, because some harnesses wrap the command in a group.
 *
 * @param {unknown} entry One hook entry or hook group from a settings file.
 * @param {string} owner Marker text that this install writes into its commands.
 * @returns {boolean} True when `entry` or a nested hook contains `owner` in `command`, `bash`, or `powershell`.
 */
export function isOwned(entry, owner) {
  if (!isRecord(entry)) return false;
  for (const field of ['command', 'bash', 'powershell']) {
    if (typeof entry[field] === 'string' && entry[field].includes(owner)) return true;
  }
  if (Array.isArray(entry.hooks) && entry.hooks.some((hook) => isOwned(hook, owner))) return true;
  return false;
}

/**
 * Removes hook entries that this install owns.
 *
 * Foreign entries stay in their original order. Install uses this before it appends the current commands, so another tool's hooks are not rewritten.
 *
 * @param {unknown[]} entries Event entries from one hook event.
 * @param {string} owner Marker text that identifies entries written by this install.
 * @returns {unknown[]} Entries that do not belong to `owner`, in the original order.
 */
export function stripOwned(entries, owner) {
  return entries.filter((entry) => !isOwned(entry, owner));
}

/**
 * Deletes hook events that have no entries left.
 *
 * Uninstall must not leave an empty event array. An empty `hooks` object is removed so the file can return to the shape it had before install.
 *
 * @param {unknown} value Settings object that may contain `hooks`. A non-object `hooks` value is left unchanged.
 * @returns {void} No value. Empty groups and empty events are deleted on `value`.
 */
function pruneEmpty(value) {
  if (!isRecord(value.hooks)) return;
  for (const [event, entries] of Object.entries(value.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return true;
      return entry.hooks.length > 0;
    });
    if (kept.length === 0) delete value.hooks[event];
    else value.hooks[event] = kept;
  }
  if (Object.keys(value.hooks).length === 0) delete value.hooks;
}

/**
 * Reads a harness settings file as one JSON object.
 *
 * A missing file is an empty object so the first install can create it. Invalid UTF-8, invalid JSON, or a root that is not an object throws, and the caller does not write.
 *
 * @param {string} file Absolute path of the harness settings file.
 * @returns {Record<string, unknown>} Parsed object. An empty object when the file does not exist.
 * @throws {CosplayError} The file cannot be read, is not UTF-8, is not JSON, or its root is not an object.
 */
export function readJsonConfig(file) {
  let text;
  try {
    text = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new CosplayError({
      name: 'hooks',
      method: 'readJsonConfig',
      message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
      args: [file, error.message],
      cause: error,
    });
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(text);
  } catch {
    throw new CosplayError({
      name: 'hooks',
      method: 'readJsonConfig',
      message: 'invalid config %s: file is not valid UTF-8. Replace the file with UTF-8 JSON, or move it aside and run cosplaying install again.',
      args: [file],
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new CosplayError({
      name: 'hooks',
      method: 'readJsonConfig',
      message: 'invalid config %s: %s. Fix the JSON syntax, or move the file aside and run cosplaying install again.',
      args: [file, error.message],
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new CosplayError({
      name: 'hooks',
      method: 'readJsonConfig',
      message: 'invalid config %s: config must contain a top-level object. Replace the file with a JSON object, or move it aside and run cosplaying install again.',
      args: [file],
    });
  }
  return parsed;
}

/**
 * Writes UTF-8 text by replacing the destination in one rename.
 *
 * The parent directory is created at mode `0700`. A symlink is refused so the write cannot follow it onto another file. This function does not compare the old contents. Callers skip the write when the text is unchanged.
 *
 * @param {string} file Destination path. The parent directory is created when it is missing.
 * @param {string} text UTF-8 text to store. The file mode is `0600` where the platform accepts it.
 * @returns {void} No value. The destination is a regular file with the new contents.
 * @throws {CosplayError} `file` is a symlink.
 */
export function writeTextAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) {
    throw new CosplayError({
      name: 'hooks',
      method: 'writeTextAtomic',
      message: 'refusing to write %s because it is a symlink. Do not follow the symlink. Replace the file with a regular file and retry.',
      args: [file],
    });
  }
  writeFileAtomic.sync(file, text, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows may reject POSIX modes.
  }
}

/**
 * Reads a hook file as UTF-8 text.
 *
 * A byte sequence that is not valid UTF-8 is rejected. The function does not insert U+FFFD, because a repaired file must stay byte-identical to the text the installer writes.
 *
 * @param {string} file Path of a Pi or OpenCode extension, or another text hook file.
 * @returns {string} The file contents as a UTF-8 string.
 * @throws {CosplayError} The bytes are not valid UTF-8.
 * @throws {Error} The file cannot be read. Callers map that error to a `CosplayError`.
 */
export function readUtf8File(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new CosplayError({
      name: 'hooks',
      method: 'readUtf8File',
      message: 'invalid config %s: file is not valid UTF-8. Replace the file with UTF-8 JSON, or move it aside and run cosplaying install again.',
      args: [file],
    });
  }
  return text;
}

/**
 * Writes a settings object as pretty-printed JSON when the bytes would change.
 *
 * A file that already has the same text is left untouched. That keeps a harness from seeing a new file hash when install is repeated.
 *
 * @param {string} file Destination settings path.
 * @param {unknown} value JSON value to store. It is rendered with two-space indentation and a trailing newline.
 * @returns {boolean} True when the file was written. False when the current contents already match.
 * @throws {CosplayError} The existing file cannot be read, or the new file cannot be written.
 */
export function writeJsonAtomic(file, value) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  let current = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new CosplayError({
        name: 'hooks',
        method: 'writeJsonAtomic',
        message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
        args: [file, error.message],
        cause: error,
      });
    }
  }
  if (current === rendered) return false;
  try {
    writeTextAtomic(file, rendered);
  } catch (error) {
    if (error instanceof CosplayError) throw error;
    throw new CosplayError({
      name: 'hooks',
      method: 'writeJsonAtomic',
      message: 'could not write %s: %s. Make the parent directory writable and run cosplaying install again.',
      args: [file, error.message],
      cause: error,
    });
  }
  return true;
}

/**
 * Replaces this install's hook entries and appends the new entries last.
 *
 * Foreign keys and their order stay as they were. New event names are appended. Owned entries must be last so a later tool cannot strip the cosplaying prefix before the command runs. `version` is set only when the file does not already have one.
 *
 * @param {Record<string, unknown>} value Current settings object.
 * @param {string} owner Marker text that identifies entries written by this install.
 * @param {Record<string, unknown[]>} additions New entries keyed by harness event name.
 * @param {object} [options]
 * @param {number} [options.version] Settings schema version. It is written only when `value` has no `version`.
 * @returns {Record<string, unknown>} New settings object. The input object is not mutated.
 * @throws {CosplayError} `hooks` is not an object, or an event that this call updates is not an array.
 */
export function reconcileHooks(value, owner, additions, { version } = {}) {
  const next = { ...value };
  if (version !== undefined && !Object.hasOwn(next, 'version')) next.version = version;
  const hooks = isRecord(next.hooks) ? { ...next.hooks } : {};
  if (next.hooks !== undefined && !isRecord(next.hooks)) {
    throw new CosplayError({
      name: 'hooks',
      method: 'reconcileHooks',
      message: 'hooks must be an object. Set hooks to an object of event arrays, or delete hooks and run cosplaying install again.',
    });
  }
  for (const [event, entries] of Object.entries(additions)) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new CosplayError({
        name: 'hooks',
        method: 'reconcileHooks',
        message: 'hooks.%s must be an array. Set that event to an array of hook objects, or delete it and run cosplaying install again.',
        args: [event],
      });
    }
    const kept = stripOwned(existing ?? [], owner);
    hooks[event] = [...kept, ...entries];
  }
  next.hooks = hooks;
  pruneEmpty(next);
  return next;
}

/**
 * Removes this install's hook entries and drops events that become empty.
 *
 * Foreign entries stay. A settings file with no `hooks` object is returned unchanged.
 *
 * @param {Record<string, unknown>} value Current settings object.
 * @param {string} owner Marker text that identifies entries written by this install.
 * @returns {Record<string, unknown>} Settings without owned entries. The input is returned as-is when `hooks` is not an object.
 */
export function removeOwnedHooks(value, owner) {
  if (!isRecord(value.hooks)) return value;
  const next = { ...value, hooks: { ...value.hooks } };
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    next.hooks[event] = stripOwned(entries, owner);
  }
  pruneEmpty(next);
  return next;
}

/**
 * Writes this install's JSON hooks into a harness settings file.
 *
 * Existing foreign hooks are kept. Owned hooks for the listed events are replaced and placed last.
 *
 * @param {string} file Harness settings path. A missing file is created.
 * @param {string} owner Marker text written into the hook commands.
 * @param {Record<string, unknown[]>} additions New entries keyed by harness event name.
 * @param {object} [options]
 * @param {number} [options.version] Settings schema version for a file that does not already have one.
 * @returns {Record<string, unknown>} Settings object that was written.
 * @throws {CosplayError} The file cannot be read or written, or its hook shape is invalid.
 */
export function installJsonHooks(file, owner, additions, options = {}) {
  const current = readJsonConfig(file);
  const next = reconcileHooks(current, owner, additions, options);
  writeJsonAtomic(file, next);
  return next;
}

/**
 * Removes this install's JSON hooks from a harness settings file.
 *
 * Foreign hooks stay. A missing file becomes an empty object and is written only when that changes the bytes.
 *
 * @param {string} file Harness settings path.
 * @param {string} owner Marker text that identifies the entries to remove.
 * @returns {Record<string, unknown>} Settings object after the owned entries are removed.
 * @throws {CosplayError} The file cannot be read or written, or it is not a JSON object.
 */
export function uninstallJsonHooks(file, owner) {
  const current = readJsonConfig(file);
  const next = removeOwnedHooks(current, owner);
  writeJsonAtomic(file, next);
  return next;
}

/**
 * Writes a generated Pi or OpenCode extension.
 *
 * A missing file is created. A file that already contains the marker is replaced. A file that has neither the marker nor the exact new contents is left unchanged, because it may be a user extension.
 *
 * @param {string} file Extension path inside the harness config.
 * @param {string} marker Ownership comment, for example `// cosplaying:pi`.
 * @param {string} contents Full extension source, including `marker`.
 * @returns {boolean} True when the file was written. False when the current contents already match.
 * @throws {CosplayError} The file exists, lacks the marker, and is not already equal to `contents`. Also thrown when the file cannot be read or written.
 */
export function installHookFile(file, marker, contents) {
  let current = null;
  try {
    current = readUtf8File(file);
  } catch (error) {
    if (error instanceof CosplayError) throw error;
    if (error.code !== 'ENOENT') {
      throw new CosplayError({
        name: 'hooks',
        method: 'installHookFile',
        message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
        args: [file, error.message],
        cause: error,
      });
    }
  }
  if (current !== null && !current.includes(marker) && current !== contents) {
    throw new CosplayError({
      name: 'hooks',
      method: 'installHookFile',
      message: 'refusing to replace unmanaged hook file %s. Move the file aside or add the cosplaying marker comment, then run cosplaying install again.',
      args: [file],
    });
  }
  if (current === contents) return false;
  try {
    writeTextAtomic(file, contents);
  } catch (error) {
    if (error instanceof CosplayError) throw error;
    throw new CosplayError({
      name: 'hooks',
      method: 'installHookFile',
      message: 'could not write %s: %s. Make the parent directory writable and run cosplaying install again.',
      args: [file, error.message],
      cause: error,
    });
  }
  return true;
}

/**
 * Deletes a generated hook file only when it contains the ownership marker.
 *
 * An unmarked file is a user file and is left in place. A missing file is a successful no-op.
 *
 * @param {string} file Extension path inside the harness config.
 * @param {string} marker Ownership comment that install wrote into the file.
 * @returns {boolean} True when the file was deleted. False when it is missing or does not contain `marker`.
 * @throws {CosplayError} The file exists and cannot be read as UTF-8, or it cannot be read for another reason that is already a `CosplayError`.
 */
export function uninstallHookFile(file, marker) {
  let current;
  try {
    current = readUtf8File(file);
  } catch (error) {
    if (error instanceof CosplayError) throw error;
    if (error.code === 'ENOENT') return false;
    throw new CosplayError({
      name: 'hooks',
      method: 'uninstallHookFile',
      message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
      args: [file, error.message],
      cause: error,
    });
  }
  if (!current.includes(marker)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * Reports whether a path exists.
 *
 * A path that cannot be stated, including a missing path, is treated as absent. Callers use this before they decide to regenerate a project extension.
 *
 * @param {string} file Path to test.
 * @returns {boolean} True when `stat` succeeds. False when it throws.
 */
export function fileExists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
