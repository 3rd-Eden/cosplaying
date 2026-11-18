# Harness adapters

Import `cosplaying/adapters` when you need to work with a coding agent's hook format. An adapter selects the user or project file and builds the settings that the agent reads. For agents that call `cosplaying agent-hook`, it also reads the event payload and formats the response.

## Find the file an agent uses

```js
import { homedir } from 'node:os';
import { getAdapter } from 'cosplaying/adapters';

const codex = getAdapter('codex');
console.log(codex.file({ home: homedir(), env: process.env }));
// <home>/.codex/hooks.json
```

Pass `projectDir` to get the project path. `getAdapter(id)` returns `undefined` for an unknown ID. The exported `adapters` array contains the instances in the order below.

| ID | User file | Project file |
| --- | --- | --- |
| `claude-code` | `~/.claude/settings.json` | `.claude/settings.json` |
| `codex` | `~/.codex/hooks.json` | `.codex/hooks.json` |
| `cursor` | `~/.cursor/hooks.json` | `.cursor/hooks.json` |
| `gemini` | `~/.gemini/settings.json` | `.gemini/settings.json` |
| `opencode` | `~/.config/opencode/plugins/cosplaying.js` | `.opencode/plugins/cosplaying.js` |
| `pi` | `~/.pi/agent/extensions/cosplaying.js` | `.pi/extensions/cosplaying.js` |

For the OpenCode user file, an absolute `XDG_CONFIG_HOME` replaces `~/.config`. For Pi, `PI_CODING_AGENT_DIR` replaces `~/.pi/agent`.

## Follow a hook event

For the JSON adapters, the agent runs a registered command and sends its event as JSON. The CLI uses the adapter to identify the event and extract the shell command. The adapter then formats the session prompt, the updated tool input, or the reason to stop.

| Agent | Events and response behavior |
| --- | --- |
| Claude Code | Uses `SessionStart` and `PostModelSwitch` to record the model and `SessionEnd` to remove it. The session prompt is text. `PreToolUse` matches `Bash\|PowerShell`. |
| Codex | Registers `SessionStart` and `PreToolUse`. Reads `cmd` from `exec_command` input and denies an unreadable shell command. The adapter supplies hook approval instructions. |
| Cursor | Registers `sessionStart` and `preToolUse` with flat entries and configuration version `1`. It matches `Shell` and returns a `permission` response. The CLI also checks Claude Code's hooks when it checks Cursor's hook order. |
| Gemini CLI | Registers `SessionStart` and `BeforeTool`. It matches `run_shell_command` and returns a `decision` response. The install note applies to project hooks. |

Pi and OpenCode load standalone JavaScript extensions. Each generated file contains its own process runner. Pi uses the active model ID when available. OpenCode uses `COSPLAYING_MODEL` or its harness label.

<details>
<summary>Adapter methods and classes</summary>

The module exports `Harness` and `ExtensionHarness`, plus `ClaudeCode`, `Codex`, `Cursor`, `Gemini`, `OpenCode`, and `Pi`. An instance has an `id`, a display `label`, a `binary`, and a `kind` of `json` or `extension`.

| Method | Use |
| --- | --- |
| `file({ home, env, projectDir })`, `marker()`, `events()` | Get the file path, ownership marker, and installed JSON events. The marker begins with `# cosplaying:` for JSON hooks and `// cosplaying:` for extensions. Extensions return an empty event list. |
| `install(options)`, `uninstall(options)` | Update or remove the owned hooks and return the file path. Pass `bin` to select the CLI invocation and `commands` to supply the extension's command list. |
| `defaultEvent()`, `isSessionStart(event)`, `isPreTool(event)`, `isShellTool(input)`, `extractCommand(input)` | Classify the payload and find the command. |
| `deny(reason)`, `allow(toolInput)`, `unchanged()`, `sessionPayload(prompt)` | Format the agent's response. `unchanged()` can return `null` when there is no output to write. |
| `endsSession(event)`, `switchesModel(event)`, `onSessionStart(input, context)`, `onSessionEnd(input, context)`, `onModelSwitch(input, context)`, `modelFromSession(input, context)` | Process session events and look up the session model. |
| `installedNote({ projectDir })`, `retrustNote()`, `alsoRuns()` | Supply install or approval instructions and identify agents whose hooks run later in the chain. |
| `ExtensionHarness#render(commands, bin)` | Generate the extension file contents. |

</details>

The [hook file API](../hooks/README.md) applies the file changes. The [CLI](../cli/README.md) runs the hook, checks hook order, and prints the doctor report.
