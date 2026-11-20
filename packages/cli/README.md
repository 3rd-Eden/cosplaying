# CLI and JavaScript entry point

The CLI reads cosplaying settings, loads plugins, and passes commands to them. It also installs coding-agent hooks and answers the events they send. For the terminal setup, see [Install cosplaying](../../README.md#install-cosplaying).

## Run the CLI from JavaScript

The default export is available from both `cosplaying` and `cosplaying/cli`. Pass an argument array to run a specific command. The function returns a promise for the exit code.

```js
import cosplaying from 'cosplaying';

const status = await cosplaying({}, ['--help']);
console.log(status); // 0
```

To make your own CLI, set `options.entrypoint` to the script path or file URL, such as `import.meta.url`. Leave out the argument array to read the process arguments. Set `options.defaults` to supply company settings. The installed hooks and rewritten commands run the wrapper through Node.js. [Company CLI example](../../README.md#distribute-a-company-cli)

You can also supply `cwd`, `home`, `env`, `platform`, `stdin`, `stdout`, and `stderr` in `options`. The lower-level export `main(argv, options)` takes the argument array first. The installed bin calls `main`.

## Follow a command through cosplaying

1. On session start, `agent-hook` reads the agent event and uses the adapter to return the session prompt. An adapter can add instructions for finding the current model in its session record. Claude Code events also update or clear the stored session model. Pi and OpenCode run generated extensions.
2. Before a shell tool runs, cosplaying finds enabled commands in the shell input. It uses the [harness adapter](../adapters/README.md) to send back the rewritten input or a reason to stop. The `rewrite` command prints the result of the rewrite for inspection.
3. The rewritten command calls `hook`. The CLI resolves the model, loads the plugin, finds the real executable, and calls `run(args, context)`. The plugin decides which arguments need attribution. [Plugin API](../plugin/README.md)
4. The CLI returns the plugin status. A nested `hook` with `COSPLAYING_INSIDE_HOOK=1` calls the real executable directly.

### Which component owns the behavior

| Behavior | Documentation |
| --- | --- |
| Select the harness file and translate its events and responses | [Harness adapters](../adapters/README.md) |
| Update only the hooks that belong to cosplaying | [Hook file API](../hooks/README.md) |
| Load plugins, find the executable, and run plugin code | [Plugin API](../plugin/README.md) |
| Render a byline or trailer from a model and template | [Attribution API](../attribution/README.md) |
| Decide which operations need attribution and which inputs are allowed | [Git plugin](../../plugins/git/README.md), [GitHub CLI plugin](../../plugins/gh/README.md) |
| Format errors with a component and a corrective action | [Error API](../errors/README.md) |

### Choose the model source

For a direct `hook` or `rewrite` invocation, the order is `--model-base64`, `--model`, `COSPLAYING_MODEL`, then the label from an explicit `--harness`. Use a plain model name with `--model` for commands you enter. Installed hooks use `--model-base64`. If none of these sources supplies a name, the model is empty.

For a JSON agent hook, the order is payload `model`, payload `model_id`, the stored session model if available, `COSPLAYING_MODEL`, then the harness label. The Pi and OpenCode extensions select their model before calling the CLI. [Extension model sources](../adapters/README.md#follow-a-hook-event)

<details>
<summary>Shell rewrite rules</summary>

`rewriteShellCommand(input, routes)` takes a map from executable words to replacements and returns `{ command, changed }`. It checks the full word before its basename. On a parse failure it returns the original text with `changed: false`.

The shell parser can reach commands inside substitutions, pipelines, loops, and unquoted heredocs. Quoted command strings passed to `bash -c` or `eval` stay intact, as do scripts passed to `source`, `.`, or `bash`. When looking for an executable word, cosplaying skips prefixes such as `env`, `command`, `builtin`, `exec`, `sudo`, `nohup`, `time`, and `xargs`. For an `rtk` prefix it inserts `proxy` if that word is absent.

`rewriteModelFlags(input, model)` updates a harness-label `--model` or `--model-base64` on this CLI's `hook` invocation. It writes the active model as `--model-base64`. The active value must be non-empty and outside the harness labels `Claude Code`, `Codex`, `Cursor`, `Gemini CLI`, `OpenCode`, and `Pi`. An explicit model outside those labels stays intact.

</details>

## Load configuration

Import `loadConfig` from `cosplaying/config`. It accepts `{ cwd, home, defaults }`. The built-in settings apply first, followed by company `defaults`, user settings, and project settings. The `variables` objects merge. Each `plugins` array replaces the previous array. Supply the model through the agent session, command options, or environment. A configuration file with `model` or `attribution.model` causes an error.

The CLI uses `prompts.session` when plugins intercept shell commands and `prompts.empty` when none do. If the applicable prompt is absent, it can use `attribution.templates.session` or `attribution.templates.empty`, respectively. The selected adapter supplies `{modelGuidance}`. It gives the host-specific model source when known and otherwise checks this session's conversation record or JSONL transcript. If no model ID is available, it uses the agent's self-reported name, then the harness name. It does not ask the user. A custom session template must include `{modelGuidance}` to show this text. [Configuration files and templates](../../README.md#set-the-attribution-text) and [session prompt variables](../../README.md#set-the-session-instructions)

## Check an installation

```sh
cosplaying doctor
cosplaying doctor --project-dir /path/to/repo --repair
```

Doctor checks every user harness file and the project files when you supply `--project-dir`. When it finds a Git root on its own, it checks project hook files that exist. The report also lists missing agent executables. Those entries are informational.

Doctor checks hook order on every run. If `rtk hook` runs after cosplaying, the repair can reinstall the owned hook last. If a file is unreadable or a cosplaying command lacks the ownership marker, the report identifies it for manual review. Use `--repair` to also regenerate a changed Pi or OpenCode extension that cosplaying owns or replace a registered Node.js path that no longer exists. Give approval again if the agent requires it. [Hook setup and approval](../../README.md#repair-or-remove-hooks)

### Inspect routing before a write

Run these commands from the same working directory as the intended command. This example assumes the `gh` plugin is enabled.

```sh
cosplaying plugin list
cosplaying rewrite --model "Example Model" --shell 'gh issue view 123'
```

`rewrite` prints shell text without running the command. Look for a cosplaying `hook` prefix before `gh`. If the text stays the same, check the effective project plugin list, the plugin's `intercept` setting, and whether the executable appears in shell text the parser can reach. A printed prefix confirms the rewrite in that directory. Use the agent's hook settings to verify that it runs and approves the installed hook.

| Result | Next action |
| --- | --- |
| `hook` reports that the plugin is off or missing | Check `plugin list` and the effective project configuration. Enable a bundled plugin in the applicable scope or supply the custom plugin path. |
| `hook` cannot find the executable | Check `PATH` or set the plugin's executable override to an absolute path. |
| The plugin reports `BLOCKED (command not run)` | Read the reason and correct the input. Retry through cosplaying. Ask the user if the error gives no safe correction. |
| The Git plugin reports `BLOCKED after Git completed` | Inspect the repository state before retrying or pushing. Git may already have created commits. |
| `agent-hook` emits a denial with exit code `0` | Read the denial in the harness response. Exit code `0` means the hook returned its response. |

<details>
<summary>Other exports and exit codes</summary>

| Export | Use |
| --- | --- |
| `renderHelp(plugins)`, `unknownHarness(id)` | Build the command help or a message that lists the supported harness IDs. |
| `installHarness(id, options)`, `uninstallHarness(id, options)` | Update one harness and return its file path. An unknown ID throws. |
| `installAll(options, harnesses)`, `uninstallAll(options, harnesses)` | Update the selected harnesses or all six by default. Each result has `harness`, `file`, `ok`, and `changed`, with an `error` on failure. One failure does not stop later updates. |
| `runAgentHook(harness, eventName, context)` | Read one JSON object from stdin and write the response for the selected adapter. |
| `repairHookOrder(options)` | Return `{ repaired, conflicts, failures }` after checking and repairing hook order. |
| `runDoctor(options)` | Return `0` if there are no findings or `1` when the report records findings. |

The CLI returns `0` for help and version requests. Empty argument lists and usage or model-flag errors return `2`. Missing plugins or executables, failed plugin management operations, and errors caught by the CLI return `1`. A plugin that returns no value yields `0`. A nested hook returns the child process status, with `1` as the fallback.

`plugin enable` and `plugin disable` edit the user plugin list for the bundled `git` and `gh` plugins and update the Pi and OpenCode extensions. A project list takes precedence.

</details>
