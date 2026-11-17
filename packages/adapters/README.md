# @cosplaying/adapters

Private workspace package. Import it as `cosplaying/adapters`.

## What it does

Owns the setup for each coding harness. `ClaudeCode`, `Codex`, `Cursor`, `Gemini`, `OpenCode`, and `Pi` each know their path, events, hook command, and the response a hook event writes.

## Scope

In scope: user and project paths, owner markers, event names, matchers, install and uninstall of that harness file, and the JSON or text returned for a hook event.

`@cosplaying/hooks` writes the file. This package chooses the path and the contents. Pi and OpenCode files are generated here and do not import this package. The repeated runner in those two files stays duplicated. Hook-order repair stays in `@cosplaying/cli`. Shipped `git` and `gh` plugins live in `plugins/`, not in this package.

## Public API

- `adapters` is one instance of each class, in this order: `claude-code`, `codex`, `cursor`, `gemini`, `opencode`, `pi`.
- `getAdapter(id)` returns that instance. An unknown id is `undefined`.
- `ClaudeCode`, `Codex`, `Cursor`, `Gemini`, `OpenCode`, `Pi`, `Harness`, and `ExtensionHarness` are the classes.

Each instance has `id`, `label`, `binary`, and `kind`. `kind` is `json` or `extension`.

- `file({ home, env, projectDir })` returns the user file. When `projectDir` is set, it returns the project file.
- `marker()` is `# cosplaying:<id>` for a JSON harness and `// cosplaying:<id>` for Pi and OpenCode.
- `events()` is the hook events a JSON install writes. Pi and OpenCode return an empty list.
- `install(options)` and `uninstall(options)` write or remove that file and return its path. `options.commands` and `options.bin` are used by Pi and OpenCode.
- `defaultEvent()`, `isSessionStart(event)`, `isPreTool(event)`, `isShellTool(input)`, and `extractCommand(input)` classify one hook payload.
- `deny(reason)`, `allow(toolInput)`, `unchanged()`, and `sessionPayload(prompt)` are the hook response. `unchanged()` is `null` when the harness writes nothing for an unchanged command.
- `installedNote({ projectDir })` and `retrustNote()` are lines for install and doctor. An empty string means no line.
- `alsoRuns()` lists harness ids whose pre-tool hooks are checked after this one. Cursor returns `claude-code`.

Claude Code stores the session model and writes the session prompt as plain text. Its `PreToolUse` matcher is `Bash|PowerShell`. Codex reads `exec_command` from `cmd`, denies an unreadable shell command, and supplies the Codex trust lines. Cursor writes version `1`, flat command entries, and `permission` responses. Its `preToolUse` matcher is `Shell`. Gemini matches `run_shell_command` and writes `decision` responses. Its install note is only present when `projectDir` is set. Pi reads `PI_CODING_AGENT_DIR`. OpenCode reads an absolute `XDG_CONFIG_HOME`.

## Related packages

`@cosplaying/cli` calls `getAdapter` for install, uninstall, agent-hook, and doctor. `@cosplaying/hooks` writes the JSON and the generated files. The installed command uses `cliInvocation` from the CLI path module. Failures from those writers throw `CosplayError`.
