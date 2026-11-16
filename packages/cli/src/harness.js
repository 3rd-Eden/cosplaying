import { readFileSync } from 'node:fs';
import { findUpSync } from 'find-up';
import path from 'node:path';
import { LayerError } from '@mcp-layer/error';
import { readJsonConfig } from 'cosplaying/hooks';
import { adapters, getAdapter } from 'cosplaying/adapters';

const errorScope = 'cosplaying';
const errorDocs = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/**
 * @param {string} id
 * @returns {import('cosplaying/adapters').Harness}
 */
function requireAdapter(id) {
  const found = getAdapter(id);
  if (!found) throw new Error(`Unknown harness: ${id}`);
  return found;
}

/**
 * @param {string} start
 * @returns {string | undefined}
 */
export function gitRoot(start) {
  const found = findUpSync('.git', { cwd: start || process.cwd(), type: 'both' });
  return found ? path.dirname(found) : undefined;
}

/**
 * @param {string} id
 * @param {object} options
 * @returns {string}
 */
export function installHarness(id, options) {
  return requireAdapter(id).install(options);
}

/**
 * @param {string} id
 * @param {object} options
 * @returns {string}
 */
export function uninstallHarness(id, options) {
  return requireAdapter(id).uninstall(options);
}

/**
 * @param {string} file
 * @returns {string | null}
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
 * Installs or removes one harness. A failure is returned so the next harness still runs.
 * `changed` is false when the file bytes are unchanged, which is when writeJsonAtomic skips the write.
 * @param {string} id
 * @param {object} options
 * @param {boolean} remove
 * @returns {{harness: string, file: string, ok: boolean, changed: boolean, error?: unknown}}
 */
function applyHarness(id, options, remove) {
  let file = '';
  try {
    const harness = requireAdapter(id);
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
 * @param {object} options
 * @param {string[]} [harnesses]
 * @returns {Array<{harness: string, file: string, ok: boolean, changed: boolean, error?: unknown}>}
 */
export function installAll(options, harnesses = adapters.map((item) => item.id)) {
  return harnesses.map((id) => applyHarness(id, options, false));
}

/**
 * @param {object} options
 * @param {string[]} [harnesses]
 * @returns {Array<{harness: string, file: string, ok: boolean, changed: boolean, error?: unknown}>}
 */
export function uninstallAll(options, harnesses = adapters.map((item) => item.id)) {
  return harnesses.map((id) => applyHarness(id, options, true));
}

/**
 * @param {import('cosplaying/adapters').Harness} harness
 * @param {unknown} value
 * @returns {string[]}
 */
function preToolCommands(harness, value) {
  if (!value || typeof value !== 'object' || !('hooks' in value) || !value.hooks || typeof value.hooks !== 'object') return [];
  /** @type {string[]} */
  const commands = [];
  for (const [event, entries] of Object.entries(value.hooks)) {
    if (!harness.isPreTool(event) || !Array.isArray(entries)) continue;
    for (const entry of entries) collectCommands(entry, commands);
  }
  return commands;
}

/**
 * @param {unknown} entry
 * @param {string[]} commands
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
 * @param {object} options
 * @returns {{projectDir?: string}[]}
 */
function scopesFor(options) {
  const project = options.projectDir || gitRoot(options.cwd);
  return [{ projectDir: undefined }, ...(project ? [{ projectDir: project }] : [])];
}

/**
 * @param {object} options
 * @returns {Array<{name: string, members: Array<{harness: string, file: string, projectDir?: string}>}>}
 */
function chainsFor(options) {
  /** @type {Array<{name: string, members: Array<{harness: string, file: string, projectDir?: string}>}>} */
  const chains = [];
  for (const scope of scopesFor(options)) {
    const member = (id) => ({
      harness: id,
      projectDir: scope.projectDir,
      file: requireAdapter(id).file({ ...options, projectDir: scope.projectDir }),
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
 * @param {{harness: string, command: string}} item
 * @returns {'ours' | 'rtk' | 'unverified' | 'other'}
 */
function classify(item) {
  const harness = getAdapter(item.harness);
  if (harness && item.command.includes(harness.marker())) return 'ours';
  if (/\brtk\s+hook\b/.test(item.command)) return 'rtk';
  if (/\b(?:cosplaying(?:\.js)?|main\.js)\b/.test(item.command) && /\bagent-hook\b/.test(item.command)) return 'unverified';
  return 'other';
}

/**
 * @param {Array<{harness: string, file: string, projectDir?: string}>} members
 * @returns {{items: object[], failures: object[]}}
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
      if (error.code === 'ENOENT') continue;
      failures.push({
        file: member.file,
        harness: member.harness,
        projectDir: member.projectDir,
        message: error.message,
      });
      continue;
    }
    const harness = getAdapter(member.harness);
    if (!harness) continue;
    for (const command of preToolCommands(harness, value)) {
      items.push({ ...member, command });
    }
  }
  return { items, failures };
}

/**
 * @param {object[]} items
 * @returns {object[]}
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
      ? new LayerError({
        name: 'harness',
        scope: errorScope,
        docs: errorDocs,
        method: 'repairHookOrder',
        message: 'rtk hook runs after cosplaying in %s. Run cosplaying doctor --repair so the cosplaying hook is last, then retry the command. In Codex, trust the hooks again with /hooks.',
        args: [item.file],
      }).message
      : new LayerError({
        name: 'harness',
        scope: errorScope,
        docs: errorDocs,
        method: 'repairHookOrder',
        message: 'unverified cosplaying hook in %s. Remove that entry or run cosplaying install so the owned hook contains its # cosplaying:<harness> marker. This process will not rewrite a lookalike command.',
        args: [item.file],
      }).message;
    issues.push({ ...item, kind, message });
  });
  return issues;
}

/**
 * Moves owned hooks back to the end of a file when rtk was appended later.
 * Lookalike commands and unreadable files are reported and left unchanged.
 * @param {object} options
 * @returns {{repaired: string[], conflicts: object[], failures: object[]}}
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
 * @param {object[]} items
 * @returns {object[]}
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
