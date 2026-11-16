import { parse } from 'unbash';
import { adapters } from 'cosplaying/adapters';

const SHELL_PREFIXES = new Set([
  'env', 'command', 'builtin', 'exec', 'sudo', 'nohup', 'time', 'xargs',
]);

/**
 * @param {unknown} node
 * @returns {node is Record<string, unknown>}
 */
function isRecord(node) {
  return node !== null && typeof node === 'object';
}

/**
 * @param {string} value
 * @returns {string}
 */
function basename(value) {
  const text = value.replaceAll('\\', '/');
  const name = text.slice(text.lastIndexOf('/') + 1);
  return name.replace(/\.exe$/i, '');
}

/**
 * @param {Record<string, unknown>} word
 * @returns {boolean}
 */
function isWord(word) {
  return word && word.pos !== undefined && word.end !== undefined;
}

/**
 * @param {Record<string, unknown>} word
 * @returns {string}
 */
function wordValue(word) {
  if (!word) return '';
  return word.value ?? word.text ?? '';
}

/**
 * @param {Record<string, unknown>} word
 * @returns {boolean}
 */
function isAssignment(word) {
  return word.type === 'Assignment' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(wordValue(word));
}

/**
 * @param {Record<string, unknown>} word
 * @returns {boolean}
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
 * @param {string} wrapper
 * @param {string} flag
 * @returns {boolean}
 */
function flagConsumesNext(wrapper, flag) {
  if (!flag.startsWith('-') || flag === '-' || flag.includes('=')) return false;
  const spec = WRAPPER_FLAG_ARGS[wrapper];
  if (!spec) return false;
  if (flag.startsWith('--')) return spec.long.includes(flag.slice(2));
  return flag.length === 2 && spec.short.includes(flag[1]);
}

/**
 * @param {Record<string, string>} routes
 * @param {string} word
 * @returns {string | undefined}
 */
function routeFor(routes, word) {
  if (Object.hasOwn(routes, word)) return routes[word];
  const name = basename(word);
  if (Object.hasOwn(routes, name)) return routes[name];
  return undefined;
}

/**
 * @param {Record<string, unknown>} command
 * @returns {{word: Record<string, unknown>, rtk: boolean, proxy: boolean} | null}
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
 * @param {unknown} node
 * @param {string} original
 * @param {(command: Record<string, unknown>) => void} visitCommand
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
 * @param {string} input
 * @param {Record<string, string>} routes
 * @returns {{command: string, changed: boolean}}
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
 * @param {string} value
 * @returns {boolean}
 */
function isBase64Url(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * @param {string} flag
 * @param {string} value
 * @returns {string}
 */
function decodeFlag(flag, value) {
  if (flag === '--model') return value;
  if (flag === '--model-base64' && isBase64Url(value)) {
    try {
      return Buffer.from(value, 'base64url').toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * @param {string} word
 * @returns {boolean}
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
 * @param {Record<string, unknown>} command
 * @param {string} [inherited]
 * @returns {{words: Record<string, unknown>[], from: number} | null}
 */
function hookInvocation(command, inherited = '') {
  const found = executableWord(command, inherited);
  if (!found) return null;
  const words = [command.name, ...command.suffix].filter(isWord);
  const index = words.indexOf(found.word);
  if (index < 0) return null;
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
 * Replaces every harness-label model flag on a hook invocation of this CLI.
 * The scan stops at `--` or the first positional word, so the wrapped command keeps its own flags.
 * A model that is itself a harness label is left unchanged.
 * @param {string} input
 * @param {string} model
 * @returns {string}
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
