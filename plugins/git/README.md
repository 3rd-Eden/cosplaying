# Git plugin

The Git plugin adds an `AI-Assisted-By` trailer to commits a coding agent creates. When a model is available, the plugin also checks outgoing commits before a push.

## Enable the plugin

Install Git so the executable is on `PATH`, then enable the bundled plugin.

```sh
cosplaying plugin enable git
```

For project configuration, include `"git"` in the `plugins` list. The project list replaces the user list. Add any other plugins you want to use to the same list. To set up automatic interception, [install the agent hooks](../../README.md#install-cosplaying).

## Commit with a byline

Agent hooks supply the model. For a direct command, replace `MODEL_ID` with the current model ID. In a repository with changes already staged, run the following command.

```sh
cosplaying hook --model "MODEL_ID" -- git commit -m "Document the release process"
git log -1 --format=%B
```

The log shows the commit subject and a trailer such as `AI-Assisted-By: MODEL_ID via cosplaying (...)`. You can set the trailer wording in [attribution settings](../../README.md#set-the-attribution-text). When the plugin needs a model and none is available, it stops before running Git.

| Operation | Effect |
| --- | --- |
| `commit` | Passes the trailer to Git with `--trailer` and sets `trailer.AI-Assisted-By.ifExists=replace`. The source file supplied with `-F` stays intact. |
| `commit --amend` | Replaces the previous `AI-Assisted-By` trailer. |
| `merge`, `pull`, `cherry-pick`, `revert`, `am`, and a rebase that can create commits | Adds attribution to the commits Git creates. Replayed commits keep existing trailers and gain the current trailer if it differs. |
| `rebase --abort`, `--quit`, `--show-current-patch`, `--edit-todo` | Runs without adding a trailer. |
| Other Git commands, except `push` | Pass through to Git. |

Fast-forward merges and no-op rebases leave the existing commits intact.

Put cosplaying's `--` before `git`, then use the normal Git syntax for the subcommand. For example, `cosplaying hook --model "MODEL_ID" -- git -C ./repo status` passes `-C ./repo` to Git. The plugin stops if it finds an unsupported global Git option or a second `--` before the Git subcommand, because it cannot classify the operation.

<details>
<summary>What happens after Git creates commits</summary>

For a command such as rebase, Git creates the commits first. The plugin uses new HEAD reflog entries to identify replayed commits. Adding a trailer changes the commit ID. If attribution requires a change to a signed commit or a commit with a non-UTF-8 message, the plugin reports a failure. If attribution fails after Git runs, Git may already have updated the repository. Follow the error message and review the affected commits before pushing.

</details>

## Push attributed commits

With a model, the plugin checks which commits the refspecs would send to each push URL. It stops the push if an outgoing commit has the local committer email and lacks an `AI-Assisted-By` trailer. The error lists the commit IDs and subjects. Repair or replay the affected commits through cosplaying before retrying the push.

<details>
<summary>Push destinations and refspec limits</summary>

The plugin checks explicit or configured refspecs against the refs advertised by each destination. It excludes commits reachable from those remote refs when their commit objects are available locally. It stops the push if it cannot determine or inspect a destination.

The check rejects matching, negative, and wildcard refspecs, as well as `--all`, `--mirror`, and `--tags`. Use an explicit refspec when you need to select a single ref. Dry runs and ref deletions skip the outgoing commit check. A push with an empty model also skips the check.

</details>

To select a specific Git executable, set `COSPLAYING_GIT_BIN` to its absolute path. For the implementation and the contract it uses, see the [plugin entry point](index.js) and [plugin API](../../packages/plugin/README.md).
