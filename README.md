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

`doctor --repair` rewrites a stale Node path and moves an owned hook back to the end of the pre-tool list when `rtk hook` was appended later. After that repair, Codex must be trusted again. Codex pins trust to the hook hash, and `/hooks` is required again.

## Trust the hooks

Doctor does not claim that a harness has approved its hooks.

- Codex: run `/hooks` and trust the cosplaying hooks. Do this again after `doctor --repair` or any reinstall.
- Claude Code: approve the command hooks when Claude Code asks. Project hooks live in `.claude/settings.json`.
- Gemini CLI: approve the hooks when Gemini CLI asks. They are stored in `settings.json` under the Gemini config directory.

Cursor also loads Claude Code hooks after its own. Cursor cloud agents do not run user hooks. Install with `--project-dir` when a cloud agent should see the project hooks.

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
```

`--model` is plain text. `--model-base64` is base64url only. An empty value, a value that starts with `-`, or a value that is not base64url is an error and the wrapped command does not run. Do not guess which flag was intended.

When neither flag is set, `hook` uses `COSPLAYING_MODEL`, then the harness label if `--harness` is set, otherwise an empty model. An empty model does not stop the process. A plugin must refuse the write.

`--agent` is an alias of `--harness`.

## What the shell hook can see

The shell hook rewrites every invocation of a registered plugin command, including reads, `if` and `for`, substitutions, pipelines, `xargs`, and unquoted heredocs. It does not classify writes. The plugin decides.

The hook cannot see `bash -c "gh ..."`, `eval`, or commands inside script files. Those must call `cosplaying hook` explicitly.

`rtk <command>` is rewritten to `rtk proxy <prefix> <command>` unless `proxy` is already present. `rtk run "..."` is left unchanged because the command is inside a string.

## Configuration

`cosmiconfig` loads the files. Zod checks each file against the settings schema, and this package supplies the defaults. Later sources replace earlier ones. Variable keys are merged. A field of the wrong type fails the command.

The user file is `config.json`, `config.yaml`, or `config.yml` in `~/.config/cosplaying`. The project file is the nearest `.cosplaying.json`, `.cosplaying.yaml`, or `.cosplaying.yml`, walking up from the working directory until a `package.json`.

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

Environment overrides, in order: `COSPLAYING_ATTRIBUTION_TEMPLATE`, `COSPLAYING_ATTRIBUTION_TEMPLATE_MARKDOWN`, `COSPLAYING_ATTRIBUTION_TEMPLATE_TRAILER`, and `COSPLAYING_LINK`. `COSPLAYING_MODEL` is only the invocation fallback. It is not a config value.

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
```

`COSPLAYING_<COMMAND>_BIN` overrides PATH lookup when it is an absolute path to a file. `<COMMAND>` is the command token uppercased, with non-alphanumerics turned into `_`.

### Git history, when a plugin records commits

This package does not ship a Git plugin. A future plugin that creates commits should follow these rules.

- A git command that is not creating or publishing commits (for example `git status`) runs unchanged when no model is set, and the plugin returns the child status.
- A new commit uses `git commit --trailer` and `-c trailer.AI-Assisted-By.ifExists=replace`.
- Global options such as `-C` and `-c user.name` stay in front. `-c trailer.AI-Assisted-By.ifExists=replace` is inserted immediately before the `commit` subcommand.
- While replaying history that is already attributed, use `ifExists=addIfDifferent`.
- Do not rewrite a commit that has a `gpgsig` or `gpgsig-sha256` header. Do not rewrite a commit whose `encoding` header is not UTF-8.
- `merge`, `pull`, `cherry-pick`, `revert`, `am`, and `rebase` can create commits without a message argument. Record HEAD before and after. Attribute only commits that the command created. A fast-forward or a no-op is not an error.
- A plain `git pull` is treated as a rebase when `pull.rebase` or `branch.<name>.rebase` says so. `--rebase`, `--rebase=*`, and `-r` are rebase. `--no-rebase` and the values `false`, `no`, `off`, and `0` are not.
- Rebase commits come from the new HEAD reflog, not the original arguments. Skip `rebase: fast-forward` and non-commit rebase actions. An unrecognized reflog action, a missing reflog, or a reflog commit that is not reachable from HEAD blocks the command. Do not rewrite unrelated history.
- `git rebase --continue` after a conflict is attributed the same way as other rebase-created commits.
- When adding trailers to commits a command just created, update the ref with the current HEAD as the expected old value. If HEAD moved, stop. Do not rewrite unrelated history.
- If that repair fails after git has already created the commits, say the commits exist, attribution repair failed, and they must not be pushed.
- `push` is checked only when the invocation has a model. `COSPLAYING_ALLOW_UNATTRIBUTED=1` skips that check for one deliberately human publish. With no model, a human push is unchanged.
- Read the outgoing commits and the local committer email. If either read fails, block the push. Block only commits whose committer email matches the local committer and whose `AI-Assisted-By` value is empty. The reason lists the 12-character sha prefix and subject and names `COSPLAYING_ALLOW_UNATTRIBUTED=1`. The prefix applies to the refspecs being pushed, including `side:refs/heads/main`, not only the current upstream. Commits by other people are not blocked.

## Errors

User-facing failures throw `LayerError` from `@mcp-layer/error`. The message says what happened, the bad value or path, and the next action.

## Harnesses

Supported ids are `claude-code`, `codex`, `cursor`, `gemini`, `opencode`, and `pi`.

Owned JSON or shell hooks end with `# cosplaying:<harness>`. Pi and OpenCode files start with `// cosplaying:<harness>`. Install removes owned entries and appends new ones so ours stay last. Foreign keys are preserved. Uninstall removes owned hooks only. An unmanaged Pi or OpenCode file is not replaced or deleted.
