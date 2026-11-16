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
import { LayerError } from '@mcp-layer/error';
import { PluginManager } from 'live-plugin-manager';

const errorScope = 'cosplaying';
const errorDocs = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/** @type {Set<string>} */
export const RESERVED_COMMANDS = new Set([
  'hook', 'agent-hook', 'rewrite', 'install', 'uninstall', 'doctor', 'plugin',
]);

/**
 * @param {NodeJS.WritableStream} stderr
 * @param {string} reason
 */
export function block(stderr, reason) {
  stderr.write(`cosplaying: BLOCKED (command not run)\nReason: ${reason}\nIf no safe correction is stated, stop and ask the user; do not bypass cosplaying.\n`);
}

/**
 * @param {string} sourcePath
 * @param {(text: string) => string} render
 * @param {(copyPath: string) => unknown} work
 */
export async function withAttributedCopy(sourcePath, render, work) {
  let bytes;
  try {
    bytes = readFileSync(sourcePath);
  } catch (error) {
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
      method: 'withAttributedCopy',
      message: 'could not read %s: %s. Check that the source file exists and is readable, then retry the command.',
      args: [sourcePath, error.message],
      cause: error,
    });
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
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
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
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
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {string}
 */
export function pluginDataDirectory({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, '.local', 'share');
  return path.join(base, 'cosplaying', 'plugins');
}

/**
 * @param {object | undefined} manifest
 * @returns {Record<string, unknown>}
 */
function productionDependencies(manifest) {
  if (!manifest || typeof manifest !== 'object') return {};
  return {
    ...(manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}),
    ...(manifest.optionalDependencies && typeof manifest.optionalDependencies === 'object' ? manifest.optionalDependencies : {}),
  };
}

/**
 * live-plugin-manager installs a version range from the npm registry and an
 * owner/repo spec from GitHub. A file: or URL spec is not either of those.
 * installFromPath treats a spec that contains "/" as a GitHub repository and
 * throws before it links the package, so the plugin never gets node_modules.
 * @param {unknown} spec
 * @returns {boolean}
 */
function livePluginManagerCannotInstall(spec) {
  if (typeof spec !== 'string' || spec === '') return true;
  if (/^(?:file|link|portal|workspace|git\+|github|http|https):/i.test(spec)) return true;
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\') || spec.startsWith('~');
}

/**
 * @param {object | undefined} manifest
 * @returns {RegExp[]}
 */
function unsupportedDependencyPatterns(manifest) {
  return Object.entries(productionDependencies(manifest))
    .filter(([, spec]) => livePluginManagerCannotInstall(spec))
    .map(([name]) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

/**
 * @param {string} spec
 * @returns {{absolute: boolean, pathname?: string} | null}
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
 * The installed tree is a copy, so a relative file: spec no longer points at
 * the author's package. Point it at the source tree before npm install.
 * @param {string} directory
 * @param {string} sourceDirectory
 */
function rewriteRelativeFileDependencies(directory, sourceDirectory) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let changed = false;
  for (const field of ['dependencies', 'optionalDependencies']) {
    const deps = manifest[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue;
      const target = fileDependencyTarget(spec);
      if (!target || target.absolute || !target.pathname) continue;
      deps[name] = `file:${path.resolve(sourceDirectory, target.pathname)}`;
      changed = true;
    }
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * @returns {string}
 */
function npmExecutable() {
  const found = which.sync('npm', {
    path: [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    nothrow: true,
  });
  return found || 'npm';
}

/**
 * live-plugin-manager already installs registry and GitHub dependencies.
 * This runs only when that left no node_modules and the package still has
 * production dependencies, which is the file: case it cannot install.
 * @param {string} directory
 * @param {string} [sourceDirectory]
 */
function installProductionDependencies(directory, sourceDirectory) {
  const manifestPath = path.join(directory, 'package.json');
  if (!exists(manifestPath) || exists(path.join(directory, 'node_modules'))) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (Object.keys(productionDependencies(manifest)).length === 0) return;
  if (sourceDirectory) rewriteRelativeFileDependencies(directory, sourceDirectory);
  const npm = npmExecutable();
  const result = spawnSync(npm, ['install', '--ignore-scripts', '--omit=dev'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim() || result.error?.message || 'npm install failed';
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
      method: 'installPlugin',
      message: 'could not install dependencies for %s: %s. Fix the dependency, then run cosplaying plugin install again.',
      args: [directory, detail],
      cause: result.error,
    });
  }
}

/**
 * @param {object} options
 * @param {object} [manifest]
 * @returns {PluginManager}
 */
function managerFor(options, manifest) {
  return new PluginManager({
    pluginsPath: pluginDataDirectory(options),
    cwd: options.cwd || process.cwd(),
    ignoredDependencies: [/^@types\//, ...unsupportedDependencyPatterns(manifest)],
  });
}

/**
 * @param {string} name
 * @returns {string}
 */
function unscoped(name) {
  return name.replace(/^@[^/]+\//, '');
}

const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * @param {string} name
 * @returns {LayerError}
 */
function commandNameError(name) {
  return new LayerError({
    name: 'plugin',
    scope: errorScope,
    docs: errorDocs,
    method: 'loadModule',
    message: 'plugin command %s must be a single token of letters, digits, underscores, and hyphens. Rename the package so the command matches that token.',
    args: [name],
  });
}

/**
 * @param {string} directory
 * @param {{name?: string, main?: string}} manifest
 * @returns {{name: string, mainFile: string}}
 */
function resolvePluginEntry(directory, manifest) {
  const name = unscoped(manifest.name || path.basename(directory));
  if (!COMMAND_PATTERN.test(name)) throw commandNameError(name);
  const mainField = manifest.main || 'index.js';
  const mainFile = path.resolve(directory, mainField);
  if (/\.(?:[cm]?ts|tsx)$/.test(mainFile)) {
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
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
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
      method: 'loadModule',
      message: 'plugin entry %s is outside %s. Set package.json main to a JavaScript file inside the plugin directory.',
      args: [real, root],
    });
  }
  return { name, mainFile: real };
}

/**
 * @param {string} source
 * @returns {string | null}
 */
function githubRepo(source) {
  const remote = source.match(/github\.com[:/]([^/]+)\/([^/#.]+)/);
  if (remote) return `${remote[1]}/${remote[2]}`;
  if (/^[^/\s]+\/[^/\s#]+/.test(source) && !source.startsWith('.')) return source.split('#')[0];
  return null;
}

/**
 * @param {string} mainFile
 * @param {string} name
 */
async function loadModule(mainFile, name) {
  if (RESERVED_COMMANDS.has(name)) {
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
      method: 'loadModule',
      message: 'plugin command is reserved: %s. Rename the package. Reserved names are hook, agent-hook, rewrite, install, uninstall, doctor, and plugin.',
      args: [name],
    });
  }
  let imported;
  try {
    imported = await import(pathToFileURL(mainFile).href);
  } catch (error) {
    throw new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
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
    description: typeof fields?.description === 'string' ? fields.description : '',
    examples: Array.isArray(fields?.examples) ? fields.examples : [],
    intercept: fields?.intercept,
  };
}

/**
 * Package directories under the plugin data directory.
 * `live-plugin-manager` links a scoped package at `plugins/@scope/<name>`.
 * `.versions` is its download cache and is not a plugin.
 * @param {string} root
 * @returns {string[]}
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
 * @param {string} root
 * @param {string} name
 * @returns {Array<{directory: string, manifest: {name?: string}, command: string}>}
 */
function matchingPlugins(root, name) {
  /** @type {Array<{directory: string, manifest: {name?: string}, command: string}>} */
  const matches = [];
  for (const directory of pluginPackageDirectories(root)) {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const packageName = typeof manifest.name === 'string' ? manifest.name : path.basename(directory);
    const command = unscoped(packageName);
    if (command === name || packageName === name) matches.push({ directory, manifest, command });
  }
  return matches;
}

/**
 * @param {string} name
 * @param {string} directory
 * @returns {string}
 */
function alreadyInstalledMessage(name, directory) {
  return new LayerError({
    name: 'plugin',
    scope: errorScope,
    docs: errorDocs,
    method: 'installPlugin',
    message: 'plugin %s is already installed at %s. Run cosplaying plugin uninstall %s first. Uninstall it, then install the plugin again.',
    args: [name, directory, name],
  }).message;
}

/**
 * @param {{env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform}} [options]
 * @returns {Promise<Array<{name: string, command: string, kind: string, directory: string, entry: string, descriptor: Record<string, unknown>}>>}
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
 * @param {string[]} entries
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform}} options
 */
export async function loadConfiguredPlugins(entries, options) {
  const installed = await loadInstalledPlugins(options);
  const byName = new Map(installed.map((plugin) => [plugin.name, plugin]));
  const byCommand = new Map();
  /** @type {typeof installed} */
  const selected = [];
  for (const plugin of installed) {
    if (byCommand.has(plugin.command)) {
      throw new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
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
      const file = path.join(directory, 'package.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const { name, mainFile } = resolvePluginEntry(directory, manifest);
      const descriptor = await loadModule(mainFile, name);
      plugin = {
        name,
        command: name,
        kind: 'path',
        directory,
        entry: mainFile,
        descriptor,
      };
    } else {
      plugin = byName.get(entry);
      if (!plugin) {
        throw new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
          method: 'loadConfiguredPlugins',
          message: 'configured plugin %s is not installed. Run cosplaying plugin install <git-url-or-path> or change the plugins entry to an existing path.',
          args: [entry],
        });
      }
    }
    if (byCommand.has(plugin.command) && !selected.includes(plugin)) {
      throw new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
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
 * @param {string} command
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, cliPaths?: string[]}} options
 * @returns {{bin?: string, error?: string}}
 */
export function resolveRealBin(command, { env = process.env, cliPaths = [] } = {}) {
  const overrideName = `COSPLAYING_${command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_')}_BIN`;
  const override = env[overrideName];
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        error: new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
          method: 'resolveRealBin',
          message: '%s must be an absolute path to the real %s executable. Set the override to an absolute path of a regular file, not a directory or a relative path.',
          args: [overrideName, command],
        }).message,
      };
    }
    try {
      if (!statSync(override).isFile()) {
        return {
          error: new LayerError({
            name: 'plugin',
            scope: errorScope,
            docs: errorDocs,
            method: 'resolveRealBin',
            message: '%s must be an absolute path to the real %s executable. Set the override to an absolute path of a regular file, not a directory or a relative path.',
            args: [overrideName, command],
          }).message,
        };
      }
    } catch {
      return {
        error: new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
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
        error: new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
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
      error: new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
        method: 'resolveRealBin',
        message: 'cosplaying found only its own executable for %s. Refusing to call it again. Install the real binary, or set COSPLAYING_%s_BIN to its absolute path.',
        args: [command, command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_')],
      }).message,
    };
  }
  return {
    error: new LayerError({
      name: 'plugin',
      scope: errorScope,
      docs: errorDocs,
      method: 'resolveRealBin',
      message: 'cosplaying could not find the real %s executable on PATH. Install it so it is on PATH, or set COSPLAYING_%s_BIN to its absolute path.',
      args: [command, command.toUpperCase().replace(/[^A-Za-z0-9]/g, '_')],
    }).message,
  };
}

/**
 * @param {string} source
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, home?: string, platform?: NodeJS.Platform, spawnImpl?: Function}} options
 * @returns {Promise<{ok: true, name: string, directory: string} | {ok: false, error: string}>}
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
          error: new LayerError({
            name: 'plugin',
            scope: errorScope,
            docs: errorDocs,
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
        error: new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
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
      return { ok: false, error: error instanceof LayerError ? error.message : caughtInstallError(source, error) };
    }
    const name = resolved.name;
    if (!name) {
      return {
        ok: false,
        error: new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
          method: 'installPlugin',
          message: 'plugin package.json at %s could not be read: %s. Add a package.json with name, version, and main.',
          args: [path.join(directory, 'package.json'), 'missing name'],
        }).message,
      };
    }
    if (RESERVED_COMMANDS.has(name)) {
      return {
        ok: false,
        error: new LayerError({
          name: 'plugin',
          scope: errorScope,
          docs: errorDocs,
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
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform}} options
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export async function uninstallPlugin(name, options) {
  const root = pluginDataDirectory(options);
  if (typeof name !== 'string' || name === '' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    return {
      ok: false,
      error: new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
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
      error: new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
        method: 'uninstallPlugin',
        message: 'plugin %s is not installed. Run cosplaying plugin list and pass one of those names.',
        args: [name],
      }).message,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
        method: 'uninstallPlugin',
        message: 'plugin command %s is declared by more than one installed plugin. Run cosplaying plugin list, then cosplaying plugin uninstall with one scoped package name.',
        args: [name],
      }).message,
    };
  }
  const { directory, manifest } = matches[0];
  const packageName = typeof manifest.name === 'string' ? manifest.name : name;
  try {
    const manager = managerFor(options, manifest);
    if (!manager.alreadyInstalled(packageName)) await manager.installFromPath(directory);
    await manager.uninstall(packageName);
  } catch (error) {
    return {
      ok: false,
      error: new LayerError({
        name: 'plugin',
        scope: errorScope,
        docs: errorDocs,
        method: 'uninstallPlugin',
        message: 'could not remove plugin %s: %s. Check permissions under the cosplaying data directory and run cosplaying plugin uninstall again.',
        args: [name, error.message],
      }).message,
    };
  }
  return { ok: true };
}

/**
 * @param {object} options
 * @returns {Promise<Array<{name: string, command: string, kind: string, directory: string}>>}
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
 * @param {string} command
 * @param {unknown} error
 * @returns {string}
 */
function launchErrorLine(command, error) {
  const bin = path.basename(command);
  const token = bin.toUpperCase().replace(/[^A-Za-z0-9]/g, '_');
  return `cosplaying: could not run ${bin}: ${error.message}. The command was not run. Set COSPLAYING_${token}_BIN to its executable path.\n`;
}

/**
 * @param {{stderr?: {write?: (chunk: string) => unknown}, stdio?: unknown}} options
 * @returns {{write: (chunk: string) => unknown} | null}
 */
function launchErrorStream(options) {
  if (options.stderr && typeof options.stderr.write === 'function') return options.stderr;
  if (Array.isArray(options.stdio)) {
    const target = options.stdio[2];
    if (target && typeof target.write === 'function') return target;
  }
  return null;
}

/**
 * @param {string} command
 * @param {unknown} error
 * @param {object} options
 * @param {boolean} always
 */
function reportLaunchError(command, error, options, always) {
  const line = launchErrorLine(command, error);
  const stream = launchErrorStream(options);
  if (stream) {
    stream.write(line);
    return;
  }
  if (always) process.stderr.write(line);
}

/**
 * @param {object} options
 * @returns {object}
 */
function spawnSyncOptions(options) {
  const rest = { ...options, shell: false };
  delete rest.stderr;
  return rest;
}

/**
 * Default spawn used by plugins. Tests pass spawnImpl instead.
 * A launch error returns status 127 and reports the command was not run.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions & {encoding?: BufferEncoding, input?: string, stderr?: {write?: (chunk: string) => unknown}}} [options]
 */
export function defaultSpawn(command, args, options = {}) {
  if (options.encoding || options.input !== undefined || (Array.isArray(options.stdio) && options.stdio.includes('pipe'))) {
    const result = spawnSync(command, args, spawnSyncOptions(options));
    if (result.error) {
      reportLaunchError(command, result.error, options, true);
      if (!launchErrorStream(options) && typeof result.stderr === 'string') {
        result.stderr = launchErrorLine(command, result.error);
      }
      result.status = 127;
    }
    return result;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.stdio || 'inherit',
    });
    child.on('error', (error) => {
      reportLaunchError(command, error, options, true);
      finish({ status: 127, error });
    });
    child.on('exit', (status) => finish({ status: status ?? 1 }));
  });
}

/**
 * @param {string} source
 * @param {unknown} error
 * @returns {string}
 */
function caughtInstallError(source, error) {
  if (error instanceof LayerError) return error.message;
  return new LayerError({
    name: 'plugin',
    scope: errorScope,
    docs: errorDocs,
    method: 'installPlugin',
    message: 'could not install plugin files for %s: %s. Check that the cosplaying data directory is writable, then run cosplaying plugin install again.',
    args: [source, error.message],
    cause: error,
  }).message;
}

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
