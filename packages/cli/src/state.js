import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';
import { normalizeIdentity } from 'cosplaying/attribution';
import { userConfigDirectory } from './config.js';
import { writeTextAtomic } from 'cosplaying/hooks';

/**
 * Builds the path of the file that stores the model for one agent session.
 *
 * The session id is hashed so the file name does not contain characters from the harness id.
 *
 * @param {string} directory User config directory, normally `~/.config/cosplaying`.
 * @param {string} sessionId Session id from the harness payload.
 * @returns {string} Absolute path of `<directory>/sessions/<sha256>.json`.
 */
export function sessionModelPath(directory, sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex');
  return path.join(directory, 'sessions', `${hash}.json`);
}

/**
 * Stores the model name for one agent session.
 *
 * Later hook events can read this file when the payload does not include a model. An empty session id or an empty model does not write a file.
 *
 * @param {object} options Runtime context.
 * @param {string} [options.home] Home directory used to locate the user config directory.
 * @param {string} sessionId Session id from the harness payload. An empty value skips the write.
 * @param {unknown} model Model name from the harness. Whitespace is trimmed and collapsed. An empty result skips the write.
 * @returns {void} No value. A non-empty model is written as JSON `{ "model": "<name>" }`.
 * @throws {CosplayError} The session file cannot be written. Make the config directory writable and start the session again.
 */
export function saveSessionModel(options, sessionId, model) {
  const normalized = normalizeIdentity(model);
  if (!sessionId || !normalized) return;
  const file = sessionModelPath(userConfigDirectory(options), sessionId);
  try {
    writeTextAtomic(file, JSON.stringify({ model: normalized }));
  } catch (error) {
    throw new CosplayError({
      name: 'cli',
      method: 'saveSessionModel',
      message: 'could not store the session model in %s: %s. Make the cosplaying config directory writable, then start the agent session again.',
      args: [file, error.message],
      cause: error,
    });
  }
}

/**
 * Reads the model name stored for one agent session.
 *
 * Claude Code uses this between SessionStart and a later tool event when the payload has no model.
 *
 * @param {object} options Runtime context.
 * @param {string} [options.home] Home directory used to locate the user config directory.
 * @param {string} sessionId Session id from the harness payload. An empty value does not read a file.
 * @returns {string} Stored model name. An empty string when the id is empty, the file is missing, or the file is not usable JSON.
 */
export function readSessionModel(options, sessionId) {
  if (!sessionId) return '';
  try {
    const parsed = JSON.parse(readFileSync(sessionModelPath(userConfigDirectory(options), sessionId), 'utf8'));
    return normalizeIdentity(parsed.model);
  } catch {
    return '';
  }
}

/**
 * Deletes the stored model for one agent session.
 *
 * Session end removes the file so the next session does not reuse that model. An empty session id does nothing.
 *
 * @param {object} options Runtime context.
 * @param {string} [options.home] Home directory used to locate the user config directory.
 * @param {string} sessionId Session id from the harness payload. An empty value skips the delete.
 * @returns {void} No value. A missing file is not an error.
 * @throws {CosplayError} The file exists and cannot be deleted. Make the config directory writable and start the session again.
 */
export function clearSessionModel(options, sessionId) {
  if (!sessionId) return;
  const file = sessionModelPath(userConfigDirectory(options), sessionId);
  try {
    rmSync(file, { force: true });
  } catch (error) {
    throw new CosplayError({
      name: 'cli',
      method: 'clearSessionModel',
      message: 'could not store the session model in %s: %s. Make the cosplaying config directory writable, then start the agent session again.',
      args: [file, error.message],
      cause: error,
    });
  }
}
