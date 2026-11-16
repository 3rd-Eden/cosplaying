import { LayerError } from '@mcp-layer/error';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quoteShell } from 'cosplaying/hooks';

const errorScope = 'cosplaying';
const errorDocs = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/** @type {string} */
export const mainPath = fileURLToPath(new URL('./main.js', import.meta.url));

/**
 * @returns {string}
 */
export function packageVersion() {
  const file = fileURLToPath(new URL('../../../package.json', import.meta.url));
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version;
  } catch (error) {
    const message = error.message;
    throw new LayerError({
      name: 'cli',
      scope: errorScope,
      docs: errorDocs,
      method: 'packageVersion',
      message: 'could not read the package version from %s: %s. Reinstall cosplaying. The package.json for this install is missing or unreadable.',
      args: [file, message],
      cause: error,
    });
  }
}

/**
 * @returns {string}
 */
export function realMainPath() {
  try {
    return realpathSync(mainPath);
  } catch {
    return mainPath;
  }
}

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
/**
 * @returns {string}
 */
export function cosplayingBinPath() {
  const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
  try {
    return realpathSync(bin);
  } catch {
    return bin;
  }
}

/**
 * @param {NodeJS.Platform} [platform]
 * @param {string} [bin]
 * @returns {string}
 */
export function cliInvocation(platform = process.platform, bin) {
  if (bin) return quoteShell(bin, platform);
  return `${quoteShell(process.execPath, platform)} ${quoteShell(realMainPath(), platform)}`;
}

/**
 * @param {string} command
 * @param {string} model
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function commandPrefix(command, model, platform = process.platform) {
  const encoded = model ? ` --model-base64 ${Buffer.from(model, 'utf8').toString('base64url')}` : '';
  return `${cliInvocation(platform)} hook${encoded} -- ${command}`;
}
