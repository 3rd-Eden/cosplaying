# Errors

Runtime errors for cosplaying. Each thrown message names what happened, the bad value, and the remedy, then links to an anchor in this file.

The anchor is `error-` plus the first 8 hex characters of SHA-256 over the component name, method, and message template, joined by NUL. Values filled into `%s` are not part of that id.

## Runtime Error Reference

<a id="error-57fc4c80"></a>
### attribution template must not contain cosplaying marker comments. Remove <!-- cosplaying:attribution --> and <!-- /cosplaying:attribution --> from the template. The renderer adds those markers.

Thrown from: `annotateMarkdown`

Catalog id: `attribution.template-marker`

`attribution(annotateMarkdown)`

The markers are how a later edit finds and replaces the managed block. A template that already contains them cannot be stripped reliably.

Step-by-step resolution:
1. Remove <!-- cosplaying:attribution --> and <!-- /cosplaying:attribution --> from the template. The renderer adds those markers.

<details>
<summary>Example</summary>

```js
{
  "attribution": { "templates": { "markdown": "Authored by {model}." } }
}
```

</details>

<a id="error-7e45b24c"></a>
### attribution link must be an absolute HTTP or HTTPS URL, for example https://example.com/ai-policy. Replace the link with an absolute http:// or https:// URL.

Thrown from: `validateLink`

Catalog id: `attribution.link-url`

`attribution(validateLink)`

Relative paths, javascript: URLs, and other schemes are not a stable public policy link.

Step-by-step resolution:
1. Replace the link with an absolute http:// or https:// URL.

<details>
<summary>Example</summary>

```js
{
  "link": "https://example.com/ai-policy"
}
```

</details>

<a id="error-271a33d5"></a>
### attribution identity is required for text writes. Pass --model <name> or set COSPLAYING_MODEL. Do not guess the model. Run the command as cosplaying hook --model <name> -- <command>, or export COSPLAYING_MODEL.

Thrown from: `annotateMarkdown`

Catalog id: `attribution.model-text`

`attribution(annotateMarkdown)`

A text write without a model would publish a byline that names nobody.

Step-by-step resolution:
1. Run the command as cosplaying hook --model <name> -- <command>, or export COSPLAYING_MODEL.

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example Model" -- notify --message "text"
```

</details>

<a id="error-ee440782"></a>
### attribution identity is required for commits. Pass --model <name> or set COSPLAYING_MODEL. Do not guess the model. Run the command as cosplaying hook --model <name> -- <command>, or export COSPLAYING_MODEL.

Thrown from: `renderTrailer`

Catalog id: `attribution.model-commit`

`attribution(renderTrailer)`

A commit trailer without a model cannot tell a later reader who produced the text.

Step-by-step resolution:
1. Run the command as cosplaying hook --model <name> -- <command>, or export COSPLAYING_MODEL.

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example Model" -- notify --message "text"
```

</details>

<a id="error-0af94051"></a>
### rendered trailer attribution must be a single line. Remove line breaks from variables used in the trailer template.

Thrown from: `renderTrailer`

Catalog id: `attribution.trailer-value-line`

`attribution(renderTrailer)`

A variable can turn a one-line template into several lines. Git would then store a broken trailer.

Step-by-step resolution:
1. Remove line breaks from variables used in the trailer template.

<details>
<summary>Example</summary>

```js
{
  "variables": { "team": "Docs" }
}
```

</details>

<a id="error-2448a93a"></a>
### plugin command is reserved: %s. Rename the package. Reserved names are hook, agent-hook, rewrite, install, uninstall, doctor, and plugin.

Thrown from: `installPlugin`

Catalog id: `plugin.reserved`

`plugin(installPlugin)`

Those names are the cosplaying CLI. A plugin with the same name would hide them.

Step-by-step resolution:
1. Rename the package. Reserved names are hook, agent-hook, rewrite, install, uninstall, doctor, and plugin.

<details>
<summary>Example</summary>

```js
{
  "name": "notify"
}
```

</details>

<a id="error-34575155"></a>
### plugin package.json at %s could not be read: %s. Add a package.json with name, version, and main.

Thrown from: `installPlugin`

Catalog id: `plugin.manifest-read`

`plugin(installPlugin)`

live-plugin-manager installs a package. A missing name cannot be installed.

Step-by-step resolution:
1. Add a package.json with name, version, and main.

<details>
<summary>Example</summary>

```js
{
  "name": "notify",
  "version": "1.0.0",
  "type": "module",
  "main": "./index.js"
}
```

</details>

<a id="error-fa3f1ff1"></a>
### plugin command %s is declared by more than one plugin. Uninstall one plugin with cosplaying plugin uninstall <name>, or remove the duplicate from the plugins list.

Thrown from: `loadPlugins`

Catalog id: `plugin.duplicate-command`

`plugin(loadPlugins)`

Two plugins cannot both own the same argv0. The hook exits before a write so neither runs half-attributed.

Step-by-step resolution:
1. Uninstall one plugin with cosplaying plugin uninstall <name>, or remove the duplicate from the plugins list.

<details>
<summary>Example</summary>

```js
cosplaying plugin uninstall other-notify
```

</details>

<a id="error-ccea3102"></a>
### configured plugin %s is not installed. Run cosplaying plugin install <git-url-or-path> or change the plugins entry to an existing path.

Thrown from: `loadPlugins`

Catalog id: `plugin.not-installed`

`plugin(loadPlugins)`

A name in config is looked up in the user plugin directory. A missing install cannot be executed.

Step-by-step resolution:
1. Run cosplaying plugin install <git-url-or-path> or change the plugins entry to an existing path.

<details>
<summary>Example</summary>

```js
cosplaying plugin install ./examples/notify
```

</details>

<a id="error-f9bb36bc"></a>
### %s must be an absolute path to the real %s executable. Set the override to an absolute path of a regular file, not a directory or a relative path.

Thrown from: `resolveRealBin`

Catalog id: `plugin.bin-override`

`plugin(resolveRealBin)`

The override replaces PATH lookup. A relative path would depend on whichever directory the agent used.

Step-by-step resolution:
1. Set the override to an absolute path of a regular file, not a directory or a relative path.

<details>
<summary>Example</summary>

```js
export COSPLAYING_NOTIFY_BIN=/usr/local/bin/notify
```

</details>

<a id="error-97b71b90"></a>
### cosplaying found only its own executable for %s. Refusing to call it again. Install the real binary, or set COSPLAYING_%s_BIN to its absolute path.

Thrown from: `resolveRealBin`

Catalog id: `plugin.bin-recursion`

`plugin(resolveRealBin)`

Calling the cosplaying shim again would loop. The real program has to be a different file.

Step-by-step resolution:
1. Install the real %s binary, or set COSPLAYING_%s_BIN to its absolute path.

<details>
<summary>Example</summary>

```js
export COSPLAYING_NOTIFY_BIN=/usr/local/bin/notify
```

</details>

<a id="error-6d822223"></a>
### cosplaying could not find the real %s executable on PATH. Install it so it is on PATH, or set COSPLAYING_%s_BIN to its absolute path.

Thrown from: `resolveRealBin`

Catalog id: `plugin.bin-missing`

`plugin(resolveRealBin)`

A write cannot be attributed if the underlying program cannot be found.

Step-by-step resolution:
1. Install %s so it is on PATH, or set COSPLAYING_%s_BIN to its absolute path.

<details>
<summary>Example</summary>

```js
export COSPLAYING_NOTIFY_BIN=/usr/local/bin/notify
```

</details>

<a id="error-8f8838a3"></a>
### %s is not a plugin directory. Pass a directory that contains package.json, or a GitHub repository.

Thrown from: `installPlugin`

Catalog id: `plugin.not-directory`

`plugin(installPlugin)`

Install copies a package directory. A file path has no package.json.

Step-by-step resolution:
1. Pass a directory that contains package.json, or a GitHub repository.

<details>
<summary>Example</summary>

```js
cosplaying plugin install ./examples/notify
```

</details>

<a id="error-56419801"></a>
### plugin %s is already installed at %s. Run cosplaying plugin uninstall %s and then install the plugin again.

Thrown from: `installPlugin`

Catalog id: `plugin.already-installed`

`plugin(installPlugin)`

Replacing an existing directory could delete a different checkout. Uninstall is explicit.

Step-by-step resolution:
1. Run cosplaying plugin uninstall %s and then install the plugin again.

<details>
<summary>Example</summary>

```js
cosplaying plugin uninstall notify
```

</details>

<a id="error-21735621"></a>
### plugin %s is not installed. Run cosplaying plugin list and pass one of those names.

Thrown from: `uninstallPlugin`

Catalog id: `plugin.uninstall-missing`

`plugin(uninstallPlugin)`

Uninstall only removes a package directory under the cosplaying data directory.

Step-by-step resolution:
1. Run cosplaying plugin list and pass one of those names.

<details>
<summary>Example</summary>

```js
cosplaying plugin list
```

</details>

<a id="error-05719256"></a>
### invalid config %s: file is not valid UTF-8. Replace the file with UTF-8 JSON, or move it aside and run cosplaying install again.

Thrown from: `readJsonConfig`

Catalog id: `hooks.utf8`

`hooks(readJsonConfig)`

Hook files are JSON text. Binary contents are not rewritten in place.

Step-by-step resolution:
1. Replace the file with UTF-8 JSON, or move it aside and run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-4228d27a"></a>
### invalid config %s: %s. Fix the JSON syntax, or move the file aside and run cosplaying install again.

Thrown from: `readJsonConfig`

Catalog id: `hooks.json`

`hooks(readJsonConfig)`

An invalid hook file is reported and not overwritten, so a hand edit is not destroyed.

Step-by-step resolution:
1. Fix the JSON syntax, or move the file aside and run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install --harness claude-code
```

</details>

<a id="error-4b420f78"></a>
### invalid config %s: config must contain a top-level object. Replace the file with a JSON object, or move it aside and run cosplaying install again.

Thrown from: `readJsonConfig`

Catalog id: `hooks.json-root`

`hooks(readJsonConfig)`

Hook entries live under a hooks object. An array root has nowhere to put them.

Step-by-step resolution:
1. Replace the file with a JSON object, or move it aside and run cosplaying install again.

<details>
<summary>Example</summary>

```js
{
  "hooks": {}
}
```

</details>

<a id="error-f315d96f"></a>
### hooks must be an object. Set hooks to an object of event arrays, or delete hooks and run cosplaying install again.

Thrown from: `reconcileHooks`

Catalog id: `hooks.hooks-object`

`hooks(reconcileHooks)`

Each event name maps to an array of hook entries. A string or array cannot be updated in place.

Step-by-step resolution:
1. Set hooks to an object of event arrays, or delete hooks and run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-938bc0e7"></a>
### hooks.%s must be an array. Set that event to an array of hook objects, or delete it and run cosplaying install again.

Thrown from: `reconcileHooks`

Catalog id: `hooks.hooks-event`

`hooks(reconcileHooks)`

Owned entries are removed and appended. A non-array event cannot be edited without dropping foreign data.

Step-by-step resolution:
1. Set that event to an array of hook objects, or delete it and run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-5fac2742"></a>
### refusing to replace unmanaged hook file %s. Move the file aside or add the cosplaying marker comment, then run cosplaying install again.

Thrown from: `installHookFile`

Catalog id: `hooks.unmanaged`

`hooks(installHookFile)`

Pi and OpenCode extensions are whole files. A file without the marker is someone else's extension.

Step-by-step resolution:
1. Move the file aside or add the cosplaying marker comment, then run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install --harness pi
```

</details>

<a id="error-7f6fff01"></a>
### unknown command %s. Run cosplaying --help and use hook, agent-hook, rewrite, install, uninstall, doctor, or plugin.

Thrown from: `main`

Catalog id: `cli.unknown-command`

`cli(main)`

The first argument selects a built-in command. Plugin commands are run through hook.

Step-by-step resolution:
1. Run cosplaying --help and use hook, agent-hook, rewrite, install, uninstall, doctor, or plugin.

<details>
<summary>Example</summary>

```js
cosplaying --help
```

</details>

<a id="error-588b436b"></a>
### unknown harness %s. Supported harnesses: %s. Run cosplaying install --harness <name> with one of those harness names.

Thrown from: `install`

Catalog id: `cli.unknown-harness`

`cli(install)`

Each harness has its own hook file. An unknown id would write nothing useful.

Step-by-step resolution:
1. Run cosplaying install --harness <name> with one of those harness names.

<details>
<summary>Example</summary>

```js
cosplaying install --harness claude-code
```

</details>

<a id="error-1ba0c1a3"></a>
### cosplaying hook: expected a command. Run cosplaying hook --model <name> -- <command> [args].

Thrown from: `hook`

Catalog id: `cli.hook-command`

`cli(hook)`

hook wraps one plugin command. With no command there is nothing to attribute.

Step-by-step resolution:
1. Run cosplaying hook --model <name> -- <command> [args].

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example" -- notify --message "text"
```

</details>

<a id="error-1cf26633"></a>
### --model-base64 must be base64url. Pass the model as plain text with --model <name>. Hooks pass --model-base64 for you when typing the command.

Thrown from: `resolveModel`

Catalog id: `cli.model-base64`

`cli(resolveModel)`

Standard base64 can contain +, /, and = which break unquoted shell text. Only base64url is accepted, and it is not guessed from plain text.

Step-by-step resolution:
1. Pass the model as plain text with --model <name>. Hooks pass --model-base64 for you.

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example Model" -- notify --message "text"
```

</details>

<a id="error-5715598d"></a>
### --model-base64 did not contain a model name. Encode a non-empty model with base64url, or pass --model <name>.

Thrown from: `resolveModel`

Catalog id: `cli.model-base64-empty`

`cli(resolveModel)`

An empty decode is not a model. The write would have no identity to print.

Step-by-step resolution:
1. Encode a non-empty model with base64url, or pass --model <name>.

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example Model" -- notify --message "text"
```

</details>

<a id="error-66a7df18"></a>
### --model requires the model name as plain text. Run cosplaying hook --model <name> -- <command>. Do not leave the value empty or starting with a dash.

Thrown from: `resolveModel`

Catalog id: `cli.model-plain`

`cli(resolveModel)`

A missing value would be read as the next flag. The model is never inferred from the flag name.

Step-by-step resolution:
1. Run cosplaying hook --model <name> -- <command>. Do not leave the value empty or starting with a dash.

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example Model" -- notify --message "text"
```

</details>

<a id="error-ab0332c7"></a>
### no plugin is installed for %s. Install it with cosplaying plugin install <git-url-or-path>, or add its path to the plugins list.

Thrown from: `hook`

Catalog id: `cli.no-plugin`

`cli(hook)`

hook only runs commands exported by installed or enabled plugins. Shipped `git` and `gh` use `cosplaying plugin enable`. Other commands use `cosplaying plugin install`.

Step-by-step resolution:
1. Install it with cosplaying plugin install <git-url-or-path>, or add its path to the plugins list.

<details>
<summary>Example</summary>

```js
cosplaying plugin install ./examples/notify
```

</details>

<a id="error-d5a71f98"></a>
### cosplaying rewrite: expected a command. Run cosplaying rewrite --shell '<command>' or cosplaying rewrite <command> [args].

Thrown from: `rewrite`

Catalog id: `cli.rewrite-command`

`cli(rewrite)`

rewrite prints the shell text it would hand back to the harness. It needs a command to parse.

Step-by-step resolution:
1. Run cosplaying rewrite --shell '<command>' or cosplaying rewrite <command> [args].

<details>
<summary>Example</summary>

```js
cosplaying rewrite --shell 'notify --list'
```

</details>

<a id="error-88dc9f77"></a>
### %s requires a value. Repeat the command and pass a value immediately after that flag.

Thrown from: `rewrite`

Catalog id: `cli.flag-value`

`cli(rewrite)`

A flag without a value would consume the next token or be stored as empty.

Step-by-step resolution:
1. Repeat the command and pass a value immediately after that flag.

<details>
<summary>Example</summary>

```js
cosplaying rewrite --model "Example Model" notify --list
```

</details>

<a id="error-07e13a29"></a>
### settings file %s does not match the config schema: %s. Edit that file so link, plugins, variables, and attribution.templates match the documented shape, or delete the file to use the defaults.

Thrown from: `loadConfig`

Catalog id: `cli.config`

`cli(loadConfig)`

Settings are one object. A field of the wrong type is not merged into the defaults.

Step-by-step resolution:
1. Edit that file so link, plugins, variables, and attribution.templates match the documented shape, or delete the file to use the defaults.

<details>
<summary>Example</summary>

```js
{
  "plugins": ["notify"],
  "link": "https://example.com/ai-policy"
}
```

</details>

<a id="error-4aad26af"></a>
### unexpected argument %s. Run cosplaying --help and remove the extra argument.

Thrown from: `main`

Catalog id: `cli.unexpected-arg`

`cli(main)`

install, uninstall, and doctor take flags, not positional command names.

Step-by-step resolution:
1. Run cosplaying --help and remove the extra argument.

<details>
<summary>Example</summary>

```js
cosplaying install --harness cursor
```

</details>

<a id="error-c07c2397"></a>
### cosplaying plugin install: expected a git URL or local path. Run cosplaying plugin install <git-url-or-path>.

Thrown from: `plugin`

Catalog id: `cli.plugin-install-usage`

`cli(plugin)`

Install needs a source. There is no default plugin.

Step-by-step resolution:
1. Run cosplaying plugin install <git-url-or-path>.

<details>
<summary>Example</summary>

```js
cosplaying plugin install ./examples/notify
```

</details>

<a id="error-0eaa4a40"></a>
### cosplaying plugin uninstall: expected a plugin name. Run cosplaying plugin list, then cosplaying plugin uninstall <name>.

Thrown from: `plugin`

Catalog id: `cli.plugin-uninstall-usage`

`cli(plugin)`

The name is the directory under the cosplaying data directory, not a command flag.

Step-by-step resolution:
1. Run cosplaying plugin list, then cosplaying plugin uninstall <name>.

<details>
<summary>Example</summary>

```js
cosplaying plugin list
```

</details>

<a id="error-3d7b9676"></a>
### cosplaying plugin: expected install, uninstall, list, enable, or disable. Run cosplaying plugin install, cosplaying plugin uninstall <name>, cosplaying plugin list, cosplaying plugin enable <name>, or cosplaying plugin disable <name>.

Thrown from: `plugin`

Catalog id: `cli.plugin-usage`

`cli(plugin)`

plugin is a command group. Other words are not subcommands.

Step-by-step resolution:
1. Run cosplaying plugin install, cosplaying plugin uninstall <name>, cosplaying plugin list, cosplaying plugin enable <name>, or cosplaying plugin disable <name>.

<details>
<summary>Example</summary>

```js
cosplaying plugin list
```

</details>

<a id="error-2900021c"></a>
### shipped plugin %s is off. Run cosplaying plugin enable %s, or add "%s" to the plugins list.

Thrown from: `hook`

Catalog id: `cli.shipped-plugin-off`

`cli(hook)`

`git` and `gh` ship with the package and stay off until named.

Step-by-step resolution:
1. Run cosplaying plugin enable git or cosplaying plugin enable gh, or add the name to the plugins list.

<details>
<summary>Example</summary>

```js
cosplaying plugin enable git
```

</details>

<a id="error-e7665342"></a>
### cosplaying plugin enable: expected a shipped plugin name. Run cosplaying plugin enable git or cosplaying plugin enable gh.

Thrown from: `plugin`

Catalog id: `cli.plugin-enable-usage`

`cli(plugin)`

Enable names a shipped plugin. It does not install a third-party package.

Step-by-step resolution:
1. Run cosplaying plugin enable git or cosplaying plugin enable gh.

<details>
<summary>Example</summary>

```js
cosplaying plugin enable gh
```

</details>

<a id="error-ecf47ff6"></a>
### cosplaying plugin disable: expected a shipped plugin name. Run cosplaying plugin disable git or cosplaying plugin disable gh.

Thrown from: `plugin`

Catalog id: `cli.plugin-disable-usage`

`cli(plugin)`

Disable removes a shipped name from the user JSON settings file.

Step-by-step resolution:
1. Run cosplaying plugin disable git or cosplaying plugin disable gh.

<details>
<summary>Example</summary>

```js
cosplaying plugin disable git
```

</details>

<a id="error-0da0c515"></a>
### %s is not a shipped plugin. Shipped plugins are git and gh. Run cosplaying plugin enable git or cosplaying plugin enable gh.

Thrown from: `plugin`

Catalog id: `cli.plugin-not-shipped`

`cli(plugin)`

Enable and disable accept the shipped names only. Other plugins use install and uninstall.

Step-by-step resolution:
1. Run cosplaying plugin enable git or cosplaying plugin enable gh.

<details>
<summary>Example</summary>

```js
cosplaying plugin enable git
```

</details>

<a id="error-f37e2df3"></a>
### plugin %s is already installed at %s. Run cosplaying plugin uninstall %s first.

Thrown from: `plugin`

Catalog id: `cli.plugin-enable-installed`

`cli(plugin)`

An installed copy of the same command is the one hook runs. Enable does not replace it.

Step-by-step resolution:
1. Run cosplaying plugin uninstall git, or the installed name, then cosplaying plugin enable git.

<details>
<summary>Example</summary>

```js
cosplaying plugin uninstall git
```

</details>

<a id="error-c4803d83"></a>
### plugin %s is enabled in %s. Remove "%s" from the plugins list in that file.

Thrown from: `plugin`

Catalog id: `cli.plugin-enabled-elsewhere`

`cli(plugin)`

Disable edits the user `.cosplaying` file. A project `.cosplaying` file that still names the plugin has to be edited in that file.

Step-by-step resolution:
1. Remove "git" or "gh" from the plugins list in that file.

<details>
<summary>Example</summary>

```json
{ "plugins": [] }
```

</details>

<a id="error-a857ddec"></a>
### could not enable plugin %s: %s. Fix the user settings file and run cosplaying plugin enable again.

Thrown from: `plugin`

Catalog id: `cli.plugin-enable-failed`

`cli(plugin)`

The user settings file could not be updated.

Step-by-step resolution:
1. Fix the user settings file and run cosplaying plugin enable again.

<details>
<summary>Example</summary>

```js
cosplaying plugin enable git
```

</details>

<a id="error-e5941c01"></a>
### could not disable plugin %s: %s. Fix the user settings file and run cosplaying plugin disable again.

Thrown from: `plugin`

Catalog id: `cli.plugin-disable-failed`

`cli(plugin)`

The user settings file could not be updated.

Step-by-step resolution:
1. Fix the user settings file and run cosplaying plugin disable again.

<details>
<summary>Example</summary>

```js
cosplaying plugin disable git
```

</details>

<a id="error-b90290b2"></a>
### invalid hook input: %s. The calling agent must send one JSON hook payload on stdin. Call agent-hook with a single JSON object on stdin. This command is for harness hooks, not for typed commands.

Thrown from: `agent-hook`

Catalog id: `cli.invalid-hook`

`cli(agent-hook)`

The hook process reads one payload and exits. Empty, truncated, or non-object input is not a shell command.

Step-by-step resolution:
1. Call agent-hook with a single JSON object on stdin. This command is for harness hooks, not for typed commands.

<details>
<summary>Example</summary>

```js
cosplaying agent-hook claude-code PreToolUse <<'JSON'
{"tool_name":"Bash","tool_input":{"command":"echo hi"}}
JSON
```

</details>

<a id="error-1557a4e6"></a>
### could not parse arguments: %s. Run cosplaying --help and fix the flags. String flags need a value.

Thrown from: `main`

Catalog id: `cli.invalid-args`

`cli(main)`

The argument parser rejected the argv before a command ran.

Step-by-step resolution:
1. Run cosplaying --help and fix the flags. String flags need a value.

<details>
<summary>Example</summary>

```js
cosplaying --help
```

</details>

<a id="error-35d6dde3"></a>
### Hook order %s. This command was not run. Retry the command through cosplaying. If the hook file changed, trust Codex hooks again with /hooks.

Thrown from: `repairHookOrder`

Catalog id: `cli.hook-order`

`cli(repairHookOrder)`

A pre-tool hook that rewrites the shell must run after other rewriters. The in-flight command is denied so the agent retries against the repaired order.

Step-by-step resolution:
1. Retry the command through cosplaying. If the hook file changed, trust Codex hooks again with /hooks.

<details>
<summary>Example</summary>

```js
cosplaying doctor --repair
```

</details>

<a id="error-803fa2bd"></a>
### Hook order could not be verified%s. Inspect those hook files and run cosplaying doctor --repair. Wrapped commands stay denied until the order can be checked.

Thrown from: `repairHookOrder`

Catalog id: `cli.hook-order-warning`

`cli(repairHookOrder)`

An unreadable file or a lookalike hook is not rewritten automatically. The session is told that writes will be blocked.

Step-by-step resolution:
1. Inspect those hook files and run cosplaying doctor --repair. Wrapped commands stay denied until the order can be checked.

<details>
<summary>Example</summary>

```js
cosplaying doctor --repair
```

</details>

<a id="error-70994cf5"></a>
### missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.

Thrown from: `inspectHooks`

Catalog id: `doctor.missing-hook`

`doctor(inspectHooks)`

Doctor expects the owned hook in each managed file it was asked to check. A missing entry means the harness can bypass attribution.

Step-by-step resolution:
1. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-8308c9d0"></a>
### hook file %s does not match the current Node path or plugin commands. Run cosplaying doctor --repair to regenerate that Pi or OpenCode extension.

Thrown from: `inspectExtension`

Catalog id: `doctor.extension-drift`

`doctor(inspectExtension)`

The extension embeds the Node executable and the intercepted command list. A stale file would fail closed or skip new plugins.

Step-by-step resolution:
1. Run cosplaying doctor --repair to regenerate that Pi or OpenCode extension.

<details>
<summary>Example</summary>

```js
cosplaying doctor --repair
```

</details>

<a id="error-4f10b484"></a>
### invalid config %s: %s. Fix the JSON, or move the file aside and run cosplaying install again.

Thrown from: `inspectHooks`

Catalog id: `doctor.invalid-json`

`doctor(inspectHooks)`

Doctor does not overwrite a file it cannot parse.

Step-by-step resolution:
1. Fix the JSON, or move the file aside and run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install --harness claude-code
```

</details>

<a id="error-7d767f70"></a>
### %s: could not parse hook command: %s. Run cosplaying install to rewrite the owned hook. Do not hand-edit the command string.

Thrown from: `inspectCommand`

Catalog id: `doctor.command-parse`

`doctor(inspectCommand)`

The command is parsed as shell syntax. If it cannot be parsed, doctor cannot prove it still calls this CLI.

Step-by-step resolution:
1. Run cosplaying install to rewrite the owned hook. Do not hand-edit the command string.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-f5b680ea"></a>
### %s: hook command must be a direct invocation. Run cosplaying install so the owned hook is one command with no pipes, lists, or redirects.

Thrown from: `inspectCommand`

Catalog id: `doctor.command-direct`

`doctor(inspectCommand)`

A compound command could run something else before or after the hook. Doctor only accepts a direct invocation.

Step-by-step resolution:
1. Run cosplaying install so the owned hook is one command with no pipes, lists, or redirects.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-902701a5"></a>
### %s: hook command must invoke agent-hook %s <event>. Run cosplaying install to rewrite the hook as node, the main script, agent-hook, the harness id, and the event.

Thrown from: `inspectCommand`

Catalog id: `doctor.command-shape`

`doctor(inspectCommand)`

The executable, optional script, and agent-hook arguments are how doctor knows which install is running.

Step-by-step resolution:
1. Run cosplaying install to rewrite the hook as node, the main script, agent-hook, the harness id, and the event.

<details>
<summary>Example</summary>

```js
cosplaying install --harness claude-code
```

</details>

<a id="error-0194f1d4"></a>
### %s: hook command has unexpected arguments. Run cosplaying install to drop the extra arguments from the owned hook.

Thrown from: `inspectCommand`

Catalog id: `doctor.command-args`

`doctor(inspectCommand)`

Extra words could change which event is handled or pass the model flag in the wrong place.

Step-by-step resolution:
1. Run cosplaying install to drop the extra arguments from the owned hook.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-af5e4ef6"></a>
### %s: unexpected executable %s. Run cosplaying install so the hook starts with node and this package's main.js, or with the cosplaying executable.

Thrown from: `inspectCommand`

Catalog id: `doctor.unexpected-executable`

`doctor(inspectCommand)`

An unrecognized executable is not repaired, because it may not be our hook.

Step-by-step resolution:
1. Run cosplaying install so the hook starts with node and this package's main.js, or with the cosplaying executable.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-08cccdb0"></a>
### %s: hook executable does not exist: %s. Run cosplaying doctor --repair to reinstall the hook with the current Node executable.

Thrown from: `inspectCommand`

Catalog id: `doctor.missing-executable`

`doctor(inspectCommand)`

An absolute node path from an old install will not start. Repair rewrites hooks that still have our marker.

Step-by-step resolution:
1. Run cosplaying doctor --repair to reinstall the hook with the current Node executable.

<details>
<summary>Example</summary>

```js
cosplaying doctor --repair
```

</details>

<a id="error-df44a482"></a>
### %s: hook script does not exist: %s. Run cosplaying install so the hook points at this package's main.js.

Thrown from: `inspectCommand`

Catalog id: `doctor.missing-script`

`doctor(inspectCommand)`

The script path is the file Node runs. A missing file means the hook cannot start.

Step-by-step resolution:
1. Run cosplaying install so the hook points at this package's main.js.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-e4fc30e5"></a>
### %s: hook script is a different cosplaying install. Run cosplaying install from the install you want the harness to use.

Thrown from: `inspectCommand`

Catalog id: `doctor.different-install`

`doctor(inspectCommand)`

Two checkouts would attribute with different code. Doctor compares the real script path with the one running doctor.

Step-by-step resolution:
1. Run cosplaying install from the install you want the harness to use.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-2a1f0551"></a>
### %s: hook --version did not match %s. Run cosplaying install so the hook uses this package version.

Thrown from: `inspectCommand`

Catalog id: `doctor.version`

`doctor(inspectCommand)`

A version mismatch means the harness is running a different build than the doctor you just invoked.

Step-by-step resolution:
1. Run cosplaying install so the hook uses this package version.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-7e16d7ed"></a>
### %s: hook --help failed. Run the hook executable with --help, fix the error it prints, then run cosplaying doctor again.

Thrown from: `inspectCommand`

Catalog id: `doctor.help-failed`

`doctor(inspectCommand)`

Help is how doctor checks that plugin commands are visible to the model.

Step-by-step resolution:
1. Run the hook executable with --help, fix the error it prints, then run cosplaying doctor again.

<details>
<summary>Example</summary>

```js
cosplaying --help
```

</details>

<a id="error-67913434"></a>
### %s: hook --help is missing %s. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.

Thrown from: `inspectCommand`

Catalog id: `doctor.help-missing`

`doctor(inspectCommand)`

The model learns wrapped commands from help text. A missing line means the command is not advertised.

Step-by-step resolution:
1. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.

<details>
<summary>Example</summary>

```js
cosplaying --help
```

</details>

<a id="error-c1f7ffc5"></a>
### unverified cosplaying hook in %s. Remove that entry or run cosplaying install so the owned hook contains its # cosplaying:<harness> marker. This process will not rewrite a lookalike command.

Thrown from: `repairHookOrder`

Catalog id: `harness.unverified-hook`

`harness(repairHookOrder)`

A later command that resembles our hook but lacks the marker might be a different install. It is reported and left unchanged.

Step-by-step resolution:
1. Remove that entry or run cosplaying install so the owned hook contains its # cosplaying:<harness> marker. This process will not rewrite a lookalike command.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-698daf7e"></a>
### rtk hook runs after cosplaying in %s. Run cosplaying doctor --repair so the cosplaying hook is last, then retry the command. In Codex, trust the hooks again with /hooks.

Thrown from: `repairHookOrder`

Catalog id: `harness.rtk-order`

`harness(repairHookOrder)`

rtk rewrites the shell after our hook would remove the attribution prefix. Our hook has to be the last pre-tool command.

Step-by-step resolution:
1. Run cosplaying doctor --repair so the cosplaying hook is last, then retry the command. In Codex, trust the hooks again with /hooks.

<details>
<summary>Example</summary>

```js
cosplaying doctor --repair
```

</details>

<a id="error-bc3c5fa9"></a>
### could not read hook input: %s. Run this command from the harness so it can write one JSON object to stdin.

Thrown from: `readStdin`

Catalog id: `cli.stdin`

`cli(readStdin)`

agent-hook reads stdin until EOF. A read error is not an empty payload and is not a shell command.

Step-by-step resolution:
1. Run this command from the harness so it can write one JSON object to stdin.

<details>
<summary>Example</summary>

```js
cosplaying agent-hook claude-code PreToolUse
```

</details>

<a id="error-4de5132e"></a>
### could not store the session model in %s: %s. Make the cosplaying config directory writable, then start the agent session again.

Thrown from: `saveSessionModel`

Catalog id: `cli.session-write`

`cli(saveSessionModel)`

Claude Code tool hooks often omit the model. The session file is how a later tool hook names the model that wrote the text.

Step-by-step resolution:
1. Make the cosplaying config directory writable, then start the agent session again.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-5b4de3f7"></a>
### could not read the package version from %s: %s. Reinstall cosplaying. The package.json for this install is missing or unreadable.

Thrown from: `packageVersion`

Catalog id: `cli.version`

`cli(packageVersion)`

doctor compares hook --version with this package. A missing version means the install is incomplete.

Step-by-step resolution:
1. Reinstall cosplaying. The package.json for this install is missing or unreadable.

<details>
<summary>Example</summary>

```js
npm install -g cosplaying
```

</details>

<a id="error-9998ee77"></a>
### could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.

Thrown from: `readHookFile`

Catalog id: `hooks.read`

`hooks(readHookFile)`

Install does not overwrite a hook file it could not read, because the existing contents are unknown.

Step-by-step resolution:
1. Fix the permissions on that file, or move it aside and run cosplaying install again.

<details>
<summary>Example</summary>

```js
chmod u+r ~/.claude/settings.json
```

</details>

<a id="error-99c83eca"></a>
### could not write %s: %s. Make the parent directory writable and run cosplaying install again.

Thrown from: `writeHookFile`

Catalog id: `hooks.write`

`hooks(writeHookFile)`

Hook text is written beside the destination and renamed into place. A failed write leaves the previous file unchanged.

Step-by-step resolution:
1. Make the parent directory writable and run cosplaying install again.

<details>
<summary>Example</summary>

```js
cosplaying install
```

</details>

<a id="error-49f9a422"></a>
### could not read %s: %s. Check that the source file exists and is readable, then retry the command.

Thrown from: `withAttributedCopy`

Catalog id: `plugin.copy-read`

`plugin(withAttributedCopy)`

The attributed copy is made from that file. An unreadable source cannot be sent.

Step-by-step resolution:
1. Check that the source file exists and is readable, then retry the command.

<details>
<summary>Example</summary>

```js
notify --message-file note.md
```

</details>

<a id="error-969a01ba"></a>
### could not write the attributed copy %s: %s. Free space in the temporary directory and retry the command. The original file was not changed.

Thrown from: `withAttributedCopy`

Catalog id: `plugin.copy-write`

`plugin(withAttributedCopy)`

The plugin sends a copy so the caller file stays unchanged. The copy has to exist before the command runs.

Step-by-step resolution:
1. Free space in the temporary directory and retry the command. The original file was not changed.

<details>
<summary>Example</summary>

```js
notify --message-file note.md
```

</details>

<a id="error-fc2056ba"></a>
### could not import plugin %s: %s. Fix the plugin entry so Node can import it, then run the command again. The underlying CLI was not run.

Thrown from: `loadModule`

Catalog id: `plugin.import`

`plugin(loadModule)`

A plugin that fails to load must not fall through to the real binary, or the write would have no byline.

Step-by-step resolution:
1. Fix the plugin entry so Node can import it, then run the command again. The underlying CLI was not run.

<details>
<summary>Example</summary>

```js
cosplaying plugin install ./examples/notify
```

</details>

<a id="error-97fdec63"></a>
### could not install plugin files for %s: %s. Check that the cosplaying data directory is writable, then run cosplaying plugin install again.

Thrown from: `installPlugin`

Catalog id: `plugin.install-io`

`plugin(installPlugin)`

Install copies the package into the data directory. A failed write is not a successful install.

Step-by-step resolution:
1. Check that the cosplaying data directory is writable, then run cosplaying plugin install again.

<details>
<summary>Example</summary>

```js
cosplaying plugin install ./examples/notify
```

</details>

<a id="error-dc6fad05"></a>
### could not remove plugin %s: %s. Check permissions under the cosplaying data directory and run cosplaying plugin uninstall again.

Thrown from: `uninstallPlugin`

Catalog id: `plugin.uninstall-io`

`plugin(uninstallPlugin)`

Uninstall removes the package directory inside the data directory.

Step-by-step resolution:
1. Check permissions under the cosplaying data directory and run cosplaying plugin uninstall again.

<details>
<summary>Example</summary>

```js
cosplaying plugin uninstall notify
```

</details>

<a id="error-7dcfabfe"></a>
### refusing to write %s because it is a symlink. Do not follow the symlink. Replace the file with a regular file and retry.

Thrown from: `writeTextAtomic`

Catalog id: `hooks.symlink`

`hooks(writeTextAtomic)`

write-file-atomic resolves the destination and renames onto that real path. Following the link would overwrite a different file.

Step-by-step resolution:
1. Do not follow the symlink. Replace the file with a regular file and retry.

<details>
<summary>Example</summary>

```js
rm /path/to/settings.json
cosplaying install
```

</details>

<a id="error-400b6a2b"></a>
### %s is after the command. Put hook flags before the command, then --, then the command. Run cosplaying hook --model <name> -- <command>. Do not place --model, --model-base64, or --harness after the command name.

Thrown from: `hook`

Catalog id: `cli.hook-flag-position`

`cli(hook)`

hook does not guess whether a later flag belongs to the hook or to the wrapped command. A hook flag after the command name is in the wrong place.

Step-by-step resolution:
1. Run cosplaying hook --model <name> -- <command>. Do not place --model, --model-base64, or --harness after the command name.

<details>
<summary>Example</summary>

```js
cosplaying hook --model "Example" -- notify --message "text"
```

</details>

<a id="error-302c2422"></a>
### %s is not a directory. Create the directory, or pass --project-dir a path that exists and is a directory.

Thrown from: `runDoctor`

Catalog id: `cli.project-dir`

`cli(runDoctor)`

Doctor checks hook files inside that directory. A missing path is not a missing hook.

Step-by-step resolution:
1. Create the directory, or pass --project-dir a path that exists and is a directory.

<details>
<summary>Example</summary>

```js
cosplaying doctor --project-dir .
```

</details>

<a id="error-e40288dd"></a>
### missing managed %s hook in %s. Run cosplaying install for that harness so the missing event is written.

Thrown from: `inspectHooks`

Catalog id: `doctor.missing-event`

`doctor(inspectHooks)`

A managed file that omits an event lets the harness skip attribution for that event.

Step-by-step resolution:
1. Run cosplaying install for that harness so the missing event is written.

<details>
<summary>Example</summary>

```js
cosplaying install --harness claude-code
```

</details>

<a id="error-894eb680"></a>
### PATH: version %s differs from %s. Update the cosplaying executable on PATH so it matches this install.

Thrown from: `inspectPath`

Catalog id: `doctor.path-version`

`doctor(inspectPath)`

A different version on PATH means a later shell command and the hook can disagree about attribution.

Step-by-step resolution:
1. Update the cosplaying executable on PATH so it matches this install.

<details>
<summary>Example</summary>

```js
cosplaying --version
```

</details>
