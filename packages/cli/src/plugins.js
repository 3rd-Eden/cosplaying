import { loadConfiguredPlugins } from 'cosplaying/plugin';
import { bundledPlugins } from './bundled.js';
import { loadConfig } from './config.js';

/**
 * @param {object} context
 * @returns {object}
 */
export function bundledOptions(context) {
  return { ...context, bundled: bundledPlugins() };
}

/**
 * Installed plugins, plus config entries. A bare name uses a shipped plugin
 * only when no installed plugin has that name.
 * @param {object} context
 */
export async function loadPlugins(context) {
  const config = loadConfig(context);
  const plugins = await loadConfiguredPlugins(config.plugins, bundledOptions(context));
  return { config, plugins };
}
