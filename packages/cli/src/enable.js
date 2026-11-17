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
 * @param {unknown} config
 * @returns {string[]}
 */
function pluginList(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const plugins = /** @type {{ plugins?: string[] }} */ (config).plugins;
  return plugins ?? [];
}

/**
 * @param {string} name
 * @param {Record<string, string>} shipped
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
 * @param {string} file
 * @param {Record<string, unknown>} data
 */
function writeConfig(file, data) {
  writeJsonAtomic(file, data);
}

/**
 * @param {{home?: string}} context
 * @returns {{ file: string, data: Record<string, unknown> }}
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
 * @param {string} name
 * @param {object} context
 * @returns {Promise<{ok: true, name: string, directory: string} | {ok: false, status: number, error: string}>}
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
    if (Array.isArray(projectPlugins) && !projectPlugins.includes(name)) {
      throw new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'project settings in %s keep plugin %s disabled. Add "%s" to the plugins list in that file, then run cosplaying plugin enable %s again.',
        args: [project.filepath, name, name, name],
      });
    }
    const { file, data } = userSettings(context);
    const plugins = pluginList(data);
    if (!plugins.includes(name)) {
      data.plugins = [...plugins, name];
      writeConfig(file, data);
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
 * @param {string} name
 * @param {object} context
 * @returns {Promise<{ok: true, name: string} | {ok: false, status: number, error: string}>}
 */
export async function disableBundledPlugin(name, context) {
  try {
    assertShipped(name, bundledPlugins());
    const directory = userConfigDirectory(context);
    const found = findUserConfig(context);
    if (found && pluginList(found.config).includes(name)) {
      const data = { ...found.config };
      data.plugins = pluginList(data).filter((entry) => entry !== name);
      writeConfig(found.filepath, data);
    }
    const project = findProjectConfig(context);
    if (project && pluginList(project.config).includes(name)) {
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
