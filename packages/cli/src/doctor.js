import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { LayerError } from '@mcp-layer/error';
import { parse } from 'unbash';
import { loadConfig } from './config.js';
import { readUtf8File } from 'cosplaying/hooks';
import { loadConfiguredPlugins, resolveRealBin } from 'cosplaying/plugin';
import { adapters, getAdapter } from 'cosplaying/adapters';
import { gitRoot, installHarness, repairHookOrder } from './harness.js';
import { cosplayingBinPath, packageVersion, realMainPath } from './paths.js';

const errorScope = 'cosplaying';
const errorDocs = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/**
 * @param {object} options
 * @returns {Promise<number>}
 */
export async function runDoctor(options) {
  const findings = [];
  const info = [];
  const repair = repairHookOrder(options);
  for (const file of repair.repaired) options.stdout.write(`cosplaying doctor: repaired hook order in ${file}\n`);
  for (const issue of [...repair.conflicts, ...repair.failures]) findings.push(issue.message || issue.file);

  for (const harness of adapters) {
    const resolved = resolveRealBin(harness.binary, { env: options.env, platform: options.platform, cliPaths: [] });
    if (!resolved.bin) info.push(`${harness.id} executable not found`);
  }

  let plugins = [];
  try {
    const config = loadConfig(options);
    plugins = await loadConfiguredPlugins(config.plugins, options);
    for (const plugin of plugins) {
      if (plugin.descriptor.intercept === false) continue;
      const resolved = resolveRealBin(plugin.command, { env: options.env, platform: options.platform, cliPaths: [realMainPath()] });
      if (!resolved.bin) findings.push(resolved.error || `${plugin.command} executable not found`);
    }
  } catch (error) {
    findings.push(error.message);
  }

  const commands = plugins.filter((plugin) => plugin.descriptor.intercept !== false).map((plugin) => plugin.command);
  const probeCache = new Map();
  const project = options.projectDir || gitRoot(options.cwd);
  const scopes = [{ projectDir: undefined, required: true }];
  if (options.projectDir) scopes.push({ projectDir: options.projectDir, required: true });
  else if (project) scopes.push({ projectDir: project, required: false });
  const managed = { n: 0 };
  /** @type {Array<{harness: string, file: string}>} */
  const nodeRepairs = [];

  for (const harness of adapters) {
    for (const scope of scopes) {
      const file = harness.file({ ...options, projectDir: scope.projectDir });
      if (harness.kind === 'extension') {
        inspectExtension(file, harness, commands, scope.required, options, findings, scope.projectDir, managed);
        continue;
      }
      inspectJsonHooks(file, harness, scope.required, options, findings, probeCache, plugins, scope.projectDir, commands, managed, nodeRepairs);
    }
  }

  if (nodeRepairs.length) {
    const seen = new Set();
    for (const item of nodeRepairs) {
      const note = getAdapter(item.harness)?.retrustNote() || '';
      if (!note || seen.has(note)) continue;
      seen.add(note);
      options.stdout.write(note);
    }
    return runDoctor({ ...options, repair: false });
  }

  for (const line of info) options.stdout.write(`cosplaying doctor: ${line}\n`);
  checkPathVersion(options, findings);
  if (findings.length) {
    for (const finding of findings) options.stderr.write(`cosplaying doctor: ${finding}\n`);
    return 1;
  }
  const label = managed.n === 1 ? 'install' : 'installs';
  options.stdout.write(`cosplaying doctor: no findings (${managed.n} managed ${label} checked)\n`);
  return 0;
}

/**
 * @param {string} file
 * @param {import('cosplaying/adapters').ExtensionHarness} harness
 * @param {string[]} commands
 * @param {boolean} required
 * @param {object} options
 * @param {string[]} findings
 * @param {string | undefined} projectDir
 * @param {{n: number}} managed
 */
function inspectExtension(file, harness, commands, required, options, findings, projectDir, managed) {
  const expected = harness.render(commands, options.bin);
  let current;
  try {
    current = readUtf8File(file);
  } catch (error) {
    const code = error.code;
    if (code === 'ENOENT') {
      if (required) {
        findings.push(new LayerError({
          name: 'doctor',
          scope: errorScope,
          docs: errorDocs,
          method: 'inspectExtension',
          message: 'missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.',
          args: [file],
        }).message);
      }
      return;
    }
    if (error instanceof LayerError) {
      findings.push(error.message);
      return;
    }
    const message = error.message;
    findings.push(new LayerError({
      name: 'hooks',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectExtension',
      message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
      args: [file, message],
    }).message);
    return;
  }
  if (!current.includes(harness.marker())) {
    findings.push(new LayerError({
      name: 'hooks',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectExtension',
      message: 'refusing to replace unmanaged hook file %s. Move the file aside or add the cosplaying marker comment, then run cosplaying install again.',
      args: [file],
    }).message);
    return;
  }
  managed.n += 1;
  if (current !== expected) {
    if (options.repair) {
      try {
        installHarness(harness.id, { ...options, projectDir, commands });
        options.stdout.write(`cosplaying doctor: repaired ${file}\n`);
        return;
      } catch (error) {
        findings.push(error.message);
        return;
      }
    }
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectExtension',
      message: 'hook file %s does not match the current Node path or plugin commands. Run cosplaying doctor --repair to regenerate that Pi or OpenCode extension.',
      args: [file],
    }).message);
  }
}

/**
 * @param {string} file
 * @param {import('cosplaying/adapters').Harness} harness
 * @param {boolean} required
 * @param {object} options
 * @param {string[]} findings
 * @param {Map<string, object>} probeCache
 * @param {object[]} plugins
 * @param {string | undefined} projectDir
 * @param {string[]} commands
 * @param {{n: number}} managed
 * @param {Array<{harness: string, file: string}>} nodeRepairs
 */
function inspectJsonHooks(file, harness, required, options, findings, probeCache, plugins, projectDir, commands, managed, nodeRepairs) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    const code = error.code;
    if (code === 'ENOENT') {
      if (required) {
        findings.push(new LayerError({
          name: 'doctor',
          scope: errorScope,
          docs: errorDocs,
          method: 'inspectJsonHooks',
          message: 'missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.',
          args: [file],
        }).message);
      }
      return;
    }
    const message = error.message;
    findings.push(new LayerError({
      name: 'hooks',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectJsonHooks',
      message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
      args: [file, message],
    }).message);
    return;
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    findings.push(new LayerError({
      name: 'hooks',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectJsonHooks',
      message: 'invalid config %s: file is not valid UTF-8. Replace the file with UTF-8 JSON, or move it aside and run cosplaying install again.',
      args: [file],
    }).message);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    const message = error.message;
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectJsonHooks',
      message: 'invalid config %s: %s. Fix the JSON, or move the file aside and run cosplaying install again.',
      args: [file, message],
    }).message);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    findings.push(new LayerError({
      name: 'hooks',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectJsonHooks',
      message: 'invalid config %s: config must contain a top-level object. Replace the file with a JSON object, or move it aside and run cosplaying install again.',
      args: [file],
    }).message);
    return;
  }
  const owner = harness.marker();
  const listed = [];
  collectOwned(parsed, owner, listed);
  if (listed.length === 0) {
    if (required || existsSync(file)) {
      findings.push(new LayerError({
        name: 'doctor',
        scope: errorScope,
        docs: errorDocs,
        method: 'inspectJsonHooks',
        message: 'missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.',
        args: [file],
      }).message);
    }
    return;
  }
  managed.n += 1;
  const present = ownedEvents(parsed, owner);
  for (const event of harness.events()) {
    if (!present.has(event)) {
      findings.push(new LayerError({
        name: 'doctor',
        scope: errorScope,
        docs: errorDocs,
        method: 'inspectJsonHooks',
        message: 'missing managed %s hook in %s. Run cosplaying install for that harness so the missing event is written.',
        args: [event, file],
      }).message);
    }
  }
  for (const command of listed) {
    inspectCommand(command, harness.id, file, options, findings, probeCache, plugins, projectDir, commands, nodeRepairs);
  }
}

/**
 * @param {unknown} value
 * @param {string} owner
 * @returns {Set<string>}
 */
function ownedEvents(value, owner) {
  /** @type {Set<string>} */
  const found = new Set();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return found;
  const hooks = value.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return found;
  for (const [event, entries] of Object.entries(hooks)) {
    const commands = [];
    collectOwned(entries, owner, commands);
    if (commands.length) found.add(event);
  }
  return found;
}

/**
 * @param {unknown} value
 * @param {string} owner
 * @param {string[]} commands
 */
function collectOwned(value, owner, commands) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectOwned(entry, owner, commands);
    return;
  }
  for (const field of ['command', 'bash', 'powershell']) {
    if (typeof value[field] === 'string' && value[field].includes(owner)) commands.push(value[field]);
  }
  for (const entry of Object.values(value)) collectOwned(entry, owner, commands);
}

/**
 * @param {string} value
 * @returns {string}
 */
function executableBase(value) {
  return path.basename(value).replace(/\.exe$/i, '');
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameFile(left, right) {
  if (!left || !right) return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * A version probe is allowed for this install's node script, a cosplaying basename, or this package's bin.
 * @param {string} executable
 * @param {string | undefined} script
 * @returns {boolean}
 */
function canProbe(executable, script) {
  const base = executableBase(executable);
  if (script) return base === 'node' && sameFile(script, realMainPath());
  if (base === 'cosplaying') return true;
  return sameFile(executable, cosplayingBinPath());
}

/**
 * @param {string} command
 * @param {string} harness
 * @param {string} file
 * @param {object} options
 * @param {string[]} findings
 * @param {Map<string, object>} probeCache
 * @param {object[]} plugins
 * @param {string | undefined} projectDir
 * @param {string[]} commands
 * @param {Array<{harness: string, file: string}>} nodeRepairs
 */
function inspectCommand(command, harness, file, options, findings, probeCache, plugins, projectDir, commands, nodeRepairs) {
  let tree;
  try {
    tree = parse(command);
  } catch (error) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: could not parse hook command: %s. Run cosplaying install to rewrite the owned hook. Do not hand-edit the command string.',
      args: [file, error.message],
    }).message);
    return;
  }
  const statement = tree.commands?.length === 1 ? tree.commands[0] : null;
  const node = statement?.type === 'Statement' ? statement.command : null;
  if (!node || node.type !== 'Command' || statement.redirects?.length || node.redirects?.length) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook command must be a direct invocation. Run cosplaying install so the owned hook is one command with no pipes, lists, or redirects.',
      args: [file],
    }).message);
    return;
  }
  if (node.prefix.length > 0) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook command must be a direct invocation. Run cosplaying install so the owned hook is one command with no pipes, lists, or redirects.',
      args: [file],
    }).message);
    return;
  }
  const words = [node.name, ...node.suffix].filter((word) => word).map((word) => word.value ?? word.text ?? '');
  const agent = words.indexOf('agent-hook');
  if (agent < 1 || words[agent + 1] !== harness || !words[agent + 2]) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook command must invoke agent-hook %s <event>. Run cosplaying install to rewrite the hook as node, the main script, agent-hook, the harness id, and the event.',
      args: [file, harness],
    }).message);
    return;
  }
  if (words.length !== agent + 3) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook command has unexpected arguments. Run cosplaying install to drop the extra arguments from the owned hook.',
      args: [file],
    }).message);
    return;
  }
  const executable = words[0];
  const script = agent === 2 ? words[1] : undefined;
  if (agent === 2 && executableBase(executable) !== 'node') {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: unexpected executable %s. Run cosplaying install so the hook starts with node and this package\'s main.js, or with the cosplaying executable.',
      args: [file, executable],
    }).message);
    return;
  }
  if (path.isAbsolute(executable) && !existsSync(executable)) {
    if (options.repair && executableBase(executable) === 'node') {
      if (!nodeRepairs.some((item) => item.file === file)) {
        try {
          installHarness(harness, { ...options, projectDir, commands: commands || options.commands || [] });
          options.stdout.write(`cosplaying doctor: repaired ${file}\n`);
          nodeRepairs.push({ harness, file });
        } catch (error) {
          findings.push(error.message);
        }
      }
      return;
    }
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook executable does not exist: %s. Run cosplaying doctor --repair to reinstall the hook with the current Node executable.',
      args: [file, executable],
    }).message);
    return;
  }
  if (script) {
    if (path.isAbsolute(script) && !existsSync(script)) {
      findings.push(new LayerError({
        name: 'doctor',
        scope: errorScope,
        docs: errorDocs,
        method: 'inspectCommand',
        message: '%s: hook script does not exist: %s. Run cosplaying install so the hook points at this package\'s main.js.',
        args: [file, script],
      }).message);
      return;
    }
    if (existsSync(script) && realpathSync(script) !== realMainPath()) {
      findings.push(new LayerError({
        name: 'doctor',
        scope: errorScope,
        docs: errorDocs,
        method: 'inspectCommand',
        message: '%s: hook script is a different cosplaying install. Run cosplaying install from the install you want the harness to use.',
        args: [file],
      }).message);
      return;
    }
  }
  if (!canProbe(executable, script)) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: unexpected executable %s. Run cosplaying install so the hook starts with node and this package\'s main.js, or with the cosplaying executable.',
      args: [file, executable],
    }).message);
    return;
  }
  const args = script ? [script] : [];
  const cacheKey = `${executable}\0${script || ''}`;
  let probe = probeCache.get(cacheKey);
  if (!probe) {
    const spawn = options.spawnImpl || spawnSync;
    const spawnOptions = { encoding: 'utf8', timeout: 15000, cwd: options.cwd, env: options.env };
    const version = spawn(executable, [...args, '--version'], spawnOptions);
    const help = spawn(executable, [...args, '--help'], spawnOptions);
    probe = { version, help };
    probeCache.set(cacheKey, probe);
  }
  if (!probe.version || probe.version.status !== 0 || (probe.version.stdout || '').trim() !== packageVersion()) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook --version did not match %s. Run cosplaying install so the hook uses this package version.',
      args: [file, packageVersion()],
    }).message);
    return;
  }
  if (!probe.help || probe.help.status !== 0) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'inspectCommand',
      message: '%s: hook --help failed. Run the hook executable with --help, fix the error it prints, then run cosplaying doctor again.',
      args: [file],
    }).message);
    return;
  }
  const lines = (probe.help.stdout || '').split('\n');
  for (const name of ['hook', 'agent-hook', 'rewrite', 'install', 'uninstall', 'doctor', 'plugin']) {
    if (!lines.some((line) => new RegExp(`^\\s+${name}\\b`).test(line))) {
      findings.push(new LayerError({
        name: 'doctor',
        scope: errorScope,
        docs: errorDocs,
        method: 'inspectCommand',
        message: '%s: hook --help is missing %s. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.',
        args: [file, name],
      }).message);
    }
  }
  for (const plugin of plugins || []) {
    const index = lines.findIndex((line) => new RegExp(`^\\s+${plugin.command}\\b`).test(line));
    if (index < 0) {
      findings.push(new LayerError({
        name: 'doctor',
        scope: errorScope,
        docs: errorDocs,
        method: 'inspectCommand',
        message: '%s: hook --help is missing %s. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.',
        args: [file, plugin.command],
      }).message);
      continue;
    }
    const examples = lines.slice(index + 1).filter((line) => line.startsWith('    '));
    const declared = plugin.descriptor.examples;
    for (const example of declared) {
      if (!examples.includes(`    ${example}`)) {
        findings.push(new LayerError({
          name: 'doctor',
          scope: errorScope,
          docs: errorDocs,
          method: 'inspectCommand',
          message: '%s: hook --help is missing %s. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.',
          args: [file, `${plugin.command} example`],
        }).message);
      }
    }
  }
}

/**
 * Version-check a PATH entry named cosplaying. Unrecognized binaries are not spawned.
 * @param {object} options
 * @param {string[]} findings
 */
function checkPathVersion(options, findings) {
  const resolved = resolveRealBin('cosplaying', { env: options.env, platform: options.platform, cliPaths: [] });
  if (!resolved.bin || !canProbe(resolved.bin)) return;
  const spawn = options.spawnImpl || spawnSync;
  let result;
  try {
    result = spawn(resolved.bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    const message = error.message;
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'checkPathVersion',
      message: 'PATH: version %s differs from %s. Update the cosplaying executable on PATH so it matches this install.',
      args: [message, packageVersion()],
    }).message);
    return;
  }
  const got = (result?.stdout || '').trim();
  if (!result || result.status !== 0 || got !== packageVersion()) {
    findings.push(new LayerError({
      name: 'doctor',
      scope: errorScope,
      docs: errorDocs,
      method: 'checkPathVersion',
      message: 'PATH: version %s differs from %s. Update the cosplaying executable on PATH so it matches this install.',
      args: [got || '(empty)', packageVersion()],
    }).message);
  }
}
