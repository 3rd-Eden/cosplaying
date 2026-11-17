# git

This plugin adds attribution to Git commits and examines outgoing commits before a push. It controls the `git` command. The plugin does not install Git.

```sh
cosplaying plugin enable git
```

A project `.cosplaying.json` can name it instead:

```json
{ "plugins": ["git"] }
```

Until that name is present, `git` is not rewritten. `cosplaying install` does not enable this plugin. Copy this directory when you want a plugin of your own. Change `name` in `package.json` to the command you wrap.

## What it attributes

`context.realBin` is the Git executable. The host resolves `COSPLAYING_GIT_BIN` before `run`. `context.attribution.renderTrailer()` is the `AI-Assisted-By` line. `context.model` is the identity. An empty model blocks a commit-creating command and does not run Git.

`commit` inserts `-c trailer.AI-Assisted-By.ifExists=replace` and `--trailer`. A message file passed with `-F` is not edited. Amend replaces the previous `AI-Assisted-By` trailer.

`merge`, `pull`, `cherry-pick`, `revert`, `am`, and a rebase that creates commits also require a model. After Git exits, commits those commands created are rewritten. Replayed commits keep an existing trailer and gain the current one (`addIfDifferent`). A fast-forward merge and a no-op rebase do not invent a commit. `rebase --abort`, `--quit`, `--show-current-patch`, and `--edit-todo` are not writes.

Rebase commits are chosen from new HEAD reflog entries. A signed commit is not rewritten. A non-UTF-8 commit message is not rewritten. If that repair fails after Git has already finished, the command tells you not to push those commits.

## Push

`push` with a model blocks outgoing commits from the local committer that lack `AI-Assisted-By`. The push does not run. With no model, the push is not checked. Other Git commands pass through.

For a push with a model, cosplaying examines each explicit or configured refspec against its destination ref. It stops matching, negative, and wildcard refspecs. It also stops `--all`, `--mirror`, and `--tags`. Those options can send multiple refs.

Dry runs and ref deletions do not use the outgoing commit check. If cosplaying cannot determine or inspect a push destination, it stops the push.

For the plugin interface, refer to the [main README](../../README.md#develop-a-plugin) and the [plugin API](../../packages/plugin/README.md).
