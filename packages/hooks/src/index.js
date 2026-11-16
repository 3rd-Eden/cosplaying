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
 * @param {string} value
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function quoteShell(value, platform = process.platform) {
  if (platform === 'win32') return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} entry
 * @param {string} owner
 * @returns {boolean}
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
 * @param {unknown[]} entries
 * @param {string} owner
 * @returns {unknown[]}
 */
export function stripOwned(entries, owner) {
  return entries.filter((entry) => !isOwned(entry, owner));
}

/**
 * @param {unknown} value
 */
function pruneEmpty(value) {
  if (!isRecord(value) || !isRecord(value.hooks)) return;
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
 * Reads a managed JSON file. A missing file is an empty object.
 * Invalid UTF-8, invalid JSON, or a non-object root throws without a write.
 * @param {string} file
 * @returns {Record<string, unknown>}
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
 * Writes UTF-8 text atomically. The parent directory is created at mode 0700.
 * A symlink is refused so write-file-atomic cannot follow it onto another file.
 * Equal contents are not checked here; callers skip a write when the text is unchanged.
 * @param {string} file
 * @param {string} text
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
 * Reads bytes and returns UTF-8 text.
 * A round-trip mismatch throws hooks.utf8 instead of inserting U+FFFD.
 * @param {string} file
 * @returns {string}
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
 * @param {string} file
 * @param {unknown} value
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
 * Replaces owned entries for the listed events and appends the new entries last.
 * Foreign keys and their order are preserved. New keys are appended.
 * @param {Record<string, unknown>} value
 * @param {string} owner
 * @param {Record<string, unknown[]>} additions
 * @param {{version?: number}} [options]
 * @returns {Record<string, unknown>}
 */
export function reconcileHooks(value, owner, additions, { version } = {}) {
  if (!isRecord(value)) {
    throw new CosplayError({
      name: 'hooks',
      method: 'reconcileHooks',
      message: 'invalid config %s: config must contain a top-level object. Replace the file with a JSON object, or move it aside and run cosplaying install again.',
      args: ['config'],
    });
  }
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
 * Removes owned entries and empty event arrays.
 * @param {Record<string, unknown>} value
 * @param {string} owner
 * @returns {Record<string, unknown>}
 */
export function removeOwnedHooks(value, owner) {
  if (!isRecord(value) || !isRecord(value.hooks)) return value;
  const next = { ...value, hooks: { ...value.hooks } };
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    next.hooks[event] = stripOwned(entries, owner);
  }
  pruneEmpty(next);
  return next;
}

/**
 * @param {string} file
 * @param {string} owner
 * @param {Record<string, unknown[]>} additions
 * @param {{version?: number}} [options]
 */
export function installJsonHooks(file, owner, additions, options = {}) {
  const current = readJsonConfig(file);
  const next = reconcileHooks(current, owner, additions, options);
  writeJsonAtomic(file, next);
  return next;
}

/**
 * @param {string} file
 * @param {string} owner
 */
export function uninstallJsonHooks(file, owner) {
  let current;
  try {
    current = readJsonConfig(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const next = removeOwnedHooks(current, owner);
  writeJsonAtomic(file, next);
  return next;
}

/**
 * @param {string} file
 * @param {string} marker
 * @param {string} contents
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
 * Deletes a generated hook file only when it contains the marker.
 * @param {string} file
 * @param {string} marker
 * @returns {boolean}
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
 * @param {string} file
 * @returns {boolean}
 */
export function fileExists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
