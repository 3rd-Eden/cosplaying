import { loadConfiguredPlugins } from 'cosplaying/plugin';
import { bundledPlugins } from './bundled.js';
import { loadConfig } from './config.js';

/**
 * Adds the shipped plugin directories to a runtime context.
 *
 * Plugin loading uses this so a bare name in the settings file can select `git` or `gh` when no installed plugin has that name.
 *
 * @param {object} context Runtime context passed to the plugin loader. `cwd`, `home`, and `env` are preserved.
 * @returns {object} A copy of `context` with `bundled` set to the shipped plugin map.
 */
export function bundledOptions(context) {
  return { ...context, bundled: bundledPlugins() };
}

/**
 * Loads the plugins selected by user and project settings.
 *
 * Installed plugins are included. A bare name in the settings list uses a shipped plugin only when no installed plugin has that name.
 *
 * @param {object} context Runtime context.
 * @param {string} [context.cwd] Directory used to find the project settings file.
 * @param {string} [context.home] Home directory used to find the user settings file.
 * @param {NodeJS.ProcessEnv} [context.env] Environment used for plugin data paths.
 * @returns {Promise<{config: Record<string, unknown>, plugins: object[]}>} Merged settings and the plugins those settings select.
 * @throws {CosplayError} A settings file cannot be read, or a named plugin is not installed and is not shipped.
 */
export async function loadPlugins(context) {
  const config = loadConfig(context);
  const plugins = await loadConfiguredPlugins(config.plugins, bundledOptions(context));
  return { config, plugins };
}
