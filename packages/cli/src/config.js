import { cosmiconfigSync } from 'cosmiconfig';
import { LayerError } from '@mcp-layer/error';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { configSchema, envSchema, fileSchema, schemaIssues } from './config-schema.js';

const errorScope = 'cosplaying';
const errorDocs = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/** @type {string} */
export const DEFAULT_LINK = 'https://www.npmjs.com/package/cosplaying';

/** @type {string} */
export const DEFAULT_MARKDOWN = 'Authored by {model} via [cosplaying]({link}). AI Assisted text may contain mistakes, please verify.';

/** @type {string} */
export const DEFAULT_TRAILER = '{model} via cosplaying ({link}). AI Assisted text may contain mistakes, please verify.';

const projectConfig = cosmiconfigSync('cosplaying', {
  searchPlaces: ['.cosplaying.json', '.cosplaying.yaml', '.cosplaying.yml'],
  searchStrategy: 'project',
});

const userConfig = cosmiconfigSync('cosplaying', {
  searchPlaces: ['config.json', 'config.yaml', 'config.yml'],
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

const PROJECT_CONFIG_NAMES = ['.cosplaying.json', '.cosplaying.yaml', '.cosplaying.yml'];

/**
 * @param {string} directory
 * @param {string[]} names
 */
function assertSingleConfig(directory, names) {
  const present = names.filter((name) => existsSync(path.join(directory, name)));
  if (present.length < 2) return;
  throw new LayerError({
    name: 'cli',
    scope: errorScope,
    docs: errorDocs,
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
  throw new LayerError({
    name: 'cli',
    scope: errorScope,
    docs: errorDocs,
    method: 'loadConfig',
    message: 'settings file %s cannot set the model. Pass --model <name> or set COSPLAYING_MODEL. Remove the model field from that file.',
    args: [file],
  });
}

/**
 * @param {import('cosmiconfig').PublicExplorerSync} explorer
 * @param {string} directory
 * @param {string[]} [names]
 */
function read(explorer, directory, names) {
  let found;
  try {
    found = explorer.search(directory);
  } catch (error) {
    if (error instanceof LayerError) throw error;
    const file = error.filepath || directory;
    throw new LayerError({
      name: 'cli',
      scope: errorScope,
      docs: errorDocs,
      method: 'loadConfig',
      message: 'settings file %s could not be read: %s. Fix the JSON or YAML syntax, or delete the file to use the defaults.',
      args: [file, error.message],
      cause: error,
    });
  }
  if (!found) return {};
  if (names) assertSingleConfig(path.dirname(found.filepath), names);
  rejectConfigModel(found.filepath, found.config);
  const parsed = fileSchema.safeParse(found.config);
  if (!parsed.success) {
    throw new LayerError({
      name: 'cli',
      scope: errorScope,
      docs: errorDocs,
      method: 'loadConfig',
      message: 'settings file %s does not match the config schema: %s. Edit that file so link, plugins, variables, and attribution.templates match the documented shape, or delete the file to use the defaults.',
      args: [found.filepath, schemaIssues(parsed.error)],
    });
  }
  return parsed.data;
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
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, home?: string}} [options]
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const merged = [
    defaults,
    read(userConfig, userConfigDirectory({ home })),
    read(projectConfig, cwd, PROJECT_CONFIG_NAMES),
    envSchema.parse(env),
  ].reduce(merge);
  return configSchema.parse(merged);
}
