import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';
import { writeJsonAtomic } from 'cosplaying/hooks';
import { listPlugins } from 'cosplaying/plugin';
import { bundledPlugins } from './bundled.js';
import { fileSchema, schemaIssues } from './config-schema.js';
import { findProjectConfig, findUserConfig, userConfigDirectory, userConfigFiles } from './config.js';

/**
 * @param {unknown} config
 * @returns {string[] | null}
 */
function pluginNames(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (!Object.hasOwn(config, 'plugins')) return [];
  const plugins = /** @type {{plugins?: unknown}} */ (config).plugins;
  if (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== 'string')) return null;
  return plugins;
}

/**
 * @param {string} file
 * @param {unknown} config
 */
function assertSettings(file, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new CosplayError({
      name: 'cli',
      method: 'plugin',
      message: 'settings file %s is not a JSON object. Replace it with an object that contains a plugins array, or delete the file.',
      args: [file],
    });
  }
  const parsed = fileSchema.safeParse(config);
  if (!parsed.success) {
    throw new CosplayError({
      name: 'cli',
      method: 'loadConfig',
      message: 'settings file %s does not match the config schema: %s. Edit that file so link, plugins, variables, and attribution.templates match the documented shape, or delete the file to use the defaults.',
      args: [file, schemaIssues(parsed.error)],
    });
  }
}

/**
 * @param {string[]} files
 */
function assertOneUserFile(files) {
  if (files.length < 2) return;
  throw new CosplayError({
    name: 'cli',
    method: 'plugin',
    message: 'settings directory %s has more than one config file: %s. Keep one of config.json, config.yaml, or config.yml and delete the others.',
    args: [path.dirname(files[0]), files.map((file) => path.basename(file)).join(', ')],
  });
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
 * @returns {Record<string, unknown>}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CosplayError({
      name: 'cli',
      method: 'loadConfig',
      message: 'settings file %s could not be read: %s. Fix the JSON or YAML syntax, or delete the file to use the defaults.',
      args: [file, error.message],
      cause: error,
    });
  }
}

/**
 * @param {string} name
 * @param {import('cosmiconfig').CosmiconfigResult} found
 * @param {string[]} holders
 */
function hold(name, found, holders) {
  if (!found) return;
  const names = pluginNames(found.config);
  if (names?.includes(name)) holders.push(found.filepath);
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
    const files = userConfigFiles(context);
    assertOneUserFile(files);
    const yaml = files.find((file) => !file.endsWith('.json'));
    if (yaml) {
      throw new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'user settings file %s is YAML. Add "%s" to the plugins list in that file.',
        args: [yaml, name],
      });
    }
    const file = path.join(userConfigDirectory(context), 'config.json');
    /** @type {Record<string, unknown>} */
    const data = files.length ? readJson(file) : {};
    assertSettings(file, data);
    const current = pluginNames(data) ?? [];
    if (!current.includes(name)) {
      data.plugins = [...current, name];
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
 * @param {string} name
 * @param {object} context
 * @returns {Promise<{ok: true, name: string} | {ok: false, status: number, error: string}>}
 */
export async function disableBundledPlugin(name, context) {
  try {
    assertShipped(name, bundledPlugins());
    const files = userConfigFiles(context);
    assertOneUserFile(files);
    const json = files.find((file) => file.endsWith(`${path.sep}config.json`));
    if (json) {
      const data = readJson(json);
      assertSettings(json, data);
      const current = pluginNames(data) ?? [];
      if (current.includes(name)) {
        data.plugins = current.filter((entry) => entry !== name);
        writeJsonAtomic(json, data);
        return { ok: true, name };
      }
    }
    /** @type {string[]} */
    const holders = [];
    if (!json && files.length === 1) {
      const user = findUserConfig(context);
      assertSettings(files[0], user?.config);
      hold(name, user, holders);
    }
    const project = findProjectConfig(context);
    if (project) assertSettings(project.filepath, project.config);
    hold(name, project, holders);
    if (holders.length) {
      throw new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'plugin %s is enabled in %s. Remove "%s" from the plugins list in that file.',
        args: [name, holders.join(', '), name],
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
