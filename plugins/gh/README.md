# GitHub CLI plugin

The GitHub CLI plugin adds a Markdown byline to supported `gh` text writes. It uses a Git trailer for explicit pull request merge messages.

## Enable the plugin

Install the GitHub CLI so `gh` is on `PATH`, then enable the bundled plugin.

```sh
cosplaying plugin enable gh
```

For project configuration, include `"gh"` in the `plugins` list. The project list replaces the user list. Add any other plugins you want to use to the same list. To set up automatic interception, [install the agent hooks](../../README.md#install-cosplaying).

## Add an attributed comment

Agent hooks supply the model. For a direct command, replace `MODEL_ID` with the current model ID or set `COSPLAYING_MODEL`. Run the command in the repository that contains the issue.

```sh
cosplaying hook --model "MODEL_ID" -- gh issue comment 123 --body "The build passed."
```

The comment includes the body and a visible byline with the model and policy link. A supported text write needs a model before `gh` can run. Read commands can run without one. [Attribution settings](../../README.md#set-the-attribution-text)

<details>
<summary>Send a body from a file or stdin</summary>

```sh
cosplaying hook --model "MODEL_ID" -- gh issue comment 123 --body-file note.md

printf '%s\n' 'The build passed.' |
  cosplaying hook --model "MODEL_ID" -- gh issue comment 123 --body-file -
```

When it adds attribution to a file, the plugin gives `gh` a temporary copy with mode `0600` and keeps the source file intact. It removes the copy after `gh` exits. It uses the same mechanism for supported stdin, template, and JSON inputs. If the input needs no change, it can keep the original path.

</details>

## Supported text fields

| `gh` command | Text that receives attribution |
| --- | --- |
| `pr create`, `pr edit`, `pr comment`, `pr review` | `--body` or `--body-file`. Pull request creation can also use `--template`. |
| `issue create`, `issue edit`, `issue comment` | `--body` or `--body-file`. |
| `pr close`, `issue close` | `--comment`. |
| `release create`, `release edit` | `--notes` or `--notes-file`. |
| `repo create`, `repo edit`, `label create`, `label edit` | `--description`. |
| `gist create`, `gist edit` | `--desc`. Gist file contents stay intact. |
| `project item-edit` | The draft issue body from `--body`. |
| `agent-task create` | The task description argument or the text from `--from-file`. |

Supply the final text through a supported option. The plugin stops a write that requires text when the input is missing. A review without a body gets a body with attribution only. For supported text writes, use the CLI because `--web` and `-w` are blocked. Commands outside the plugin's supported command list pass through.

### Pull request merge messages

An explicit `gh pr merge` body gets an `AI-Assisted-By` trailer. A subject supplied without a body gets a body with the trailer. The subject stays intact. The plugin rejects explicit merge messages with `--rebase`. A merge without explicit message options passes through.

### API requests

`gh api` adds attribution to selected REST routes and GraphQL mutations. See the [REST rules](api.js) and [GraphQL rules](graphql.js) for the exact routes and fields.

- Supported text fields get a Markdown byline. Git commit messages get an `AI-Assisted-By` trailer.
- Selected reviewer requests and Git object writes require a model and have no byline.
- GET, HEAD, OPTIONS, and GraphQL queries pass through. Selected POST requests, such as workflow reruns, Markdown rendering, and release note generation, also pass through.
- The plugin stops API writes outside the approved set. For GraphQL writes, use one approved mutation per request.

<details>
<summary>Supply text to an API write</summary>

This command adds an issue comment through a supported REST route. Replace `OWNER`, `REPO`, `123`, and `MODEL_ID` with the values for the intended write.

```sh
cosplaying hook --model "MODEL_ID" -- gh api repos/OWNER/REPO/issues/123/comments \
  --method POST -f 'body=The build passed.'
```

For this route, the plugin adds the byline to `body`. You can also supply the body with `-F body=@note.md` or give the request as a JSON file with `--input`. Use one source for each attributed field.

For an approved GraphQL content mutation, use one mutation operation with one top-level mutation field. Reference a variable for the text. Supply the query and variables with `-f` or `-F`, or supply one `--input` JSON file with a top-level `query` and a `variables` object. A commit mutation that receives a trailer needs the JSON file form with the complete `variables.input` object. Batch review comments and threads also need the JSON file form.

If a request stops, use the method, endpoint, and field names in the error to correct it. If the operation has no approved attribution rule, ask the user for an approved route. [REST rules](api.js), [GraphQL rules](graphql.js)

</details>

To select a specific GitHub CLI executable, set `COSPLAYING_GH_BIN` to its absolute path. For the implementation and the contract it uses, see the [plugin entry point](index.js) and [plugin API](../../packages/plugin/README.md).
