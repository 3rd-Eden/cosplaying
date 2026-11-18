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
 * Gets the executable and arguments that start this CLI.
 *
 * @param {string} [bin] Executable that replaces the Node and script invocation.
 * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
 * @returns {string[]} Executable followed by its arguments.
 */
export function cliCommand(bin, entrypoint) {
  return bin ? [bin] : [process.execPath, entrypoint || realMainPath()];
}

/**
 * Builds the quoted command that starts this CLI.
 *
 * @param {NodeJS.Platform} [platform=process.platform] Platform whose quoting rules are applied.
 * @param {string} [bin] Absolute path of a `cosplaying` executable. When this is set, the result is that path alone.
 * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
 * @returns {string} Quoted invocation.
 */
export function cliInvocation(platform = process.platform, bin, entrypoint) {
  return cliCommand(bin, entrypoint).map((word) => quoteShell(word, platform)).join(' ');
}

/**
 * Builds the prefix that shell rewrite inserts before a plugin command.
 *
 * The prefix runs `hook` so the plugin can add attribution. The model is passed as `--model-base64` so the shell does not split the name.
 *
 * @param {string} command Plugin command name, for example `git`.
 * @param {string} model Model name for this rewrite. An empty string omits `--model-base64`.
 * @param {NodeJS.Platform} [platform=process.platform] Platform whose quoting rules are applied to the CLI invocation.
 * @param {string} [entrypoint] Wrapper script used in place of `main.js`.
 * @returns {string} Shell text of the form `<cli> hook [--model-base64 <value>] -- <command>`.
 */
export function commandPrefix(command, model, platform = process.platform, entrypoint) {
  const encoded = model ? ` --model-base64 ${Buffer.from(model, 'utf8').toString('base64url')}` : '';
  return `${cliInvocation(platform, undefined, entrypoint)} hook${encoded} -- ${command}`;
}
