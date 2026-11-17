import { cosmiconfigSync } from 'cosmiconfig';
import { CosplayError } from 'cosplaying/errors';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** @type {string} */
export const DEFAULT_LINK = 'https://www.npmjs.com/package/cosplaying';

/** @type {string} */
export const DEFAULT_MARKDOWN = 'Authored by {model} via [cosplaying]({link}). AI Assisted text may contain mistakes, please verify.';

/** @type {string} */
export const DEFAULT_TRAILER = '{model} via cosplaying ({link}). AI Assisted text may contain mistakes, please verify.';

/** The only settings filenames. User and project files use the same names. */
export const CONFIG_NAMES = ['.cosplaying.json', '.cosplaying.yaml', '.cosplaying.yml'];

const projectConfig = cosmiconfigSync('cosplaying', {
  searchPlaces: CONFIG_NAMES,
  searchStrategy: 'project',
});

const userConfig = cosmiconfigSync('cosplaying', {
  searchPlaces: CONFIG_NAMES,
  searchStrategy: 'none',
});

const defaults = {
  markdown: DEFAULT_MARKDOWN,
  trailer: DEFAULT_TRAILER,
  link: DEFAULT_LINK,
  plugins: [],
  variables: {},
};

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} overlay
 */
function merge(base, overlay) {
  return {
    ...base,
    ...overlay,
    variables: { ...base.variables, ...overlay.variables },
  };
}

/**
 * Map the public settings names to the flat values used by the CLI.
 * @param {unknown} config
 * @returns {Record<string, unknown>}
 */
function normalize(config) {
  const file = config ?? {};
  const attribution = file.attribution ?? {};
  const templates = attribution.templates ?? {};
  return Object.fromEntries(Object.entries({
    link: attribution.link ?? file.link,
    markdown: templates.markdown ?? attribution.template,
    trailer: templates.trailer,
    session: templates.session,
    plugins: file.plugins,
    variables: file.variables,
  }).filter(([, value]) => value !== undefined));
}

/**
 * @param {string} directory
 * @param {string[]} names
 */
export function assertSingleConfig(directory, names = CONFIG_NAMES) {
  const present = names.filter((name) => existsSync(path.join(directory, name)));
  if (present.length < 2) return;
  throw new CosplayError({
    name: 'cli',
    method: 'loadConfig',
    message: 'settings directory %s has more than one config file: %s. Keep one of .cosplaying.json, .cosplaying.yaml, or .cosplaying.yml and delete the others. Attribution stays blocked until that directory has one file.',
    args: [directory, present.join(', ')],
  });
}

/**
 * @param {string} file
 * @param {unknown} config
 */
function rejectConfigModel(file, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const attribution = /** @type {Record<string, unknown>} */ (config).attribution;
  const nested = attribution && typeof attribution === 'object' && !Array.isArray(attribution)
    && Object.hasOwn(attribution, 'model');
  if (!Object.hasOwn(config, 'model') && !nested) return;
  throw new CosplayError({
    name: 'cli',
    method: 'loadConfig',
    message: 'settings file %s cannot set the model. Pass --model <name> or set COSPLAYING_MODEL. Remove the model field from that file.',
    args: [file],
  });
}

/**
 * @param {import('cosmiconfig').PublicExplorerSync} explorer
 * @param {string} directory
 * @returns {import('cosmiconfig').CosmiconfigResult}
 */
function searchConfig(explorer, directory) {
  explorer.clearCaches();
  try {
    return explorer.search(directory);
  } catch (error) {
    if (error instanceof CosplayError) throw error;
    const file = error.filepath || directory;
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
 * @param {import('cosmiconfig').PublicExplorerSync} explorer
 * @param {string} directory
 * @param {string[]} [names]
 */
function read(explorer, directory, names) {
  const found = searchConfig(explorer, directory);
  if (!found) return {};
  if (names) assertSingleConfig(path.dirname(found.filepath), names);
  rejectConfigModel(found.filepath, found.config);
  return normalize(found.config);
}

/**
 * The project settings file cosmiconfig would load, including its raw contents.
 * @param {{cwd?: string}} [options]
 * @returns {import('cosmiconfig').CosmiconfigResult}
 */
export function findProjectConfig({ cwd = process.cwd() } = {}) {
  const found = searchConfig(projectConfig, cwd);
  if (!found) return null;
  assertSingleConfig(path.dirname(found.filepath));
  return found;
}

/**
 * The user settings file cosmiconfig would load, including its raw contents.
 * @param {{home?: string}} [options]
 * @returns {import('cosmiconfig').CosmiconfigResult}
 */
export function findUserConfig({ home = homedir() } = {}) {
  return searchConfig(userConfig, userConfigDirectory({ home }));
}

/**
 * Directory for the user config file and Claude session model files.
 * @param {{home?: string}} [options]
 * @returns {string}
 */
export function userConfigDirectory({ home = homedir() } = {}) {
  return path.join(home, '.config', 'cosplaying');
}

/**
 * @param {{cwd?: string, home?: string}} [options]
 */
export function loadConfig({ cwd = process.cwd(), home = homedir() } = {}) {
  const merged = [
    defaults,
    read(userConfig, userConfigDirectory({ home })),
    read(projectConfig, cwd, CONFIG_NAMES),
  ].reduce(merge);
  return merged;
}
