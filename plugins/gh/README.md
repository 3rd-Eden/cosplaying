# gh

Shipped plugin and a working example of a cosplaying plugin. The package `name` is the command `gh`. The default export is the function `hook` calls.

```sh
cosplaying plugin enable gh
```

A project `.cosplaying.json` can name it instead:

```json
{ "plugins": ["gh"] }
```

Until that name is present, `gh` is not rewritten. `cosplaying install` does not enable this plugin. Copy this directory when you want a plugin of your own.

## What it attributes

`context.realBin` is the GitHub CLI. The host resolves `COSPLAYING_GH_BIN` before `run`. `context.attribution.annotateMarkdown` adds the visible block. `context.attribution.renderTrailer` adds an `AI-Assisted-By` line to merge and commit messages. An empty model blocks a text write and does not run `gh`. Reads pass through without a model.

Supported text:

- Pull requests and issues: bodies, comments, closing comments, and reviews. A review without body text receives a body that contains attribution only. Explicit `pr merge` bodies and subjects receive a commit trailer. `pr merge --rebase` with an explicit message is blocked.
- Releases: notes.
- Repository, label, and gist metadata: supported description fields.
- Projects and agent tasks: draft issue bodies and agent task descriptions.
- `gh api`: selected REST and GraphQL writes for issues, pull requests, comments, reviews, discussions, projects, releases, repositories, advisories, and code-scanning alert dismissals. Git commit messages receive a trailer. Reviewer requests and Git object writes need a model and are otherwise unchanged. Other mutations are blocked. GET, HEAD, and OPTIONS pass through.

`--web` is blocked on a supported text write. A missing body on a command that requires text is blocked. Source files are not modified.

File, template, JSON, and stdin inputs are copied to a private file at mode `0600` under the system temporary directory. `gh` receives that path. The copy is removed after `gh` exits. `graphql` parses one mutation so each approved text field can be attributed.
