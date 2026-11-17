import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';
import { writeJsonAtomic } from 'cosplaying/hooks';
import { listPlugins } from 'cosplaying/plugin';
import { bundledPlugins } from './bundled.js';
import {
  CONFIG_NAMES,
  findProjectConfig,
  findUserConfig,
  userConfigDirectory,
} from './config.js';

/**
 * Stops enable and disable when the name is not a plugin that ships in this package.
 *
 * Only shipped plugins are toggled in the settings file. Other plugins are installed and removed with `plugin install` and `plugin uninstall`.
 *
 * @param {string} name Plugin name from the command line.
 * @param {Record<string, string>} shipped Map of shipped plugin name to directory.
 * @returns {void} No value when `name` is shipped.
 * @throws {CosplayError} `name` is not `git` or `gh`.
 */
function assertShipped(name, shipped) {
  if (shipped[name]) return;
  throw new CosplayError({
    name: 'cli',
    method: 'plugin',
    message: '%s is not a shipped plugin. Shipped plugins are git and gh. Run cosplaying plugin enable git or cosplaying plugin enable gh.',
    args: [name],
  });
}

/**
 * Loads the user settings that `plugin enable` and `plugin disable` edit.
 *
 * A missing file is an empty object. The caller writes that object to the default settings path.
 *
 * @param {object} context Runtime context.
 * @param {string} [context.home] Home directory used to find `~/.config/cosplaying`.
 * @returns {{file: string, data: Record<string, unknown>}} Path of the user settings file and a copy of its contents.
 */
function userSettings(context) {
  const directory = userConfigDirectory(context);
  const found = findUserConfig(context);
  if (!found) {
    return { file: path.join(directory, CONFIG_NAMES[0]), data: {} };
  }
  return { file: found.filepath, data: { ...found.config } };
}

/**
 * Turns on a shipped plugin in the user settings file.
 *
 * The command does not copy the plugin. It appends the name to `plugins` when the name is absent. A project settings list that omits the name blocks the change, because that list replaces the user list.
 *
 * @param {string} name Shipped plugin name, `git` or `gh`.
 * @param {object} context Runtime context.
 * @param {string} [context.cwd] Directory used to find project settings.
 * @param {string} [context.home] Home directory used to find user settings.
 * @param {NodeJS.ProcessEnv} [context.env] Environment used to list installed plugins.
 * @returns {Promise<{ok: true, name: string, directory: string} | {ok: false, status: number, error: string}>} Success includes the shipped directory. Failure includes exit status `1` and the error text.
 */
export async function enableBundledPlugin(name, context) {
  try {
    const shipped = bundledPlugins();
    assertShipped(name, shipped);
    const installed = await listPlugins(context);
    const conflict = installed.find((plugin) => plugin.command === name);
    if (conflict) {
      throw new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'plugin %s is already installed at %s. Run cosplaying plugin uninstall %s first.',
        args: [name, conflict.directory, name],
      });
    }
    const project = findProjectConfig(context);
    const projectPlugins = project?.config?.plugins;
    if (projectPlugins && !projectPlugins.includes(name)) {
      throw new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'project settings in %s keep plugin %s disabled. Add "%s" to the plugins list in that file, then run cosplaying plugin enable %s again.',
        args: [project.filepath, name, name, name],
      });
    }
    const { file, data } = userSettings(context);
    const plugins = data.plugins ?? [];
    if (!plugins.includes(name)) {
      data.plugins = [...plugins, name];
      writeJsonAtomic(file, data);
    }
    return { ok: true, name, directory: shipped[name] };
  } catch (error) {
    return {
      ok: false,
      status: 1,
      error: error instanceof CosplayError ? error.message : new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'could not enable plugin %s: %s. Fix the user settings file and run cosplaying plugin enable again.',
        args: [name, error.message],
        cause: error,
      }).message,
    };
  }
}

/**
 * Turns off a shipped plugin in the user settings file.
 *
 * The name is removed from the user `plugins` list. A project settings list that still names the plugin is left unchanged and reported, because that list replaces the user list.
 *
 * @param {string} name Shipped plugin name, `git` or `gh`.
 * @param {object} context Runtime context.
 * @param {string} [context.cwd] Directory used to find project settings.
 * @param {string} [context.home] Home directory used to find user settings.
 * @returns {Promise<{ok: true, name: string} | {ok: false, status: number, error: string}>} Success names the plugin. Failure includes exit status `1` and the error text.
 */
export async function disableBundledPlugin(name, context) {
  try {
    assertShipped(name, bundledPlugins());
    const found = findUserConfig(context);
    if (found?.config?.plugins?.includes(name)) {
      const data = { ...found.config };
      data.plugins = data.plugins.filter((entry) => entry !== name);
      writeJsonAtomic(found.filepath, data);
    }
    const project = findProjectConfig(context);
    if (project?.config?.plugins?.includes(name)) {
      throw new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'plugin %s is enabled in %s. Remove "%s" from the plugins list in that file.',
        args: [name, project.filepath, name],
      });
    }
    return { ok: true, name };
  } catch (error) {
    return {
      ok: false,
      status: 1,
      error: error instanceof CosplayError ? error.message : new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'could not disable plugin %s: %s. Fix the user settings file and run cosplaying plugin disable again.',
        args: [name, error.message],
        cause: error,
      }).message,
    };
  }
}
