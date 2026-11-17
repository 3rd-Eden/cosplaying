import { spawn, spawnSync } from 'node:child_process';
import which from 'which';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CosplayError } from 'cosplaying/errors';
import { PluginManager } from 'live-plugin-manager';
import { quoteShell } from 'cosplaying/hooks';

/** @type {Set<string>} */
export const RESERVED_COMMANDS = new Set([
  'hook', 'agent-hook', 'rewrite', 'install', 'uninstall', 'doctor', 'plugin',
]);

/**
 * Writes the standard refusal for a command that was not run.
 *
 * Plugins call this when attribution cannot be added. The text tells the agent not to bypass cosplaying when no safe correction is stated.
 *
 * @param {NodeJS.WritableStream} stderr Stream that receives the refusal. Plugins pass the hook stderr.
 * @param {string} reason Why the command was refused, including the next action when one exists.
 * @returns {void} No value.
 */
export function block(stderr, reason) {
  stderr.write(`cosplaying: BLOCKED (command not run)\nReason: ${reason}\nIf no safe correction is stated, stop and ask the user; do not bypass cosplaying.\n`);
}

/**
 * Runs work against a private copy of a text file after attribution is added.
 *
 * The original file is not modified. The copy is mode `0600` and is deleted after `work` finishes, including when `work` throws. A file that is not valid UTF-8 is rejected so the copy cannot hide replacement characters.
 *
 * @param {string} sourcePath Path of the file the wrapped command would have read.
 * @param {(text: string) => string} render Function that returns the attributed text. It receives the original UTF-8 text.
 * @param {(copyPath: string) => unknown} work Function that uses the copy. It receives the copy path. Its return value is the result of this function.
 * @returns {Promise<unknown>} The value returned by `work`.
 * @throws {CosplayError} The source cannot be read, is not UTF-8, or the copy cannot be written. The original file is unchanged.
 */
export async function withAttributedCopy(sourcePath, render, work) {
  let bytes;
  try {
    bytes = readFileSync(sourcePath);
  } catch (error) {
    throw new CosplayError({
      name: 'plugin',
      method: 'withAttributedCopy',
      message: 'could not read %s: %s. Check that the source file exists and is readable, then retry the command.',
      args: [sourcePath, error.message],
      cause: error,
    });
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new CosplayError({
      name: 'plugin',
      method: 'withAttributedCopy',
      message: 'could not read %s: %s. Check that the source file exists and is readable, then retry the command.',
      args: [sourcePath, 'file is not valid UTF-8'],
    });
  }
  const rendered = render(text);
  const copyPath = path.join(
    tmpdir(),
    `cosplaying-${process.pid}-${randomBytes(4).toString('hex')}${path.extname(sourcePath)}`,
  );
  try {
    writeFileSync(copyPath, rendered, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    throw new CosplayError({
      name: 'plugin',
      method: 'withAttributedCopy',
      message: 'could not write the attributed copy %s: %s. Free space in the temporary directory and retry the command. The original file was not changed.',
      args: [copyPath, error.message],
      cause: error,
    });
  }
  try {
    chmodSync(copyPath, 0o600);
  } catch {
    // Windows may reject POSIX modes.
  }
  try {
    return await work(copyPath);
  } finally {
    try {
      unlinkSync(copyPath);
    } catch {
      // The copy is already gone.
    }
  }
}

/**
 * Returns the directory where installed plugin packages are stored.
 *
 * An absolute `XDG_DATA_HOME` selects the data root. Otherwise the directory is under the supplied home. Tests inject `home` so the developer data directory is not used.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] Environment. An absolute `XDG_DATA_HOME` overrides the home-based path.
 * @param {string} [options.home=homedir()] Home directory used when `XDG_DATA_HOME` is absent or relative.
 * @returns {string} `<data-root>/cosplaying/plugins`.
 */
export function pluginDataDirectory({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, '.local', 'share');
  return path.join(base, 'cosplaying', 'plugins');
}

/**
 * Returns the production dependencies declared by a plugin package.
 *
 * Optional dependencies are included because the plugin can require them at runtime. Development dependencies are omitted.
 *
 * @param {object | undefined} manifest Parsed `package.json`. A missing manifest has no dependencies.
 * @param {Record<string, string>} [manifest.dependencies] Production dependency ranges.
 * @param {Record<string, string>} [manifest.optionalDependencies] Optional dependency ranges.
 * @returns {Record<string, unknown>} Combined dependency map. Later keys in `optionalDependencies` replace the same key in `dependencies`.
 */
function productionDependencies(manifest) {
  return {
    ...manifest?.dependencies,
    ...manifest?.optionalDependencies,
  };
}

/**
 * Reports whether live-plugin-manager cannot install one dependency spec.
 *
 * That package installs a version range from the npm registry and an `owner/repo` spec from GitHub. A `file:`, URL, or path spec is neither of those. `installFromPath` treats a spec that contains `/` as a GitHub repository and throws before it links the package, so the plugin would have no `node_modules`.
 *
 * @param {unknown} spec Dependency range from `package.json`.
 * @returns {boolean} True for an empty spec, a URL or protocol spec, or a relative or absolute path.
 */
function livePluginManagerCannotInstall(spec) {
  if (spec === '') return true;
  if (/^(?:file|link|portal|workspace|git\+|github|http|https):/i.test(spec)) return true;
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\') || spec.startsWith('~');
}

/**
 * Builds ignore patterns for dependency specs that live-plugin-manager cannot install.
 *
 * The manager is told to skip those names. This installer then runs npm for the `file:` case the manager left behind.
 *
 * @param {object | undefined} manifest Parsed plugin `package.json`.
 * @returns {RegExp[]} One anchored pattern per dependency name that the manager cannot install.
 */
function unsupportedDependencyPatterns(manifest) {
  return Object.entries(productionDependencies(manifest))
    .filter(([, spec]) => livePluginManagerCannotInstall(spec))
    .map(([name]) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

/**
 * Parses a `file:` dependency spec into the path it names.
 *
 * A relative path must be rewritten after the plugin is copied, because the copy is no longer next to the author's tree. An absolute path can stay as it is.
 *
 * @param {string} spec Dependency spec from `package.json`.
 * @returns {{absolute: boolean, pathname?: string} | null} Null when the spec is not `file:`. Otherwise whether the path is absolute, and the path when it could be read.
 */
function fileDependencyTarget(spec) {
  const match = /^file:(.*)$/i.exec(spec);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith('//')) {
    try {
      const url = new URL(spec);
      return { absolute: true, pathname: decodeURIComponent(url.pathname) };
    } catch {
      return { absolute: true };
    }
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return { absolute: true, pathname: raw };
  return { absolute: false, pathname: raw };
}

/**
 * Rewrites relative `file:` dependencies so they point at the source tree.
 *
 * The installed tree is a copy, so a relative spec no longer points at the author's package. Absolute `file:` specs are left unchanged. The manifest is written only when a spec changes.
 *
 * @param {string} directory Installed plugin directory whose `package.json` is edited.
 * @param {string} sourceDirectory Plugin directory that was passed to install. Relative specs are resolved from here.
 * @returns {void} No value.
 */
function rewriteRelativeFileDependencies(directory, sourceDirectory) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let changed = false;
  for (const field of ['dependencies', 'optionalDependencies']) {
    const deps = manifest[field] ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      const target = fileDependencyTarget(spec);
      if (!target || target.absolute || !target.pathname) continue;
      deps[name] = `file:${path.resolve(sourceDirectory, target.pathname)}`;
      changed = true;
    }
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Finds the npm executable used to install plugin dependencies that the plugin manager skipped.
 *
 * The Node directory is searched before `PATH`, so the npm that belongs to this Node is preferred.
 *
 * @returns {string} Absolute npm path when `which` finds one. The name `npm` when it does not.
 */
function npmExecutable() {
  const found = which.sync('npm', {
    path: [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    nothrow: true,
  });
  return found || 'npm';
}

/**
 * Installs production dependencies that live-plugin-manager did not install.
 *
 * The manager already installs registry and GitHub dependencies. This runs only when that left no `node_modules` and the package still has production dependencies, which is the `file:` case it cannot install. npm is run with `--ignore-scripts` and `--omit=dev`.
 *
 * @param {string} directory Installed plugin directory.
 * @param {string} [sourceDirectory] Original plugin directory. Relative `file:` specs are rewritten from here before npm runs.
 * @returns {void} No value. A directory that already has `node_modules`, or that has no production dependencies, is left unchanged.
 * @throws {CosplayError} npm exits with an error or a non-zero status.
 */
function installProductionDependencies(directory, sourceDirectory) {
  const manifestPath = path.join(directory, 'package.json');
  if (!exists(manifestPath) || exists(path.join(directory, 'node_modules'))) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (Object.keys(productionDependencies(manifest)).length === 0) return;
  if (sourceDirectory) rewriteRelativeFileDependencies(directory, sourceDirectory);
  const npm = npmExecutable();
  const result = defaultSpawn(npm, ['install', '--ignore-scripts', '--omit=dev'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim() || result.error?.message || 'npm install failed';
    throw new CosplayError({
      name: 'plugin',
      method: 'installPlugin',
      message: 'could not install dependencies for %s: %s. Fix the dependency, then run cosplaying plugin install again.',
      args: [directory, detail],
      cause: result.error,
    });
  }
}

/**
 * Creates the plugin manager for this process.
 *
 * The manager stores plugins under the cosplaying data directory. Type packages are ignored. Dependency specs the manager cannot install are ignored so it does not treat a `file:` spec as a GitHub repository.
 *
 * @param {object} options Runtime context.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used to choose the data directory.
 * @param {string} [options.home] Home directory used to choose the data directory.
 * @param {string} [options.cwd] Working directory the manager uses for relative installs.
 * @param {object} [manifest] Parsed `package.json` whose unsupported dependencies are ignored.
 * @returns {PluginManager} Manager bound to the plugin data directory.
 */
function managerFor(options, manifest) {
  return new PluginManager({
    pluginsPath: pluginDataDirectory(options),
    cwd: options.cwd || process.cwd(),
    ignoredDependencies: [/^@types\//, ...unsupportedDependencyPatterns(manifest)],
  });
}

/**
 * Removes an npm scope from a package name.
 *
 * The command the plugin intercepts is the unscoped name. `@example/git` becomes `git`.
 *
 * @param {string} name Package name or directory name.
 * @returns {string} Name with a leading `@scope/` removed. `name` when it has no scope.
 */
function unscoped(name) {
  return name.replace(/^@[^/]+\//, '');
}

const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Builds the error for a plugin command name that cannot be a shell word.
 *
 * The command is the executable that shell rewrite replaces. It must be one token of letters, digits, underscores, and hyphens.
 *
 * @param {string} name Unscoped package name that failed the command pattern.
 * @returns {CosplayError} Error that tells the author to rename the package.
 */
function commandNameError(name) {
  return new CosplayError({
    name: 'plugin',
    method: 'loadModule',
    message: 'plugin command %s must be a single token of letters, digits, underscores, and hyphens. Rename the package so the command matches that token.',
    args: [name],
  });
}

/**
 * Resolves the command name and the JavaScript file that implements a plugin.
 *
 * The command is the unscoped package name, or the directory name when the manifest has no name. `main` defaults to `index.js`. The file must stay inside the plugin directory after symlinks are resolved, and it must not be TypeScript. Node will not type-strip a file under `node_modules`.
 *
 * @param {string} directory Plugin directory that contains `package.json`.
 * @param {{name?: string, main?: string}} manifest Parsed `package.json`.
 * @returns {{name: string, mainFile: string}} Unscoped command name and the canonical entry path.
 * @throws {CosplayError} The command name is not a single token, the entry is TypeScript, or the entry resolves outside the plugin directory.
 */
function resolvePluginEntry(directory, manifest) {
  const name = unscoped(manifest.name || path.basename(directory));
  if (!COMMAND_PATTERN.test(name)) throw commandNameError(name);
  const mainField = manifest.main || 'index.js';
  const mainFile = path.resolve(directory, mainField);
  if (/\.(?:[cm]?ts|tsx)$/.test(mainFile)) {
    throw new CosplayError({
      name: 'plugin',
      method: 'loadModule',
      message: 'plugin entry %s is TypeScript. Write the plugin in JavaScript. Node will not run TypeScript once that file is under node_modules.',
      args: [mainFile],
    });
  }
  let root = path.resolve(directory);
  try {
    root = realpathSync(directory);
  } catch {
    root = path.resolve(directory);
  }
  let real = path.resolve(mainFile);
  try {
    real = realpathSync(mainFile);
  } catch {
    real = path.resolve(mainFile);
  }
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CosplayError({
      name: 'plugin',
      method: 'loadModule',
      message: 'plugin entry %s is outside %s. Set package.json main to a JavaScript file inside the plugin directory.',
      args: [real, root],
    });
  }
  return { name, mainFile: real };
}

/**
 * Reads an `owner/repo` GitHub spec from a plugin install source.
 *
 * A GitHub URL and a bare `owner/repo` spec are accepted. A local path is not a repository. A `#ref` suffix is removed.
 *
 * @param {string} source Argument of `plugin install`.
 * @returns {string | null} `owner/repo` when the source is a GitHub repository. Null for a local path or any other source.
 */
function githubRepo(source) {
  const remote = source.match(/github\.com[:/]([^/]+)\/([^/#.]+)/);
  if (remote) return `${remote[1]}/${remote[2]}`;
  if (/^[^/\s]+\/[^/\s#]+/.test(source) && !source.startsWith('.')) return source.split('#')[0];
  return null;
}

/**
 * Imports a plugin module and reads the fields the CLI needs.
 *
 * `require` cannot load an ESM package, so the entry is imported by file URL. The default export may be the `run` function or an object with `run`. `description`, `examples`, and `intercept` may be named exports or fields of that object. A command that shadows a built-in command is rejected.
 *
 * @param {string} mainFile Absolute path of the plugin entry file.
 * @param {string} name Unscoped command name.
 * @returns {Promise<{command: string, run: Function | undefined, description: string, examples: string[], intercept: boolean | undefined}>} Descriptor used by `hook` and by help. `intercept` is undefined when the plugin does not set it, which means the command is rewritten.
 * @throws {CosplayError} `name` is a reserved CLI command, or Node cannot import the entry.
 */
async function loadModule(mainFile, name) {
  if (RESERVED_COMMANDS.has(name)) {
    throw new CosplayError({
      name: 'plugin',
      method: 'loadModule',
      message: 'plugin command is reserved: %s. Rename the package. Reserved names are hook, agent-hook, rewrite, install, uninstall, doctor, and plugin.',
      args: [name],
    });
  }
  let imported;
  try {
    imported = await import(pathToFileURL(mainFile).href);
  } catch (error) {
    throw new CosplayError({
      name: 'plugin',
      method: 'loadModule',
      message: 'could not import plugin %s: %s. Fix the plugin entry so Node can import it, then run the command again. The underlying CLI was not run.',
      args: [mainFile, error.message],
      cause: error,
    });
  }
  const exported = imported.default;
  const run = typeof exported === 'function' ? exported : exported?.run;
  const fields = typeof exported === 'function' ? imported : exported;
  return {
    command: name,
    run,
    description: fields?.description ?? '',
    examples: fields?.examples ?? [],
    intercept: fields?.intercept,
  };
}

/**
 * Lists installed plugin directories under the plugin data directory.
 *
 * live-plugin-manager links a scoped package at `plugins/@scope/<name>`. A directory is included only when it contains `package.json`. `.versions` is the download cache and is skipped because its name starts with a dot.
 *
 * @param {string} root Plugin data directory. A missing directory yields an empty list.
 * @returns {string[]} Absolute package directories. The order is the directory order from `readdir`.
 */
function pluginPackageDirectories(root) {
  /** @type {string[]} */
  const found = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return found;
  }
  for (const folder of names) {
    if (folder.startsWith('.')) continue;
    const directory = path.join(root, folder);
    if (exists(path.join(directory, 'package.json'))) {
      found.push(directory);
      continue;
    }
    if (!folder.startsWith('@')) continue;
    let children;
    try {
      children = readdirSync(directory);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.startsWith('.')) continue;
      const inner = path.join(directory, child);
      if (exists(path.join(inner, 'package.json'))) found.push(inner);
    }
  }
  return found;
}

/**
 * Finds installed plugins whose command or package name equals `name`.
 *
 * Uninstall uses this so either the command or the scoped package name selects the directory. Two matches are returned to the caller, which refuses an ambiguous name.
 *
 * @param {string} root Plugin data directory.
 * @param {string} name Command name or package name from the command line.
 * @returns {Array<{directory: string, manifest: {name?: string}, command: string}>} Matching packages. An empty list when none match.
 */
function matchingPlugins(root, name) {
  /** @type {Array<{directory: string, manifest: {name?: string}, command: string}>} */
  const matches = [];
  for (const directory of pluginPackageDirectories(root)) {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const packageName = manifest.name || path.basename(directory);
    const command = unscoped(packageName);
    if (command === name || packageName === name) matches.push({ directory, manifest, command });
  }
  return matches;
}

/**
 * Builds the error text for a plugin that is already installed.
 *
 * A second `installFromPath` would succeed, so install refuses it and tells the operator to uninstall first.
 *
 * @param {string} name Plugin command name.
 * @param {string} directory Directory of the plugin that is already installed.
 * @returns {string} Error text that includes the uninstall command.
 */
function alreadyInstalledMessage(name, directory) {
  return new CosplayError({
    name: 'plugin',
    method: 'installPlugin',
    message: 'plugin %s is already installed at %s. Run cosplaying plugin uninstall %s first. Uninstall it, then install the plugin again.',
    args: [name, directory, name],
  }).message;
}

/**
 * Loads every plugin package stored in the plugin data directory.
 *
 * `list()` on the plugin manager only remembers plugins installed in the current process, so a later process reads the package directories instead. The result is sorted by command name.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] Environment used to choose the data directory.
 * @param {string} [options.home] Home directory used to choose the data directory.
 * @param {NodeJS.Platform} [options.platform] Accepted for callers that pass the whole context. This function does not read it.
 * @returns {Promise<Array<{name: string, command: string, kind: string, directory: string, entry: string, descriptor: Record<string, unknown>}>>} Installed plugins. `kind` is `path`. `descriptor` is the imported module fields.
 * @throws {CosplayError} A package entry cannot be imported, or two packages declare the same command when a later loader checks them.
 */
export async function loadInstalledPlugins(options = {}) {
  const loaded = [];
  for (const directory of pluginPackageDirectories(pluginDataDirectory(options))) {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const { name, mainFile } = resolvePluginEntry(directory, manifest);
    const descriptor = await loadModule(mainFile, name);
    loaded.push({
      name,
      command: name,
      kind: 'path',
      directory,
      entry: mainFile,
      descriptor,
    });
  }
  loaded.sort((left, right) => left.command.localeCompare(right.command));
  return loaded;
}

/**
 * Loads one plugin directory and labels where it came from.
 *
 * A configured path and a shipped plugin both use this. The kind tells `plugin list` whether the plugin is installed or bundled.
 *
 * @param {string} directory Directory that contains the plugin `package.json`.
 * @param {string} kind `path` for an installed or configured directory. `bundled` for a plugin that ships in this package.
 * @returns {Promise<{name: string, command: string, kind: string, directory: string, entry: string, descriptor: object}>} Plugin record for the CLI.
 * @throws {CosplayError} The entry cannot be resolved or imported.
 */
async function loadPluginDirectory(directory, kind) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const { name, mainFile } = resolvePluginEntry(directory, manifest);
  const descriptor = await loadModule(mainFile, name);
  return {
    name,
    command: name,
    kind,
    directory,
    entry: mainFile,
    descriptor,
  };
}

/**
 * Loads installed plugins plus the entries named in settings.
 *
 * Every installed plugin is included. A settings entry that is a path is loaded from that directory. A bare name uses the installed plugin of that name, or a shipped plugin when no installed plugin has the name. Two plugins with the same command are rejected.
 *
 * @param {string[]} entries `plugins` list from settings. Each item is a command name or a path.
 * @param {object} options Runtime context.
 * @param {string} [options.cwd] Directory used to resolve a relative path entry.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used to find installed plugins.
 * @param {string} [options.home] Home directory used to find installed plugins.
 * @param {NodeJS.Platform} [options.platform] Accepted with the rest of the context. This function does not read it.
 * @param {Record<string, string>} [options.bundled] Map of shipped plugin name to directory.
 * @returns {Promise<object[]>} Selected plugins. Installed plugins come first, then settings entries that were not already included.
 * @throws {CosplayError} A named plugin is not installed and is not shipped, or two plugins declare the same command.
 */
export async function loadConfiguredPlugins(entries, options) {
  const installed = await loadInstalledPlugins(options);
  const byName = new Map(installed.map((plugin) => [plugin.name, plugin]));
  const byCommand = new Map();
  /** @type {typeof installed} */
  const selected = [];
  for (const plugin of installed) {
    if (byCommand.has(plugin.command)) {
      throw new CosplayError({
        name: 'plugin',
        method: 'loadInstalledPlugins',
        message: 'plugin command %s is declared by more than one plugin. Uninstall one plugin with cosplaying plugin uninstall <name>, or remove the duplicate from the plugins list.',
        args: [plugin.command],
      });
    }
    byCommand.set(plugin.command, plugin);
    selected.push(plugin);
  }
  for (const entry of entries) {
    const isPath = path.isAbsolute(entry) || entry.startsWith('.') || entry.includes('/') || entry.includes('\\');
    let plugin;
    if (isPath) {
      const directory = path.resolve(options.cwd || process.cwd(), entry);
      plugin = await loadPluginDirectory(directory, 'path');
    } else {
      plugin = byName.get(entry);
      const shipped = options.bundled?.[entry];
      if (!plugin && shipped) plugin = await loadPluginDirectory(shipped, 'bundled');
      if (!plugin) {
        throw new CosplayError({
          name: 'plugin',
          method: 'loadConfiguredPlugins',
          message: 'configured plugin %s is not installed. Run cosplaying plugin install <git-url-or-path> or change the plugins entry to an existing path.',
          args: [entry],
        });
      }
    }
    if (byCommand.has(plugin.command) && !selected.includes(plugin)) {
      throw new CosplayError({
        name: 'plugin',
        method: 'loadConfiguredPlugins',
        message: 'plugin command %s is declared by more than one plugin. Uninstall one plugin with cosplaying plugin uninstall <name>, or remove the duplicate from the plugins list.',
        args: [plugin.command],
      });
    }
    if (!selected.includes(plugin)) {
      byCommand.set(plugin.command, plugin);
      selected.push(plugin);
    }
  }
  return selected;
}

/**
 * Finds the real executable for a command that this CLI must not call again.
 *
 * `COSPLAYING_<COMMAND>_BIN` overrides `PATH` and must be an absolute path of a regular file. Candidates that resolve to this CLI or to Node are skipped. When every candidate is this process, the result is an error so the hook cannot recurse.
 *
 * @param {string} command Executable name, for example `git` or a harness binary.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] Environment. `PATH`, `PATHEXT`, and `COSPLAYING_<COMMAND>_BIN` are read.
 * @param {string[]} [options.cliPaths=[]] Absolute paths of this CLI and of Node. A candidate that resolves to one of these is skipped.
 * @returns {{bin?: string, error?: string}} `bin` is the executable to spawn. `error` is the text to show when no usable executable exists. Exactly one of the two is set.
 */
export function resolveRealBin(command, { env = process.env, cliPaths = [] } = {}) {
  const overrideName = `COSPLAYING_${command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_')}_BIN`;
  const override = env[overrideName];
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        error: new CosplayError({
          name: 'plugin',
          method: 'resolveRealBin',
          message: '%s must be an absolute path to the real %s executable. Set the override to an absolute path of a regular file, not a directory or a relative path.',
          args: [overrideName, command],
        }).message,
      };
    }
    try {
      if (!statSync(override).isFile()) {
        return {
          error: new CosplayError({
            name: 'plugin',
            method: 'resolveRealBin',
            message: '%s must be an absolute path to the real %s executable. Set the override to an absolute path of a regular file, not a directory or a relative path.',
            args: [overrideName, command],
          }).message,
        };
      }
    } catch {
      return {
        error: new CosplayError({
          name: 'plugin',
          method: 'resolveRealBin',
          message: '%s must be an absolute path to the real %s executable. Set the override to an absolute path of a regular file, not a directory or a relative path.',
          args: [overrideName, command],
        }).message,
      };
    }
    let real = override;
    try {
      real = realpathSync(override);
    } catch {
      real = override;
    }
    if (cliPaths.some((own) => own && (real === own || override === own))) {
      const token = command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_');
      return {
        error: new CosplayError({
          name: 'plugin',
          method: 'resolveRealBin',
          message: 'cosplaying found only its own executable for %s. Refusing to call it again. Install the real binary, or set COSPLAYING_%s_BIN to its absolute path.',
          args: [command, token],
        }).message,
      };
    }
    return { bin: override };
  }
  const found = which.sync(command, {
    path: env.PATH || '',
    pathExt: env.PATHEXT,
    nothrow: true,
    all: true,
  });
  const matches = found || [];
  const skipped = [];
  for (const candidate of matches) {
    let real;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (cliPaths.some((own) => own && real === own)) {
      skipped.push(real);
      continue;
    }
    return { bin: real };
  }
  if (skipped.length > 0) {
    return {
      error: new CosplayError({
        name: 'plugin',
        method: 'resolveRealBin',
        message: 'cosplaying found only its own executable for %s. Refusing to call it again. Install the real binary, or set COSPLAYING_%s_BIN to its absolute path.',
        args: [command, command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_')],
      }).message,
    };
  }
  return {
    error: new CosplayError({
      name: 'plugin',
      method: 'resolveRealBin',
      message: 'cosplaying could not find the real %s executable on PATH. Install it so it is on PATH, or set COSPLAYING_%s_BIN to its absolute path.',
      args: [command, command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_')],
    }).message,
  };
}

/**
 * Installs a plugin from a GitHub repository or a local directory.
 *
 * A GitHub `owner/repo` source uses `installFromGithub`. Any other source must be a directory that contains `package.json`, and that directory uses `installFromPath`. A second install of the same command is refused. Production dependencies that the manager cannot install are installed with npm. A failed dependency install removes the plugin that was just copied.
 *
 * @param {string} source GitHub `owner/repo`, a GitHub URL, or a local plugin directory.
 * @param {object} options Runtime context.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used for the data directory and npm.
 * @param {string} [options.cwd] Directory used to resolve a relative source and to tell a path from a repository.
 * @param {string} [options.home] Home directory used for the data directory.
 * @param {NodeJS.Platform} [options.platform] Accepted with the rest of the context. This function does not read it.
 * @returns {Promise<{ok: true, name: string, directory: string} | {ok: false, error: string}>} Success includes the command name and the installed directory. Failure includes the error text and does not throw.
 */
export async function installPlugin(source, options) {
  const repo = githubRepo(source);
  try {
    if (repo && !exists(path.resolve(options.cwd || process.cwd(), source))) {
      const manager = managerFor(options);
      const name = unscoped(repo.split('/')[1] || repo);
      if (RESERVED_COMMANDS.has(name)) {
        return {
          ok: false,
          error: new CosplayError({
            name: 'plugin',
            method: 'installPlugin',
            message: 'plugin command is reserved: %s. Rename the package. Reserved names are hook, agent-hook, rewrite, install, uninstall, doctor, and plugin.',
            args: [name],
          }).message,
        };
      }
      const present = matchingPlugins(pluginDataDirectory(options), name);
      if (present.length > 0) {
        return { ok: false, error: alreadyInstalledMessage(name, present[0].directory) };
      }
      if (manager.alreadyInstalled(name)) {
        const current = manager.list().find((info) => unscoped(info.name) === name);
        return { ok: false, error: alreadyInstalledMessage(name, current?.location || name) };
      }
      const info = await manager.installFromGithub(repo);
      try {
        installProductionDependencies(info.location);
      } catch (error) {
        try {
          await manager.uninstall(info.name);
        } catch {
          // The install error names the dependency that failed.
        }
        throw error;
      }
      const command = unscoped(info.name);
      const installed = matchingPlugins(pluginDataDirectory(options), command);
      if (installed.length > 1) {
        try {
          await manager.uninstall(info.name);
        } catch {
          // The refusal names the plugin that was already installed.
        }
        const previous = installed.find((item) => path.resolve(item.directory) !== path.resolve(info.location));
        return { ok: false, error: alreadyInstalledMessage(command, previous?.directory || command) };
      }
      return { ok: true, name: command, directory: info.location };
    }
    const directory = path.resolve(options.cwd || process.cwd(), source);
    if (!exists(directory) || !statSync(directory).isDirectory()) {
      return {
        ok: false,
        error: new CosplayError({
          name: 'plugin',
          method: 'installPlugin',
          message: '%s is not a plugin directory. Pass a directory that contains package.json, or a GitHub repository.',
          args: [source],
        }).message,
      };
    }
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    let resolved;
    try {
      resolved = resolvePluginEntry(directory, manifest);
    } catch (error) {
      return { ok: false, error: error instanceof CosplayError ? error.message : caughtInstallError(source, error) };
    }
    const name = resolved.name;
    if (RESERVED_COMMANDS.has(name)) {
      return {
        ok: false,
        error: new CosplayError({
          name: 'plugin',
          method: 'installPlugin',
          message: 'plugin command is reserved: %s. Rename the package. Reserved names are hook, agent-hook, rewrite, install, uninstall, doctor, and plugin.',
          args: [name],
        }).message,
      };
    }
    const present = matchingPlugins(pluginDataDirectory(options), name);
    if (present.length > 0) {
      return { ok: false, error: alreadyInstalledMessage(name, present[0].directory) };
    }
    const manager = managerFor(options, manifest);
    const info = await manager.installFromPath(directory);
    try {
      installProductionDependencies(info.location, directory);
    } catch (error) {
      try {
        await manager.uninstall(info.name);
      } catch {
        // The install error names the dependency that failed.
      }
      throw error;
    }
    return { ok: true, name: unscoped(info.name), directory: info.location };
  } catch (error) {
    return { ok: false, error: caughtInstallError(source, error) };
  }
}

/**
 * Removes one installed plugin by command name or package name.
 *
 * The name must select exactly one directory inside the plugin data directory. An absolute path or a `..` segment is refused. The manager is asked to uninstall that package.
 *
 * @param {string} name Command name or package name from `plugin list`.
 * @param {object} options Runtime context.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used to find the data directory.
 * @param {string} [options.home] Home directory used to find the data directory.
 * @param {NodeJS.Platform} [options.platform] Accepted with the rest of the context. This function does not read it.
 * @returns {Promise<{ok: true} | {ok: false, error: string}>} Success has no extra fields. Failure includes the error text and does not throw.
 */
export async function uninstallPlugin(name, options) {
  const root = pluginDataDirectory(options);
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    return {
      ok: false,
      error: new CosplayError({
        name: 'plugin',
        method: 'uninstallPlugin',
        message: 'plugin name %s is outside the data directory %s. Run cosplaying plugin list and pass one of those names.',
        args: [name, root],
      }).message,
    };
  }
  const matches = matchingPlugins(root, name);
  if (matches.length === 0) {
    return {
      ok: false,
      error: new CosplayError({
        name: 'plugin',
        method: 'uninstallPlugin',
        message: 'plugin %s is not installed. Run cosplaying plugin list and pass one of those names.',
        args: [name],
      }).message,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: new CosplayError({
        name: 'plugin',
        method: 'uninstallPlugin',
        message: 'plugin command %s is declared by more than one installed plugin. Run cosplaying plugin list, then cosplaying plugin uninstall with one scoped package name.',
        args: [name],
      }).message,
    };
  }
  const { directory, manifest } = matches[0];
  const packageName = manifest.name || name;
  try {
    const manager = managerFor(options, manifest);
    if (!manager.alreadyInstalled(packageName)) await manager.installFromPath(directory);
    await manager.uninstall(packageName);
  } catch (error) {
    return {
      ok: false,
      error: new CosplayError({
        name: 'plugin',
        method: 'uninstallPlugin',
        message: 'could not remove plugin %s: %s. Check permissions under the cosplaying data directory and run cosplaying plugin uninstall again.',
        args: [name, error.message],
      }).message,
    };
  }
  return { ok: true };
}

/**
 * Lists installed plugins without their imported descriptors.
 *
 * `plugin list` prints this. Shipped plugins that are enabled but not installed are added by the CLI, not by this function.
 *
 * @param {object} options Runtime context passed to {@link loadInstalledPlugins}.
 * @returns {Promise<Array<{name: string, command: string, kind: string, directory: string}>>} Installed plugins sorted by command name.
 */
export async function listPlugins(options) {
  const plugins = await loadInstalledPlugins(options);
  return plugins.map((plugin) => ({
    name: plugin.name,
    command: plugin.command,
    kind: plugin.kind,
    directory: plugin.directory,
  }));
}

/**
 * Builds the stderr line for a command that could not be spawned.
 *
 * The line names the executable and the `COSPLAYING_<COMMAND>_BIN` override so the operator can point at the real binary.
 *
 * @param {string} command Executable path that failed to start.
 * @param {unknown} error Spawn error. `message` is included in the line.
 * @returns {string} One line that ends with a newline.
 */
function launchErrorLine(command, error) {
  const bin = path.basename(command);
  const token = bin.toUpperCase().replace(/[^A-Za-z0-9]/g, '_');
  return `cosplaying: could not run ${bin}: ${error.message}. The command was not run. Set COSPLAYING_${token}_BIN to its executable path.\n`;
}

/**
 * Returns the stderr stream from a spawn stdio array, when the caller supplied one.
 *
 * A launch error is written there so a captured spawn still records the failure. Inherited stdio has no stream to return.
 *
 * @param {{stdio?: unknown}} options Spawn options. `stdio[2]` is used when it has a `write` method.
 * @returns {{write: (chunk: string) => unknown} | null} The stderr stream. Null when stdio is not an array or stderr is not a stream.
 */
function launchErrorStream(options) {
  if (Array.isArray(options.stdio)) {
    const target = options.stdio[2];
    if (target && typeof target.write === 'function') return target;
  }
  return null;
}

/**
 * Writes a launch failure to the spawn stderr, or to the process stderr.
 *
 * The wrapped command was not run. The message says that, so the agent does not treat a missing executable as a successful empty result.
 *
 * @param {string} command Executable path that failed to start.
 * @param {unknown} error Spawn error.
 * @param {object} options Spawn options. A stream at `stdio[2]` receives the line. Otherwise the process stderr is used.
 * @returns {void} No value.
 */
function reportLaunchError(command, error, options) {
  const line = launchErrorLine(command, error);
  const stream = launchErrorStream(options);
  if (stream) {
    stream.write(line);
    return;
  }
  process.stderr.write(line);
}

/**
 * Adapts a spawn target so Windows batch files can start.
 *
 * Node refuses a direct spawn of a `.bat` or `.cmd` file with `EINVAL`. `cmd.exe` runs those files. Each token uses the same Windows quoting as hook commands. Other platforms and other file types are returned unchanged.
 *
 * @param {string} command Executable path.
 * @param {string[]} args Arguments for that executable.
 * @returns {{command: string, args: string[], windowsVerbatimArguments?: boolean}} The command and arguments to pass to Node. `windowsVerbatimArguments` is set only for the `cmd.exe` form.
 */
function spawnCommand(command, args) {
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) return { command, args };
  const inner = [command, ...args].map((part) => quoteShell(String(part), 'win32')).join(' ');
  const root = process.env.SystemRoot || process.env.windir;
  const cmd = process.env.ComSpec || (root ? path.join(root, 'System32', 'cmd.exe') : 'cmd.exe');
  return {
    command: cmd,
    args: ['/d', '/s', '/c', `"${inner}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Spawns a command for a plugin and returns a `{ status }` result.
 *
 * Plugins depend on that shape. A captured call uses `spawnSync` when `encoding`, `input`, or a piped stdio entry is set. Otherwise the child is spawned and the returned promise resolves on exit. A launch error is status `127`, and the error text says the command was not run.
 *
 * @param {string} command Executable path.
 * @param {string[]} args Arguments. They are not parsed by a shell.
 * @param {import('node:child_process').SpawnOptions & {encoding?: BufferEncoding, input?: string | Buffer}} [options] Spawn options. `shell` is forced off.
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer> | Promise<{status: number, error?: Error}>} A synchronous result for a captured call. A promise for an inherited-stdio call. `status` is `127` when the process cannot be started.
 */
export function defaultSpawn(command, args, options = {}) {
  const target = spawnCommand(command, args);
  const verbatim = target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {};
  if (options.encoding || options.input !== undefined || (Array.isArray(options.stdio) && options.stdio.includes('pipe'))) {
    const result = spawnSync(target.command, target.args, { ...options, shell: false, ...verbatim });
    if (result.error) {
      reportLaunchError(command, result.error, options);
      if (!launchErrorStream(options) && typeof result.stderr === 'string') {
        result.stderr = launchErrorLine(command, result.error);
      }
      result.status = 127;
    }
    return result;
  }
  return new Promise((resolve) => {
    let settled = false;
    let child;
    /**
     * Resolves the async spawn once.
     *
     * Both the error event and the exit event can fire. The first result is the one the plugin sees.
     *
     * @param {{status: number, error?: Error}} result Status object in the spawnSync shape.
     * @returns {void} No value.
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(target.command, target.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: options.stdio || 'inherit',
        ...verbatim,
      });
    } catch (error) {
      reportLaunchError(command, error, options);
      finish({ status: 127, error });
      return;
    }
    child.on('error', (error) => {
      reportLaunchError(command, error, options);
      finish({ status: 127, error });
    });
    child.on('exit', (status) => finish({ status: status ?? 1 }));
  });
}

/**
 * Turns an install failure into the text `plugin install` prints.
 *
 * A `CosplayError` already has the operator action, so its message is used as-is. Any other error is wrapped with the data-directory hint.
 *
 * @param {string} source Install source that failed. It is included in the wrapped message.
 * @param {unknown} error Value thrown by the plugin manager or by the file system.
 * @returns {string} Error text for stderr. This function does not throw.
 */
function caughtInstallError(source, error) {
  if (error instanceof CosplayError) return error.message;
  return new CosplayError({
    name: 'plugin',
    method: 'installPlugin',
    message: 'could not install plugin files for %s: %s. Check that the cosplaying data directory is writable, then run cosplaying plugin install again.',
    args: [source, error.message],
    cause: error,
  }).message;
}

/**
 * Reports whether a path exists.
 *
 * A missing path and a path that cannot be stated are both absent. Callers use this before they read a manifest or skip an npm install.
 *
 * @param {string} file Path to test.
 * @returns {boolean} True when `stat` succeeds. False when it throws.
 */
function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
