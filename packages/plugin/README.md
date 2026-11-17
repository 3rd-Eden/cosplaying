# @cosplaying/plugin

Private workspace package. Import it as `cosplaying/plugin`.

## What it does

Installs and loads Node packages with `live-plugin-manager`, and resolves the real binary a hook should spawn.

## Scope

In scope: reserved command names, `intercept === false`, the plugin data directory, and a mode `0600` temp copy of a UTF-8 source file.

`installPlugin` copies a local package with `installFromPath`, or installs `owner/repo` and `github.com` URLs with `installFromGithub`. Supply the package fields `name`, `version`, and `main` for installation. Directory loading uses the directory name if `name` is absent. It uses `index.js` if `main` is absent. A scoped package uses `plugins/@scope/<name>` in the plugin data directory.

The command is the package name without that scope. A second install is refused when that command already has a `package.json` under the data directory. `require` cannot load ESM, so installed packages are loaded with `import()` of `main`. `list()` only remembers the current process, so a later process reads those package directories, including `@scope/<name>`. `live-plugin-manager` installs registry and GitHub dependencies.

cosplaying uses npm for remaining production dependencies when the installed directory has no `node_modules`. This includes `file:` dependencies. For a local plugin, cosplaying resolves relative `file:` dependencies from the source directory.

The npm command is `npm install --ignore-scripts --omit=dev`. A package without production dependencies does not use this npm command.

This package does not render markdown or trailer wording. Shipped `git` and `gh` plugins are not installed by being present on disk. `@cosplaying/cli` passes their directories as `options.bundled`. A config name uses that directory when no installed plugin has the name.

## Public API

- `RESERVED_COMMANDS` is `hook`, `agent-hook`, `rewrite`, `install`, `uninstall`, `doctor`, and `plugin`.
- A plugin package `name`, without a scope, is the command. The default export is the function `hook` calls. `description`, `examples`, and `intercept` are optional named exports, or fields on a default object that has `run`. A name in `RESERVED_COMMANDS` is refused. `@cosplaying/cli` skips interception when `intercept` is `false`.
- `block(stderr, reason)` writes `cosplaying: BLOCKED (command not run)`, the reason, and the line that tells the caller to stop. It does not exit and does not return a status code.
- `withAttributedCopy(sourcePath, render, work)` reads `sourcePath` as bytes and rejects invalid UTF-8 before `render`. It calls `render(text)`, writes `os.tmpdir()/cosplaying-<pid>-<8 hex chars>` plus `path.extname(sourcePath)` at mode `0600`, awaits `work(copyPath)`, and deletes the copy. A source with no extension stays extensionless. `render` runs before the copy exists. The return value is the return value of `work`.
- `pluginDataDirectory({ env, home })` is `$XDG_DATA_HOME/cosplaying/plugins` when `XDG_DATA_HOME` is absolute, otherwise `~/.local/share/cosplaying/plugins`.
- `loadInstalledPlugins(options)` returns `{ name, command, kind, directory, entry, descriptor }` for each installed package, sorted by `command`. `kind` is `path`. `name` and `command` are the package name without a scope. Scope directories `plugins/@scope/<name>` are included.
- `loadConfiguredPlugins(entries, options)` returns every installed plugin, then each config entry that is not already in that list. An absolute path, a path starting with `.`, or a value containing `/` or `\` is a directory. Any other entry is an unscoped plugin command name. Relative paths start at `options.cwd` or the process working directory. When that name is not installed and `options.bundled[name]` is a directory, the shipped package is loaded with `kind` `bundled`.

  The map is not scanned on its own. A config name that is already installed stays once. A path whose `command` is already loaded throws, as does any other duplicate `command`.
- `resolveRealBin(command, { env, cliPaths })` returns `{ bin }` or `{ error }`. `COSPLAYING_<COMMAND>_BIN` wins when it is an absolute path to a regular file; the returned `bin` is that path. Any other override is an error, and `PATH` is not searched. Otherwise `which` walks `PATH` and returns the real path of the first file that is not in `cliPaths`. When the override or every `PATH` match is one of those paths, the error is the recursion error. When nothing matches, the error says the executable is missing.
- `installPlugin(source, options)` returns `{ ok: true, name, directory }` or `{ ok: false, error }`.
- `uninstallPlugin(name, options)` removes that package from the data directory. It returns `{ ok: true }` or `{ ok: false, error }`.
- `listPlugins(options)` returns `{ name, command, kind, directory }` for each installed plugin.
- `defaultSpawn(command, args, options)` starts a child process for a plugin. A call with `encoding`, `input`, or a `stdio` array that includes `'pipe'` returns the `spawnSync` result. Otherwise it returns a promise of `{ status }`. A launch failure returns `{ status: 127, error }` and writes an error message. The message identifies the executable override. Windows `.cmd` and `.bat` files use `cmd.exe`; other executables do not use a shell.

## Related packages

`@cosplaying/cli` calls these functions for `hook`, `plugin`, and `doctor`. A plugin function receives attribution helpers from `@cosplaying/attribution` and the settings `cosmiconfig` loaded over the defaults. Import and install failures throw or return `CosplayError`. `resolveRealBin` returns `{ error }`. `installPlugin` and `uninstallPlugin` return `{ ok: false, error }` for the failures they catch.
