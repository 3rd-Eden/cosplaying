import { parse } from 'unbash';
import { adapters } from 'cosplaying/adapters';

const SHELL_PREFIXES = new Set([
  'env', 'command', 'builtin', 'exec', 'sudo', 'nohup', 'time', 'xargs',
]);

/**
 * Reports whether a parser node can be walked as an object.
 *
 * The shell parser mixes objects and arrays. Only objects have child commands.
 *
 * @param {unknown} node Value from the unbash parse tree.
 * @returns {node is Record<string, unknown>} True when `node` is a non-null object.
 */
function isRecord(node) {
  return node !== null && typeof node === 'object';
}

/**
 * Returns the executable name from a path.
 *
 * Routes are stored by command name. A path such as `/usr/bin/git` must match the route `git`. A trailing `.exe` is removed so Windows uses the same name.
 *
 * @param {string} value Command word from the shell. It may be a path.
 * @returns {string} Final path segment without a trailing `.exe`.
 */
function basename(value) {
  const text = value.replaceAll('\\', '/');
  const name = text.slice(text.lastIndexOf('/') + 1);
  return name.replace(/\.exe$/i, '');
}

/**
 * Reports whether a parser word has a source span.
 *
 * A rewrite replaces text by `pos` and `end`. A node without those fields is not a word that can be replaced.
 *
 * @param {Record<string, unknown>} word One element of a command's name or suffix.
 * @returns {boolean} True when `word` has both `pos` and `end`.
 */
function isWord(word) {
  return word && word.pos !== undefined && word.end !== undefined;
}

/**
 * Returns the text of one parser word.
 *
 * The parser uses `value` for some nodes and `text` for others. Callers compare that text with command names and flags.
 *
 * @param {Record<string, unknown>} word Parser word. A missing word is treated as empty.
 * @returns {string} `value`, or `text` when `value` is absent. An empty string when `word` is missing.
 */
function wordValue(word) {
  if (!word) return '';
  return word.value ?? word.text ?? '';
}

/**
 * Reports whether a word assigns an environment variable.
 *
 * Assignments before a command, such as `FOO=bar git`, are not the executable. They are skipped while the executable word is found.
 *
 * @param {Record<string, unknown>} word Parser word.
 * @returns {boolean} True when the word is an assignment node or matches `NAME=`.
 */
function isAssignment(word) {
  return word.type === 'Assignment' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(wordValue(word));
}

/**
 * Reports whether a word is a command flag.
 *
 * Flags belong to the wrapper in front of the real executable. They are not rewritten.
 *
 * @param {Record<string, unknown>} word Parser word.
 * @returns {boolean} True when the word text starts with `-`.
 */
function isFlag(word) {
  return wordValue(word).startsWith('-');
}

/**
 * Wrapper flags that take the next word as an argument.
 * A flag with an attached value (`-n1`, `--user=root`) does not consume another word.
 * @type {Record<string, {short: string, long: string[]}>}
 */
const WRAPPER_FLAG_ARGS = {
  sudo: { short: 'ughpUCDRT', long: ['user', 'group', 'host', 'prompt', 'other-user', 'close-from', 'chdir', 'role', 'command-timeout'] },
  env: { short: 'uCSa', long: ['unset', 'chdir', 'split-string', 'argv0'] },
  xargs: { short: 'aEeiILlnPsdJ', long: ['arg-file', 'eof', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'delimiter'] },
  time: { short: 'fo', long: ['format', 'output'] },
  exec: { short: 'a', long: [] },
  command: { short: '', long: [] },
  builtin: { short: '', long: [] },
  nohup: { short: '', long: [] },
};

/**
 * Reports whether a wrapper flag takes the next word as its argument.
 *
 * `sudo -u root git` must not treat `root` as the executable. A flag that already contains its value, such as `--user=root` or `-n1`, does not consume another word.
 *
 * @param {string} wrapper Wrapper basename that is currently in effect, for example `sudo`.
 * @param {string} flag Flag text, including the leading dashes.
 * @returns {boolean} True when the next word is the flag's argument and must be skipped.
 */
function flagConsumesNext(wrapper, flag) {
  if (!flag.startsWith('-') || flag === '-' || flag.includes('=')) return false;
  const spec = WRAPPER_FLAG_ARGS[wrapper];
  if (!spec) return false;
  if (flag.startsWith('--')) return spec.long.includes(flag.slice(2));
  return flag.length === 2 && spec.short.includes(flag[1]);
}

/**
 * Finds the rewrite prefix for one command word.
 *
 * A path matches the route of its basename. An unknown command is left unchanged.
 *
 * @param {Record<string, string>} routes Map of command name to the shell prefix that must run it.
 * @param {string} word Executable text from the command, which may be a path.
 * @returns {string | undefined} Prefix for that command. `undefined` when neither the word nor its basename is a route.
 */
function routeFor(routes, word) {
  if (Object.hasOwn(routes, word)) return routes[word];
  const name = basename(word);
  if (Object.hasOwn(routes, name)) return routes[name];
  return undefined;
}

/**
 * Finds the word that names the program a command will run.
 *
 * Assignments, wrapper programs, and their flag arguments are skipped. `env`, `sudo`, `time`, and the other shell prefixes are not the target. `rtk` and `rtk proxy` are recorded so the rewrite can keep `rtk` from stripping the cosplaying prefix.
 *
 * @param {Record<string, unknown>} command Command node from the shell parser.
 * @param {string} [initialWrapper=''] Wrapper inherited from an outer `time` prefix. Its flags are skipped before the executable is chosen.
 * @returns {{word: Record<string, unknown>, rtk: boolean, proxy: boolean} | null} The executable word, plus whether `rtk` and `rtk proxy` preceded it. Null when the command has no executable word.
 */
function executableWord(command, initialWrapper = '') {
  const words = [command.name, ...command.suffix].filter(isWord);
  let sawRtk = false;
  let sawProxy = false;
  let wrapper = initialWrapper;
  let consume = false;
  let commandNext = false;
  for (const word of words) {
    if (consume) {
      consume = false;
      continue;
    }
    if (isAssignment(word)) continue;
    const text = wordValue(word);
    if (commandNext) return { word, rtk: sawRtk, proxy: sawProxy };
    if (text === '--') {
      commandNext = true;
      continue;
    }
    if (isFlag(word)) {
      if (wrapper && flagConsumesNext(wrapper, text)) consume = true;
      continue;
    }
    const name = basename(text);
    if (SHELL_PREFIXES.has(name)) {
      wrapper = name;
      continue;
    }
    wrapper = '';
    if (name === 'rtk') {
      sawRtk = true;
      continue;
    }
    if (sawRtk && name === 'proxy') {
      sawProxy = true;
      continue;
    }
    return { word, rtk: sawRtk, proxy: sawProxy };
  }
  return null;
}

/**
 * Visits every command in one shell parse tree.
 *
 * Nested commands in pipelines, lists, and substitutions are included. A nested script whose source is not the original string is skipped, so a quoted script is not rewritten as if it were the outer command. A `time` prefix is passed down so the command under it is still found.
 *
 * @param {unknown} node Current parse node.
 * @param {string} original Shell text that was parsed. A nested script with different source is ignored.
 * @param {(command: Record<string, unknown>, inherited: string) => void} visitCommand Called for each command node with the inherited wrapper name.
 * @param {WeakSet<object>} [seen] Nodes already visited. This stops a cycle in the parse tree.
 * @param {string} [inherited=''] Wrapper name from an outer node, currently `time` or empty.
 * @returns {void} No value. Results are collected by `visitCommand`.
 */
function walk(node, original, visitCommand, seen = new WeakSet(), inherited = '') {
  if (!isRecord(node) || seen.has(node)) return;
  seen.add(node);
  if (node.type === 'Script' && node.source && node.source !== original) return;
  const next = node.type === 'Pipeline' && node.time ? 'time' : inherited;
  if (node.type === 'Command') visitCommand(node, inherited);
  const keys = Object.keys(node);
  if (!keys.includes('parts') && 'parts' in node) keys.push('parts');
  for (const key of keys) {
    if (key === 'source') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, original, visitCommand, seen, next);
    } else if (isRecord(value)) {
      walk(value, original, visitCommand, seen, next);
    }
  }
}

/**
 * Rewrites each routed executable in a shell command.
 *
 * The executable word is replaced by the route prefix. `env`, `sudo`, and the other wrappers stay in front. `rtk` without `proxy` becomes `proxy` plus the prefix, so `rtk` cannot remove the cosplaying command. A command that cannot be parsed is returned unchanged.
 *
 * @param {string} input Shell command from the agent or from `rewrite`.
 * @param {Record<string, string>} [routes={}] Map of command name to the prefix that must replace that executable.
 * @returns {{command: string, changed: boolean}} The rewritten shell text, and whether any executable was replaced.
 */
export function rewriteShellCommand(input, routes = {}) {
  const original = input;
  let tree;
  try {
    tree = parse(original);
  } catch {
    return { command: original, changed: false };
  }
  /** @type {{start: number, end: number, text: string}[]} */
  const replacements = [];
  walk(tree, original, (command, inherited) => {
    const found = executableWord(command, inherited);
    if (!found) return;
    const prefix = routeFor(routes, wordValue(found.word));
    if (!prefix) return;
    const text = found.rtk && !found.proxy ? `proxy ${prefix}` : prefix;
    replacements.push({ start: found.word.pos, end: found.word.end, text });
  });
  if (replacements.length === 0) return { command: original, changed: false };
  let command = original;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    command = command.slice(0, replacement.start) + replacement.text + command.slice(replacement.end);
  }
  return { command, changed: command !== original };
}

const HARNESS_LABELS = new Set(adapters.map((item) => item.label));

/**
 * Reports whether a flag value can be decoded as base64url.
 *
 * `--model-base64` is decoded only when every character is in the base64url alphabet. Any other text is not treated as a model name.
 *
 * @param {string} value Text after `--model-base64`.
 * @returns {boolean} True when `value` contains only letters, digits, `_`, and `-`.
 */
function isBase64Url(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Returns the model name stored in one hook model flag.
 *
 * `--model` is plain text. `--model-base64` is decoded when the value is base64url. A value that cannot be decoded is empty, so it is not treated as a harness label.
 *
 * @param {string} flag `--model` or `--model-base64`.
 * @param {string} value Flag value, without the flag name.
 * @returns {string} Model name. An empty string when the flag is not a model flag or the base64url value is invalid.
 */
function decodeFlag(flag, value) {
  if (flag === '--model') return value;
  if (flag === '--model-base64' && isBase64Url(value)) {
    return Buffer.from(value, 'base64url').toString('utf8');
  }
  return '';
}

/**
 * Reports whether a word starts this CLI.
 *
 * Model-flag rewrite looks only at hook invocations of this CLI. Other programs keep their own `--model` flags.
 *
 * @param {string} word Executable text. A path is reduced to its basename.
 * @returns {boolean} True for `cosplaying`, `cosplaying.js`, and `main.js`.
 */
function isCliWord(word) {
  const name = basename(word);
  if (['cosplaying', 'cosplaying.js', 'main.js'].includes(name)) return true;
  return false;
}

/**
 * Hook flags that take a separate argument. An inline `--flag=value` does not.
 * @type {Set<string>}
 */
const HOOK_VALUE_FLAGS = new Set(['--model', '--model-base64', '--harness']);

/**
 * Finds the flag words of one `cosplaying hook` invocation.
 *
 * The scan starts after the `hook` word. `node main.js hook` and a direct `cosplaying hook` are both recognized. The wrapped command after `--` is outside this span.
 *
 * @param {Record<string, unknown>} command Command node from the shell parser.
 * @param {string} [inherited=''] Wrapper inherited from an outer `time` prefix.
 * @returns {{words: Record<string, unknown>[], from: number} | null} The command words and the index of the first hook flag. Null when the command is not this CLI's `hook` subcommand.
 */
function hookInvocation(command, inherited = '') {
  const found = executableWord(command, inherited);
  if (!found) return null;
  const words = [command.name, ...command.suffix].filter(isWord);
  const index = words.indexOf(found.word);
  const executable = wordValue(found.word);
  let hookAt;
  if (basename(executable) === 'node') {
    const scriptName = words[index + 1] ? basename(wordValue(words[index + 1])) : '';
    if (scriptName !== 'main.js' && scriptName !== 'cosplaying.js') return null;
    hookAt = index + 2;
  } else if (isCliWord(executable)) {
    hookAt = index + 1;
  } else {
    return null;
  }
  if (wordValue(words[hookAt]) !== 'hook') return null;
  return { words, from: hookAt + 1 };
}

/**
 * Replaces a harness-label model flag on a `hook` invocation of this CLI.
 *
 * Pi and OpenCode pass their own label when they do not know the model. That label is replaced with the active model as `--model-base64`. The scan stops at `--` or the first positional word, so the wrapped command keeps its own flags. A model that is itself a harness label is left unchanged. A command that cannot be parsed is returned unchanged.
 *
 * @param {string} input Shell command that may contain `cosplaying hook --model <label>`.
 * @param {string} model Active model name. An empty name, or a name that is a harness label, leaves `input` unchanged.
 * @returns {string} Shell text with each matching model flag replaced. `input` when nothing matches.
 */
export function rewriteModelFlags(input, model) {
  const active = model.trim();
  if (!active || HARNESS_LABELS.has(active)) return input;
  let tree;
  try {
    tree = parse(input);
  } catch {
    return input;
  }
  /** @type {{start: number, end: number, text: string}[]} */
  const replacements = [];
  const encoded = Buffer.from(active, 'utf8').toString('base64url');
  walk(tree, input, (command, inherited) => {
    const invocation = hookInvocation(command, inherited);
    if (!invocation) return;
    const { words, from } = invocation;
    for (let cursor = from; cursor < words.length; cursor += 1) {
      const token = wordValue(words[cursor]);
      if (token === '--') return;
      const inline = token.match(/^(--[A-Za-z0-9][A-Za-z0-9-]*)=(.*)$/);
      const flag = inline ? inline[1] : token;
      if (!flag.startsWith('-')) return;
      if (flag === '--model' || flag === '--model-base64') {
        const valueWord = inline ? null : words[cursor + 1];
        const raw = inline ? inline[2] : wordValue(valueWord);
        if (HARNESS_LABELS.has(decodeFlag(flag, raw))) {
          const start = words[cursor].pos;
          const end = inline ? words[cursor].end : valueWord?.end;
          if (end !== undefined) replacements.push({ start, end, text: `--model-base64 ${encoded}` });
        }
        if (!inline && valueWord) cursor += 1;
        continue;
      }
      if (!inline && HOOK_VALUE_FLAGS.has(flag) && words[cursor + 1]) cursor += 1;
    }
  });
  let command = input;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    command = command.slice(0, replacement.start) + replacement.text + command.slice(replacement.end);
  }
  return command;
}
