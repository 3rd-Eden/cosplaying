# cosplaying

`cosplaying` adds a visible byline when a coding agent publishes text through a wrapped CLI. The byline names the model and points at a link you choose. It is a label a person can read. It does not prove who typed the text, and it is not a cryptographic watermark.

The markdown block is a visible disclosure a deployer can use when EU AI Act Article 50(4) applies. This package does not decide whether a particular comment or commit is in scope. The `AI-Assisted-By` trailer is a structured line Git can store. It is not a provider's Article 50(2) machine-readable marking solution, and this project does not claim Article 50(2) compliance.

Replacing the templates does not remove the attribution markers. The renderer still adds `<!-- cosplaying:attribution -->` and `<!-- /cosplaying:attribution -->`.

## Install

Install the package, install the hooks, trust them in each harness that asks, then run doctor.

```sh
npm install -g cosplaying
cosplaying install
cosplaying doctor
```

`cosplaying install` writes the user-scope hook files even when the harness binary is not on `PATH`. A missing harness binary is information from doctor, not a failure. A missing owned hook in a managed file is a failure.

Start a new agent session after install. A session that was already open does not see the new hooks or the session prompt.

`--project-dir <path>` writes the project hook file instead of the user file:

```sh
cosplaying install --project-dir /path/to/repo
cosplaying doctor --project-dir /path/to/repo
```

`doctor --repair` rewrites a stale Node path and moves an owned hook back to the end of the pre-tool list when `rtk hook` was appended later. That later entry removes the `cosplaying hook` prefix. After that repair, Codex must be trusted again. Codex pins trust to the hook hash, and `/hooks` is required again.

## Trust the hooks

Doctor does not claim that a harness has approved its hooks. Users open `/hooks` and trust the command. After `--repair` changes the command, Codex must be trusted again because trust is pinned to the hook hash. Note that approval is separate and that a new agent session is required after install.

- Codex: run `/hooks` and trust the cosplaying hooks. Do this again after `doctor --repair` or any reinstall.
- Claude Code: approve the command hooks when Claude Code asks. Project hooks live in `.claude/settings.json`.
- Gemini CLI: approve the hooks when Gemini CLI asks. They are stored in `settings.json` under the Gemini config directory.

Cursor also loads Claude Code hooks after its own. Cursor cloud agents do not run user hooks. Install with `--project-dir` when a cloud agent should see the project hooks. This hook does not run for Cursor cloud agents. Project install is how a repo covers cloud agents.

## Commands

```sh
cosplaying hook [--model <plain text>] [--model-base64 <base64url>] [--harness <name>] -- <command> [args]
cosplaying agent-hook <harness> <event>
cosplaying rewrite [--shell] <command text>
cosplaying install [--harness <name>] [--project-dir <path>]
cosplaying uninstall [--harness <name>] [--project-dir <path>]
cosplaying doctor [--project-dir <path>] [--repair]
cosplaying plugin install <git-url-or-local-path>
cosplaying plugin uninstall <name>
cosplaying plugin list
cosplaying plugin enable <git|gh>
cosplaying plugin disable <git|gh>
```

`--model` is plain text. `--model-base64` is base64url only. An empty value, a value that starts with `-`, or a value that is not base64url is an error and the wrapped command does not run. Do not guess which flag was intended.

When neither flag is set, `hook` uses `COSPLAYING_MODEL`, then the harness label if `--harness` is set, otherwise an empty model. An empty model does not stop the process. A plugin must refuse the write.

`--agent` is an alias of `--harness`.

## What the shell hook can see

The shell hook rewrites every invocation of a registered plugin command, including reads, `if` and `for`, substitutions, pipelines, `xargs`, and unquoted heredocs. It does not classify writes. The plugin decides.

The hook cannot see `bash -c "gh ..."`, `eval`, or commands inside script files. Those must call `cosplaying hook` explicitly.

`rtk <command>` is rewritten to `rtk proxy <prefix> <command>` unless `proxy` is already present. `rtk run "..."` is left unchanged because the command is inside a string. `rtk` accepts arbitrary commands only through `rtk proxy`, and `rtk` itself removes a bare `rtk <command>` rewrite. This package does not run `rtk` and does not undo that deletion.

## Configuration

`cosmiconfig` loads the files. Zod checks each file against the settings schema, and this package supplies the defaults. Later sources replace earlier ones. Variable keys are merged. A field of the wrong type fails the command.

The user file is `.cosplaying.json`, `.cosplaying.yaml`, or `.cosplaying.yml` in `~/.config/cosplaying`. The project file is the nearest file with those same names, walking up from the working directory until a `package.json`.

Pass `--model` or set `COSPLAYING_MODEL` for the invocation. A `model` or `attribution.model` field is an error. Remove it from the file.

Two of `.cosplaying.json`, `.cosplaying.yaml`, and `.cosplaying.yml` in the same directory is an error. Attribution stays blocked until that directory has one of those files.

```json
{
  "link": "https://example.com/ai-policy",
  "plugins": ["notify"],
  "variables": { "team": "Docs" },
  "attribution": {
    "templates": {
      "markdown": "Authored by {model} for {team}. [policy]({link})",
      "trailer": "{model} via cosplaying ({link}).",
      "session": "You are running in {harness}. Prefix {commands} with {executable} hook --model <current model id> --."
    }
  }
}
```

The default markdown line is `Authored by {model} via [cosplaying]({link}). AI Assisted text may contain mistakes, please verify.` The default trailer value is `{model} via cosplaying ({link}). AI Assisted text may contain mistakes, please verify.` The default link is `https://www.npmjs.com/package/cosplaying`.

Session text tells the model to write authored text in ASD-STE100 Simplified Technical English and to route supported plugin commands through this CLI.

## Plugins

A plugin is a Node package. `live-plugin-manager` installs it. The package `name` is the command. The default export is the function `hook` calls. `description`, `examples`, and `intercept` are optional named exports. `intercept` defaults to true. `false` means the shell hook does not rewrite that command; `hook` can still run it by name.

```json
{
  "name": "notify",
  "version": "1.0.0",
  "type": "module",
  "main": "./index.js"
}
```

```js
export const description = 'Append a byline to notify --message';

export default async function run(args, context) {
  return 0;
}
```

`context` includes `model`, `harness`, `cwd`, `env`, `realBin`, `spawn`, and `attribution.annotateMarkdown` / `attribution.renderTrailer`. Pass `context.env` to child processes. `hook` sets `COSPLAYING_INSIDE_HOOK=1` so a nested hook of the same command runs the real binary and does not attribute twice.

Writes copy the body to a temp file, or a new pipe, and delete it afterward. Do not mutate the caller's source file. If the model is empty, do not spawn the write. Say that `--model` or `COSPLAYING_MODEL` is required. If a template throws, do not spawn.

`context.block` is not required. `block` from `cosplaying/plugin` writes:

```text
cosplaying: BLOCKED (command not run)
Reason: <reason>
If no safe correction is stated, stop and ask the user; do not bypass cosplaying.
```

The reason should say which input is accepted. Return exit code 2 and do not suggest the raw CLI as a bypass.

Install from a git URL or a local path:

```sh
cosplaying plugin install ./examples/notify
cosplaying plugin list
cosplaying plugin uninstall notify
cosplaying plugin enable git
cosplaying plugin enable gh
```

`git` and `gh` ship in `plugins/` and stay off until `plugin enable` or a `plugins` entry names them. `cosplaying install` does not turn them on. Commit, rebase, push, and GitHub write rules are in `plugins/git` and `plugins/gh`.

`COSPLAYING_<COMMAND>_BIN` overrides PATH lookup when it is an absolute path to a file. `<COMMAND>` is the command token uppercased, with non-alphanumerics turned into `_`.

## Errors

[Error catalog](docs/errors.md).

## Harnesses

Supported ids are `claude-code`, `codex`, `cursor`, `gemini`, `opencode`, and `pi`.

Owned JSON or shell hooks end with `# cosplaying:<harness>`. Pi and OpenCode files start with `// cosplaying:<harness>`. Install removes owned entries and appends new ones so ours stay last. Foreign keys are preserved. Uninstall removes owned hooks only. An unmanaged Pi or OpenCode file is not replaced or deleted.
