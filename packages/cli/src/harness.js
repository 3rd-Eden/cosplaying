import { readFileSync } from 'node:fs';
import { findUpSync } from 'find-up';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';
import { readJsonConfig } from 'cosplaying/hooks';
import { adapters, getAdapter } from 'cosplaying/adapters';

/**
 * Finds the Git working tree that contains a directory.
 *
 * Project hooks are installed at that root. A directory that is not inside a repository has no project scope.
 *
 * @param {string} start Directory where the search starts. An empty string uses the process working directory.
 * @returns {string | undefined} Directory that contains `.git`. `undefined` when no `.git` is found.
 */
export function gitRoot(start) {
  const found = findUpSync('.git', { cwd: start || process.cwd(), type: 'both' });
  return found ? path.dirname(found) : undefined;
}

/**
 * Installs hooks for one harness.
 *
 * The adapter writes its settings file or extension. A failure is thrown to the caller.
 *
 * @param {string} id Harness id, for example `codex`.
 * @param {object} options Location and command text passed to the adapter `install` method.
 * @param {string} options.home User home directory.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used by harnesses that override their config root.
 * @param {string} [options.projectDir] Project directory. When set, project hooks are written.
 * @param {NodeJS.Platform} [options.platform] Platform used to quote hook commands.
 * @param {string} [options.bin] `cosplaying` executable embedded in hook commands.
 * @param {string[]} [options.commands] Plugin command names embedded in extension harnesses.
 * @returns {string} Path of the file the adapter updated.
 */
export function installHarness(id, options) {
  return getAdapter(id).install(options);
}

/**
 * Removes hooks for one harness.
 *
 * Only entries that contain the harness marker are removed. An unmarked Pi or OpenCode file is left in place.
 *
 * @param {string} id Harness id, for example `pi`.
 * @param {object} options Location passed to the adapter `uninstall` method.
 * @param {string} options.home User home directory.
 * @param {NodeJS.ProcessEnv} [options.env] Environment used by harnesses that override their config root.
 * @param {string} [options.projectDir] Project directory. When set, project hooks are removed.
 * @returns {string} Path of the file the adapter updated.
 */
export function uninstallHarness(id, options) {
  return getAdapter(id).uninstall(options);
}

/**
 * Reads a hook file so install can tell whether the bytes changed.
 *
 * A missing file is not an error. The caller compares the text before and after the write.
 *
 * @param {string} file Hook file path.
 * @returns {string | null} File text. Null when the file does not exist.
 * @throws {Error} The file exists and cannot be read.
 */
function readOptional(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Installs or removes one harness and records whether the file changed.
 *
 * A failure is returned so the next harness still runs. `changed` is false when the file bytes are unchanged, which is when the atomic JSON write skips the write.
 *
 * @param {string} id Harness id.
 * @param {object} options Location and command text passed to the adapter.
 * @param {boolean} remove True to uninstall. False to install.
 * @returns {{harness: string, file: string, ok: boolean, changed: boolean, error?: unknown}} The harness id, the file path, whether the operation succeeded, whether the bytes changed, and the error when it failed.
 */
function applyHarness(id, options, remove) {
  let file = '';
  try {
    const harness = getAdapter(id);
    file = harness.file(options);
    const before = readOptional(file);
    if (remove) harness.uninstall(options);
    else harness.install(options);
    const after = readOptional(file);
    return { harness: id, file, ok: true, changed: before !== after };
  } catch (error) {
    return { harness: id, file, ok: false, changed: false, error };
  }
}

/**
 * Installs hooks for each requested harness.
 *
 * One failure does not stop the others. The caller prints each result.
 *
 * @param {object} options Location and command text passed to every adapter.
 * @param {string[]} [harnesses] Harness ids to install. The default is every adapter.
 * @returns {Array<{harness: string, file: string, ok: boolean, changed: boolean, error?: unknown}>} One result per id, in the same order.
 */
export function installAll(options, harnesses = adapters.map((item) => item.id)) {
  return harnesses.map((id) => applyHarness(id, options, false));
}

/**
 * Removes hooks for each requested harness.
 *
 * One failure does not stop the others. Owned entries are removed. Foreign hooks stay.
 *
 * @param {object} options Location passed to every adapter.
 * @param {string[]} [harnesses] Harness ids to remove. The default is every adapter.
 * @returns {Array<{harness: string, file: string, ok: boolean, changed: boolean, error?: unknown}>} One result per id, in the same order.
 */
export function uninstallAll(options, harnesses = adapters.map((item) => item.id)) {
  return harnesses.map((id) => applyHarness(id, options, true));
}

/**
 * Collects the shell commands registered on a harness's pre-tool event.
 *
 * Hook order is checked on that event because a later command can remove the cosplaying prefix before the tool runs.
 *
 * @param {import('cosplaying/adapters').Harness} harness Adapter whose pre-tool event name is used.
 * @param {unknown} value Parsed settings object. A missing or non-object `hooks` value yields no commands.
 * @returns {string[]} Command strings from that event, including commands nested in hook groups.
 */
function preToolCommands(harness, value) {
  if (!value.hooks || typeof value.hooks !== 'object') return [];
  /** @type {string[]} */
  const commands = [];
  for (const [event, entries] of Object.entries(value.hooks)) {
    if (!harness.isPreTool(event) || !Array.isArray(entries)) continue;
    for (const entry of entries) collectCommands(entry, commands);
  }
  return commands;
}

/**
 * Appends command strings from one hook entry, including nested hook groups.
 *
 * Claude-shaped groups store the command inside `hooks`. Cursor stores it on the entry itself. Both shapes are collected.
 *
 * @param {unknown} entry One hook entry or hook group.
 * @param {string[]} commands Destination list. Matching `command`, `bash`, and `powershell` strings are appended.
 * @returns {void} No value. `commands` is updated in place.
 */
function collectCommands(entry, commands) {
  if (!entry || typeof entry !== 'object') return;
  for (const field of ['command', 'bash', 'powershell']) {
    if (typeof entry[field] === 'string') commands.push(entry[field]);
  }
  if (Array.isArray(entry.hooks)) {
    for (const hook of entry.hooks) collectCommands(hook, commands);
  }
}

/**
 * Lists the user scope and, when one exists, the project scope.
 *
 * Both scopes can contain hooks that run in one agent session. Order repair checks each of them.
 *
 * @param {object} options
 * @param {string} [options.projectDir] Explicit project directory. It is used instead of searching for a Git root.
 * @param {string} [options.cwd] Directory used to find a Git root when `projectDir` is omitted.
 * @returns {Array<{projectDir?: string}>} The user scope, then the project scope when a project directory is known.
 */
function scopesFor(options) {
  const project = options.projectDir || gitRoot(options.cwd);
  return [{ projectDir: undefined }, ...(project ? [{ projectDir: project }] : [])];
}

/**
 * Lists the hook chains whose order must be checked.
 *
 * A harness that also runs another harness, such as Cursor with Claude Code, is one chain. Each JSON harness is also checked alone. Extension harnesses are not part of these JSON chains.
 *
 * @param {object} options Location used to resolve each hook file. See {@link scopesFor}.
 * @returns {Array<{name: string, members: Array<{harness: string, file: string, projectDir?: string}>}>} Chains in user scope and project scope. `name` identifies the chain. `members` are the files in run order.
 */
function chainsFor(options) {
  /** @type {Array<{name: string, members: Array<{harness: string, file: string, projectDir?: string}>}>} */
  const chains = [];
  for (const scope of scopesFor(options)) {
    const member = (id) => ({
      harness: id,
      projectDir: scope.projectDir,
      file: getAdapter(id).file({ ...options, projectDir: scope.projectDir }),
    });
    for (const harness of adapters) {
      const extra = harness.alsoRuns();
      if (extra.length === 0) continue;
      chains.push({
        name: `${harness.id}:${scope.projectDir || 'user'}`,
        members: [member(harness.id), ...extra.map((id) => member(id))],
      });
    }
    for (const harness of adapters) {
      if (harness.kind !== 'json') continue;
      chains.push({ name: `${harness.id}:${scope.projectDir || 'user'}`, members: [member(harness.id)] });
    }
  }
  return chains;
}

/**
 * Classifies one pre-tool command for the hook-order check.
 *
 * An owned command contains the harness marker. An `rtk hook` command that runs later can strip the prefix and must be repaired. A cosplaying command without the marker is left unchanged because it may not be this install.
 *
 * @param {{harness: string, command: string}} item Harness id and one pre-tool command string.
 * @returns {'ours' | 'rtk' | 'unverified' | 'other'} `ours` for a marked command, `rtk` for an rtk hook, `unverified` for a cosplaying command without the marker, and `other` for every remaining command.
 */
function classify(item) {
  const harness = getAdapter(item.harness);
  if (item.command.includes(harness.marker())) return 'ours';
  if (/\brtk\s+hook\b/.test(item.command)) return 'rtk';
  if (/\b(?:cosplaying(?:\.js)?|main\.js)\b/.test(item.command) && /\bagent-hook\b/.test(item.command)) return 'unverified';
  return 'other';
}

/**
 * Reads the pre-tool commands in one hook chain.
 *
 * A file that cannot be parsed is recorded as a failure and does not stop the other files in the chain.
 *
 * @param {Array<{harness: string, file: string, projectDir?: string}>} members Chain members in the order the hooks run.
 * @returns {{items: object[], failures: object[]}} `items` are the pre-tool commands that were read. `failures` are files that could not be read, with `file`, `harness`, `projectDir`, and `message`.
 */
function inspectChain(members) {
  /** @type {object[]} */
  const items = [];
  /** @type {object[]} */
  const failures = [];
  for (const member of members) {
    let value;
    try {
      value = readJsonConfig(member.file);
    } catch (error) {
      failures.push({
        file: member.file,
        harness: member.harness,
        projectDir: member.projectDir,
        message: error.message,
      });
      continue;
    }
    const harness = getAdapter(member.harness);
    for (const command of preToolCommands(harness, value)) {
      items.push({ ...member, command });
    }
  }
  return { items, failures };
}

/**
 * Finds pre-tool commands that run after the last owned cosplaying hook.
 *
 * `rtk` in that position can remove the prefix, so the command is an issue that repair can move. An unverified cosplaying command in that position is reported and is not rewritten.
 *
 * @param {object[]} items Pre-tool commands in run order. Each item has `harness`, `file`, and `command`.
 * @returns {object[]} Items after the last owned hook that are `rtk` or `unverified`. Each item includes `kind` and `message`.
 */
function issuesIn(items) {
  let lastOurs = -1;
  items.forEach((item, index) => {
    if (classify(item) === 'ours') lastOurs = index;
  });
  /** @type {object[]} */
  const issues = [];
  items.forEach((item, index) => {
    const kind = classify(item);
    if (lastOurs < 0 || index <= lastOurs) return;
    if (kind !== 'unverified' && kind !== 'rtk') return;
    const message = kind === 'rtk'
      ? new CosplayError({
        name: 'harness',
        method: 'repairHookOrder',
        message: 'rtk hook runs after cosplaying in %s. Run cosplaying doctor --repair so the cosplaying hook is last, then retry the command. In Codex, trust the hooks again with /hooks.',
        args: [item.file],
      }).message
      : new CosplayError({
        name: 'harness',
        method: 'repairHookOrder',
        message: 'unverified cosplaying hook in %s. Remove that entry or run cosplaying install so the owned hook contains its # cosplaying:<harness> marker. This process will not rewrite a lookalike command.',
        args: [item.file],
      }).message;
    issues.push({ ...item, kind, message });
  });
  return issues;
}

/**
 * Moves owned hooks back to the end of a file when `rtk` was appended later.
 *
 * The cosplaying hook must run last so `rtk` cannot remove its prefix. A command that looks like cosplaying but has no marker is reported and left unchanged. A file that cannot be read is reported and left unchanged.
 *
 * @param {object} options Location used to find user and project hook files.
 * @param {string} [options.home] User home directory.
 * @param {string} [options.cwd] Directory used to find a Git root.
 * @param {string} [options.projectDir] Explicit project directory.
 * @param {NodeJS.ProcessEnv} [options.env] Environment passed through to install.
 * @param {string[]} [options.commands] Plugin commands passed through when a harness is reinstalled.
 * @returns {{repaired: string[], conflicts: object[], failures: object[]}} `repaired` lists files that were rewritten. `conflicts` are commands that still run after the owned hook. `failures` are files that could not be read or rewritten.
 */
export function repairHookOrder(options) {
  /** @type {string[]} */
  const repaired = [];
  /** @type {object[]} */
  const conflicts = [];
  /** @type {object[]} */
  const failures = [];
  const done = new Set();
  for (const chain of chainsFor(options)) {
    const first = inspectChain(chain.members);
    failures.push(...first.failures);
    const issues = issuesIn(first.items);
    for (const issue of issues) {
      if (issue.kind !== 'rtk') conflicts.push(issue);
    }
    for (const issue of issues.filter((item) => item.kind === 'rtk')) {
      const key = `${issue.harness}:${issue.projectDir || ''}`;
      if (done.has(key)) continue;
      done.add(key);
      try {
        installHarness(issue.harness, { ...options, projectDir: issue.projectDir, commands: options.commands || [] });
        repaired.push(issue.file);
      } catch (error) {
        failures.push({ file: issue.file, message: error.message });
      }
    }
    if (!issues.some((issue) => issue.kind === 'rtk')) continue;
    const second = inspectChain(chain.members);
    failures.push(...second.failures);
    conflicts.push(...issuesIn(second.items));
  }
  return {
    repaired: [...new Set(repaired)],
    conflicts: uniqueIssues(conflicts),
    failures: uniqueIssues(failures),
  };
}

/**
 * Drops repeated order-check issues.
 *
 * One file can appear in more than one chain. The report names each file and message once.
 *
 * @param {object[]} items Issues or failures. Each item may have `kind`, `file`, and `message`.
 * @returns {object[]} The first item for each `kind`, `file`, and `message` combination, in the original order.
 */
function uniqueIssues(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind || ''}:${item.file}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
