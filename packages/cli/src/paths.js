import { CosplayError } from 'cosplaying/errors';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quoteShell } from 'cosplaying/hooks';

/** @type {string} */
export const mainPath = fileURLToPath(new URL('./main.js', import.meta.url));

/**
 * Reads the version of this cosplaying install.
 *
 * Doctor compares the hook `--version` output with this value.
 *
 * @returns {string} The `version` field from the root `package.json`.
 * @throws {CosplayError} The `package.json` is missing or cannot be parsed. Reinstall cosplaying.
 */
export function packageVersion() {
  const file = fileURLToPath(new URL('../../../package.json', import.meta.url));
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version;
  } catch (error) {
    const message = error.message;
    throw new CosplayError({
      name: 'cli',
      method: 'packageVersion',
      message: 'could not read the package version from %s: %s. Reinstall cosplaying. The package.json for this install is missing or unreadable.',
      args: [file, message],
      cause: error,
    });
  }
}

/**
 * Resolves `main.js` for this install.
 *
 * Hook commands invoke this file so a symlink install still runs the real script.
 *
 * @returns {string} Canonical path of `main.js`. The unresolved path when the file cannot be canonicalized.
 */
export function realMainPath() {
  try {
    return realpathSync(mainPath);
  } catch {
    return mainPath;
  }
}

/**
 * Resolves the `cosplaying` executable in this install.
 *
 * Doctor uses this path to decide whether a hook command belongs to this package.
 *
 * @returns {string} Canonical path of `bin/cosplaying.js`. The unresolved path when the file cannot be canonicalized.
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
 * Builds the quoted command that starts this CLI.
 *
 * Installed hooks and the session prompt use this text. A supplied executable replaces the Node-plus-script form.
 *
 * @param {NodeJS.Platform} [platform=process.platform] Platform whose quoting rules are applied.
 * @param {string} [bin] Absolute path of a `cosplaying` executable. When this is set, the result is that path alone.
 * @returns {string} Quoted invocation. `bin` when it is set. Otherwise the quoted Node executable and the quoted `main.js` path.
 */
export function cliInvocation(platform = process.platform, bin) {
  if (bin) return quoteShell(bin, platform);
  return `${quoteShell(process.execPath, platform)} ${quoteShell(realMainPath(), platform)}`;
}

/**
 * Builds the prefix that shell rewrite inserts before a plugin command.
 *
 * The prefix runs `hook` so the plugin can add attribution. The model is passed as `--model-base64` so the shell does not split the name.
 *
 * @param {string} command Plugin command name, for example `git`.
 * @param {string} model Model name for this rewrite. An empty string omits `--model-base64`.
 * @param {NodeJS.Platform} [platform=process.platform] Platform whose quoting rules are applied to the CLI invocation.
 * @returns {string} Shell text of the form `<cli> hook [--model-base64 <value>] -- <command>`.
 */
export function commandPrefix(command, model, platform = process.platform) {
  const encoded = model ? ` --model-base64 ${Buffer.from(model, 'utf8').toString('base64url')}` : '';
  return `${cliInvocation(platform)} hook${encoded} -- ${command}`;
}
