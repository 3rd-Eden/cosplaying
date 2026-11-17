# GitHub CLI plugin

This plugin adds attribution to supported GitHub CLI text writes. It controls the `gh` command. The plugin does not install the GitHub CLI.

## Enable the plugin

```sh
cosplaying plugin enable gh
```

You can also add `gh` to the `plugins` list in your project configuration:

```json
{ "plugins": ["gh"] }
```

A project plugin list replaces the user list. `cosplaying install` installs agent hooks but does not enable this plugin.

## Supply the model

Installed agent hooks supply the model. For a direct command, use `--model`:

```sh
cosplaying hook --model "MODEL_ID" -- gh issue view 123
```

Replace `MODEL_ID` with the current model ID. You can also set `COSPLAYING_MODEL`.

A supported text write without a model stops before `gh` starts. Read commands do not need a model.

## Supported text

| Command | Text that receives attribution |
| --- | --- |
| `pr create`, `pr edit`, `pr comment`, `pr review` | The body text. |
| `issue create`, `issue edit`, `issue comment` | The body text. |
| `pr close`, `issue close` | The text from `--comment`. |
| `release create`, `release edit` | The release notes. |
| `repo create`, `repo edit`, `label create`, `label edit` | The text from `--description`. |
| `gist create`, `gist edit` | The text from `--desc`. The plugin does not change gist file contents. |
| `project item-edit` | The draft issue body from `--body`. |
| `agent-task create` | The task description or text from `--from-file`. |

A review without body text receives a body with attribution only. Commands that require text stop if no supported text input is present.

For supported text writes, supply the final text through a command argument, file, or supported template option. The plugin stops a supported text write with `--web` or `-w`.

### Pull request merge messages

An explicit `pr merge` body receives an `AI-Assisted-By` trailer. If you supply only `--subject`, the plugin adds a body with the trailer. It does not change the subject.

The plugin stops `pr merge --rebase` if you supply an explicit message. A merge without explicit message options passes through unchanged.

### API requests

`gh api` supports selected REST routes and GraphQL mutations. Supported resources include issues, pull requests, comments, reviews, discussions, projects, releases, repositories, advisories, and code-scanning alert dismissals.

The plugin adds Markdown attribution to supported text fields. Git commit messages receive an `AI-Assisted-By` trailer. Selected reviewer requests and Git object writes require a model but do not receive a byline.

The plugin permits selected operations without text, such as workflow reruns. It also permits POST requests for Markdown rendering and release note generation without attribution. GET, HEAD, OPTIONS, and GraphQL queries pass through without attribution.

Other API writes stop before `gh` starts. GraphQL attribution supports one approved mutation per request. For the exact routes and fields, refer to [the REST rules](api.js) and [the GraphQL rules](graphql.js).

The plugin does not classify every `gh` subcommand as a write. Commands outside its supported command list pass through unchanged.

## File input

The plugin keeps source files unchanged. When file input needs attribution, the plugin writes a temporary copy with mode `0600`. It passes the copy path to `gh` and removes the copy after `gh` exits.

The same temporary-file mechanism handles supported stdin, template, and JSON inputs. An input that does not need a change can keep its source path.

## Plugin development

The default export in [index.js](index.js) is the plugin entry point. `context.realBin` contains the GitHub CLI executable path. `COSPLAYING_GH_BIN` can select an absolute executable path.

`context.attribution.annotateMarkdown(text)` adds the Markdown byline. `context.attribution.renderTrailer()` supplies the `AI-Assisted-By` line.

For the plugin interface, refer to the [main README](../../README.md#develop-a-plugin) and the [plugin API](../../packages/plugin/README.md).
