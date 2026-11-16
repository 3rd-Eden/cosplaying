---
name: prefer-existing-packages
description: >-
  Sends cosplaying implementation to an existing npm package, and extends a
  package owned by the npm account 3rdeden (GitHub 3rd-Eden) only when the
  product cannot work without the missing behavior. A check this repo already
  has is not that behavior. Use when writing or changing code in the
  cosplaying repo, adding a dependency, or before hand-rolling a utility,
  wrapper, or local helper.
---

# Prefer existing packages

Do not maintain code that an existing package already implements. Generated code is training data and usually already exists as a package. A package in this repo should contain cosplaying business logic and defer implementation to dependencies.

## Dependencies

Search owned packages first. If one matches the job and lacks a piece the product cannot work without, name the package, name the missing piece, and treat updating that package as the path. Keeping a local helper is the temporary state until that update exists, not the chosen design.

If a package we own is the same job as code we would write, a missing feature is not a reason to reject it. We own these packages. Add the missing behavior to that package and depend on the updated version. Do not reimplement the gap in this repo.

A behavior this repo already has is not a missing feature. An earlier note that a package "lacks" something is not one either. Before you extend an owned package, or keep a local check, say why the product cannot work without that behavior. If you cannot, the behavior does not exist. Delete the local code and call the package as it is published. Do not add the behavior upstream to preserve the check.

`replaces` is the case. It fills `{name}` from the object you pass. A name with no value is a name with no value. There is no list of legal names, and a template does not have to contain `{model}`. The allowlist, the required `{model}` token, and the unknown-placeholder errors were invented here. Do not add them to `replaces` or put them back in this repo.

The same mistake is a type check on an optional field, or a package this repo wrote for a job a dependency already has. Config loading is `cosmiconfig`. This repo supplies the default byline, link, and plugin list. Attribution templates and the policy link come from the config file. Do not read `COSPLAYING_ATTRIBUTION_TEMPLATE`, `COSPLAYING_ATTRIBUTION_TEMPLATE_MARKDOWN`, `COSPLAYING_ATTRIBUTION_TEMPLATE_TRAILER`, or `COSPLAYING_LINK`. Do not keep a config package, a platform directory matrix, or a parent walk for settings. A template is text `replaces` fills. A plugin description and examples are help text. Do not reject a file, a template, or a plugin because a field has the wrong type, is empty, or contains NUL. Keep a check only when the product cannot work without it: an empty model would name nobody, a marker inside the template makes the next edit strip the wrong block, a line break in `AI-Assisted-By` is not a Git trailer, and a non-HTTP link is not a policy URL.

"We own" means the npm account `3rdeden` or GitHub `3rd-Eden`, including packages where 3rdeden is a maintainer and can publish an update (`@mcp-layer/error`, `@bento/error`, `argh`, `find-package-json`, `replaces`, `commenting`, `cli-storage`, `git-shizzle`, `pre-commit`, and the rest of that account).

Before writing a helper, search npm. Verify the package exists and does the job. Do not invent package names. If no owned package is the same job, use a well-known dependency, or keep a few lines when an unowned dependency would change locked behavior or does a different job.

Run this before adding a helper, wrapper, or dependency:

1. Name the job (walk, quote, write, hash, template fill, error class, parse, comment, store, git root, or something else).
2. Search the `3rdeden` account before the rest of npm.
3. If this repo does something the package does not, say why the product cannot work without it. If you cannot, stop. Use the package as published and delete the local behavior.
4. If that behavior must exist and an owned package is that job, name the package and the missing piece. Updating it is the path. A local copy is temporary.
5. If nothing we own does the job, depend on a package that does, or keep a few lines when the unowned package would change locked behavior.

Business rules stay in this repo even when an owned package does the mechanism: attribution wording, harness allow/deny JSON, shell rewrite policy, plugin rules a host does not know, Article 50 limits. The mechanism (walk, quote, write, hash, template fill, error class) moves upstream. Quote moves upstream only to a package we own. `shell-quote` is not ours and would change the locked spellings.

This audit is already done. Follow it. Do not decline an owned package because a feature is missing, and do not redo the search to reach the old rejection. Do not build a feature you cannot explain, including a feature this audit used to name.

### Owned packages: add the missing piece

- `@mcp-layer/error` / `@bento/error`: `@cosplaying/errors` exports `CosplayError`, which extends `LayerError` and sets `scope` `cosplaying` and `docs` `github.com/3rd-Eden/cosplay/tree/main/packages`. Throw `CosplayError`. Do not pass `scope` or `docs` at the throw. The message is the explanation. `@bento/error` must not grow a support-channel line for this product.
- `argh`: option parsing only. This CLI is `commander`: subcommands, help, version, and pass-through of the wrapped command. Do not keep a `parseArgs` command switch.
- `find-package-json`: walks parent directories for `package.json`. Config files are not its job. `cosmiconfig` searches those.
- `replaces`: fills `{name}` tags. Call `replaces(template, /\{()([^{}]+)\}/g, data)`. The first group is the modifier and the second is the key. Do not scan placeholder names or require `{model}` in this repo. `temper` compiles template files. `plates` binds data to markup and has no `{name}` syntax.
- `commenting`: comments. Missing the ownership token. Extend it if the token can be a mode, rather than a local comment builder. Strip-and-append order, and refusing to replace an unmarked Pi/OpenCode file, stay the hook-install behavior of this repo.
- `cli-storage`: encrypted key storage. Attribution files are plain text a person edits. Do not use it for those files.
- `git-shizzle`: git commands. Every command calls `shelljs.cd`, which changes the process working directory. Do not call it. The project root is `find-up` looking for `.git`.
- `pre-commit`: hook install. It only installs an npm-test git hook. Extending it to Claude, Cursor, Codex, Gemini, Pi, and OpenCode is a different product surface. Extend it only if the harness hook install belongs in that package; otherwise it is a different job, not a missing flag.

### Unowned packages

Packages we do not own (`shell-quote`, `env-paths`, `execa`, `write-file-atomic`, `unbash`) can still be skipped when they would change locked behavior or do a different job. `write-file-atomic` remains the right dependency for atomic writes. `unbash` stays. `cosmiconfig` loads settings.

- `write-file-atomic` covers the temp-file + mode 0600 + rename pattern duplicated in hooks `writeJsonAtomic` and cli `saveSessionModel`. Keep the local "skip write when unchanged" check and parent mkdir. `installHookFile` should use the same helper when that code is next touched.
- `live-plugin-manager` installs and removes Node packages. Call `installFromPath` for a directory and `installFromGithub` for `owner/repo`. `require` cannot load an ESM package, so import `main` with `import(pathToFileURL(mainFile).href)`. `list()` only remembers plugins installed in the current process, so a later process reads the package directories under the plugin data directory. A second `installFromPath` succeeds, so refuse a second install when that directory already contains `package.json`. Do not keep `definePlugin`, a `cosplaying` package.json key, `installed.json`, a symlink install, or `git clone`.
- `shell-quote` quotes `a b'c` as `"a b'c"`. `shell-escape` matches that apostrophe spelling but leaves tokens of letters, digits, `_`, `/`, and `-` unquoted, and it has no Windows mode. Installed hooks quote every token, including plain paths, and double quotes inside `cmd.exe` strings. Keep `quoteShell`.
- `markdown-escape` escapes `/`, `(`, and `)` and turns `<>` into HTML entities. The byline escapes `` \ ` * _ { } [ ] < > ! | ``. Keep that escape.
- `@mcp-layer/error` hashes with a sine color tag. Its own defaults point at the mcp-layer README and `@mcp-layer`. `CosplayError` extends the class so those defaults match this project.
- `cosmiconfig` loads the config files. Pass the defaults from this repo. Do not wrap it in a second loader.
- `env-paths` chooses directories from the real home. This process injects `home` in tests, so a session path is `path.join(home, '.config', 'cosplaying')`. Do not add a platform matrix beside that.
- `execa` throws and returns `exitCode`. `defaultSpawn` stays on `node:child_process` because plugins depend on a spawnSync-shaped `{ status }`.
- `tempy` / `tmp` only cover the path and cleanup. Keep the mode 0600 temp copy in `withAttributedCopy`.
- `which` walks `PATH`. Use it. Keep the `COSPLAYING_<CMD>_BIN` override and the refusal to call this CLI again.
- `collapse-white-space` trims and collapses whitespace in a model name. Call `collapseWhiteSpace(value || '', { trim: true })`. An empty value stays empty so the byline does not invent the words `undefined` or `null`.
- `graphql` parses one GraphQL mutation for the shipped `gh` plugin in `plugins/gh`. `git` and `gh` stay off until a config `plugins` entry or `cosplaying plugin enable` names them.

### Stays here

- Attribution wording: markers, HTTP(S) links, single-line `AI-Assisted-By` trailers, markdown escaping, refusing to invent a model. `{name}` substitution is `replaces`.
- Harness allow/deny JSON, event names, matchers, session prompt, and rtk-must-not-run-after-us.
- Shell rewrite policy: skip `env` / `sudo` / `rtk` prefixes, rewrite the executable word, replace a harness-label `--model` with `--model-base64` only when the active model is not itself a harness label.
- Plugin rules `live-plugin-manager` does not know: a plugin command must not shadow `hook`, `agent-hook`, `rewrite`, `install`, `uninstall`, `doctor`, or `plugin`; shell rewrite skips a plugin when `intercept` is false; the hook passes attribution helpers and the real binary into the plugin.
- Article 50 limits. The markdown block is a visible disclosure a deployer can use when EU AI Act Article 50(4) applies. This package does not decide whether a comment or commit is in scope. The `AI-Assisted-By` trailer is not an Article 50(2) machine-readable marking, and this project does not claim Article 50(2) compliance.
- Pi and OpenCode extension templates. They are standalone files written into the harness config and must not import this package. No published package generates them. The repeated runner is accepted duplication.
