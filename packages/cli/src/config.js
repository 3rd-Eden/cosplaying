import { cosmiconfigSync } from 'cosmiconfig';
import { CosplayError } from 'cosplaying/errors';
import { homedir } from 'node:os';
import path from 'node:path';

/** @type {string} */
export const DEFAULT_LINK = 'https://github.com/3rd-eden/cosplaying';

/** @type {string} */
export const DEFAULT_MARKDOWN = '> 🤖 Authored by {model} via [cosplaying]({link}). AI Assisted text may contain mistakes, please verify.';

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
 * Combines two settings objects.
 *
 * Later settings replace earlier ones. `variables` is merged by key so a project file can add a variable without deleting the user variables.
 *
 * @param {Record<string, unknown>} base Defaults or the settings already loaded.
 * @param {Record<string, unknown>} overlay Settings from the next file. Its keys win, except that `variables` is combined.
 * @returns {Record<string, unknown>} Combined settings. `variables` contains keys from both objects.
 */
function merge(base, overlay) {
  return {
    ...base,
    ...overlay,
    variables: { ...base.variables, ...overlay.variables },
  };
}

/**
 * Maps the public settings names onto the flat fields the CLI reads.
 *
 * The file may use `prompts.session` and `prompts.empty` for the text a harness shows at session start. `attribution.templates.session` and `attribution.templates.empty` supply the same fields when the `prompts` key is absent. The file may also use `attribution.link` and `attribution.templates`. Older files may use `link` and `attribution.template`. Fields that are absent stay absent so the defaults remain.
 *
 * @param {unknown} config Parsed settings object. A missing value is treated as an empty object.
 * @returns {Record<string, unknown>} Flat settings. Keys are `link`, `markdown`, `trailer`, `session`, `empty`, `plugins`, and `variables`, and only keys that were set are present.
 */
function normalize(config) {
  const file = config ?? {};
  const attribution = file.attribution ?? {};
  const templates = attribution.templates ?? {};
  const prompts = file.prompts ?? {};
  return Object.fromEntries(Object.entries({
    link: attribution.link ?? file.link,
    markdown: templates.markdown ?? attribution.template,
    trailer: templates.trailer,
    session: prompts.session ?? templates.session,
    empty: prompts.empty ?? templates.empty,
    plugins: file.plugins,
    variables: file.variables,
  }).filter(([, value]) => value !== undefined));
}

/**
 * Rejects a settings file that tries to name the model.
 *
 * The model comes from `--model`, `--model-base64`, or `COSPLAYING_MODEL`. A file must not supply it, or a later session would attribute the wrong model.
 *
 * @param {string} file Path of the settings file that was loaded.
 * @param {unknown} config Parsed contents of that file.
 * @returns {void} No value when neither `model` nor `attribution.model` is present.
 * @throws {CosplayError} The file sets `model` or `attribution.model`.
 */
function rejectConfigModel(file, config) {
  if (!Object.hasOwn(config ?? {}, 'model') && !Object.hasOwn(config?.attribution ?? {}, 'model')) return;
  throw new CosplayError({
    name: 'cli',
    method: 'loadConfig',
    message: 'settings file %s cannot set the model. Pass --model <name> or set COSPLAYING_MODEL. Remove the model field from that file.',
    args: [file],
  });
}

/**
 * Searches one directory for a cosplaying settings file.
 *
 * The cache is cleared first so a test or a second command sees the file that is on disk now.
 *
 * @param {import('cosmiconfig').PublicExplorerSync} explorer Cosmiconfig explorer for the project walk or the user directory.
 * @param {string} directory Directory where the search starts.
 * @returns {import('cosmiconfig').CosmiconfigResult} The loaded file, or null when no settings file is found.
 * @throws {CosplayError} The file exists but the JSON or YAML cannot be parsed.
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
 * Loads one settings file and returns the flat fields the CLI uses.
 *
 * A missing file contributes nothing. A file that sets the model is rejected before its other fields are used.
 *
 * @param {import('cosmiconfig').PublicExplorerSync} explorer Cosmiconfig explorer for the project walk or the user directory.
 * @param {string} directory Directory where the search starts.
 * @returns {Record<string, unknown>} Flat settings from that file. An empty object when no file is found.
 * @throws {CosplayError} The file cannot be parsed, or it sets the model.
 */
function read(explorer, directory) {
  const found = searchConfig(explorer, directory);
  if (!found) return {};
  rejectConfigModel(found.filepath, found.config);
  return normalize(found.config);
}

/**
 * Finds the project settings file that cosmiconfig would load.
 *
 * Enable and disable read this result so they can see the raw `plugins` list. The search walks parent directories from `cwd`.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()] Directory where the project search starts.
 * @returns {import('cosmiconfig').CosmiconfigResult} The file path and its parsed contents, or null when no project file exists.
 * @throws {CosplayError} A settings file on the walk cannot be parsed.
 */
export function findProjectConfig({ cwd = process.cwd() } = {}) {
  return searchConfig(projectConfig, cwd);
}

/**
 * Finds the user settings file that cosmiconfig would load.
 *
 * The search does not walk parent directories. It looks only in the user config directory.
 *
 * @param {object} [options]
 * @param {string} [options.home=homedir()] Home directory. Tests pass a temporary home.
 * @returns {import('cosmiconfig').CosmiconfigResult} The file path and its parsed contents, or null when no user file exists.
 * @throws {CosplayError} The user settings file cannot be parsed.
 */
export function findUserConfig({ home = homedir() } = {}) {
  return searchConfig(userConfig, userConfigDirectory({ home }));
}

/**
 * Returns the directory that holds the user settings file and the session model files.
 *
 * The path is under the supplied home. Tests inject `home` so this process does not read the developer home. There is no separate platform matrix.
 *
 * @param {object} [options]
 * @param {string} [options.home=homedir()] Home directory. Tests pass a temporary home.
 * @returns {string} `<home>/.config/cosplaying`.
 */
export function userConfigDirectory({ home = homedir() } = {}) {
  return path.join(home, '.config', 'cosplaying');
}

/**
 * Loads the settings that attribution, session prompts, and plugin selection use.
 *
 * Defaults are applied first, then the user file, then the project file. A project value replaces a user value. `variables` are merged by key.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()] Directory where the project search starts.
 * @param {string} [options.home=homedir()] Home directory used to find the user file.
 * @returns {{markdown: string, trailer: string, link: string, plugins: string[], variables: Record<string, string>, session?: string, empty?: string}} Effective settings. `session` and `empty` are present only when a file sets them.
 * @throws {CosplayError} A settings file cannot be parsed, or a file sets the model.
 */
export function loadConfig({ cwd = process.cwd(), home = homedir() } = {}) {
  return [
    defaults,
    read(userConfig, userConfigDirectory({ home })),
    read(projectConfig, cwd),
  ].reduce(merge);
}
