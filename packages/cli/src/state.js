import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { LayerError } from '@mcp-layer/error';
import { normalizeIdentity } from 'cosplaying/attribution';
import { userConfigDirectory } from './config.js';
import { writeTextAtomic } from 'cosplaying/hooks';

const errorScope = 'cosplaying';
const errorDocs = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/**
 * @param {string} directory
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionModelPath(directory, sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex');
  return path.join(directory, 'sessions', `${hash}.json`);
}

/**
 * @param {object} options
 * @param {string} sessionId
 * @param {unknown} model
 */
export function saveSessionModel(options, sessionId, model) {
  const normalized = normalizeIdentity(model);
  if (!sessionId || !normalized) return;
  const file = sessionModelPath(userConfigDirectory(options), sessionId);
  try {
    writeTextAtomic(file, JSON.stringify({ model: normalized }));
  } catch (error) {
    throw new LayerError({
      name: 'cli',
      scope: errorScope,
      docs: errorDocs,
      method: 'saveSessionModel',
      message: 'could not store the session model in %s: %s. Make the cosplaying config directory writable, then start the agent session again.',
      args: [file, error.message],
      cause: error,
    });
  }
}

/**
 * @param {object} options
 * @param {string} sessionId
 * @returns {string}
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
 * @param {object} options
 * @param {string} sessionId
 */
export function clearSessionModel(options, sessionId) {
  if (!sessionId) return;
  const file = sessionModelPath(userConfigDirectory(options), sessionId);
  try {
    rmSync(file, { force: true });
  } catch (error) {
    throw new LayerError({
      name: 'cli',
      scope: errorScope,
      docs: errorDocs,
      method: 'clearSessionModel',
      message: 'could not store the session model in %s: %s. Make the cosplaying config directory writable, then start the agent session again.',
      args: [file, error.message],
      cause: error,
    });
  }
}
