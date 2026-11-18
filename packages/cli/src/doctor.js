import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';
import { parse } from 'unbash';
import { readUtf8File } from 'cosplaying/hooks';
import { defaultSpawn, resolveRealBin } from 'cosplaying/plugin';
import { loadPlugins } from './plugins.js';
import { adapters, getAdapter } from 'cosplaying/adapters';
import { gitRoot, installHarness, repairHookOrder } from './harness.js';
import { cosplayingBinPath, packageVersion, realMainPath } from './paths.js';

/**
 * Checks hook files, plugin executables, and the `cosplaying` binary on `PATH`.
 *
 * User hooks are required. Project hooks are required when `--project-dir` was passed, and optional when doctor finds a Git root on its own. A missing agent executable is reported as information, not as a failure. `--repair` rewrites extension files and a Node path that no longer exists. A Node-path repair runs doctor once more without repair so the new file is checked.
 *
 * @param {object} options Runtime context and doctor flags.
 * @param {NodeJS.WritableStream} options.stdout Stream for repair notes and informational lines.
 * @param {NodeJS.WritableStream} options.stderr Stream for findings.
 * @param {NodeJS.ProcessEnv} options.env Environment used to resolve executables.
 * @param {NodeJS.Platform} [options.platform] Platform used to resolve executables.
 * @param {string} [options.cwd] Directory used to find a Git root.
 * @param {string} [options.home] Home directory used to find user hook files.
 * @param {string} [options.projectDir] Explicit project directory. Its hooks are required.
 * @param {boolean} [options.repair] True when files that doctor can regenerate should be rewritten.
 * @param {string} [options.bin] `cosplaying` executable that regenerated hooks should embed.
 * @returns {Promise<number>} `0` when there are no findings. `1` when one or more findings were printed.
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
    plugins = (await loadPlugins(options)).plugins;
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
 * Checks one Pi or OpenCode extension against the source this install would write.
 *
 * A required file that is missing is a finding. An optional missing file is ignored. A file without the ownership marker is not replaced. With `--repair`, a marked file that differs is regenerated.
 *
 * @param {string} file Extension path.
 * @param {import('cosplaying/adapters').ExtensionHarness} harness Adapter that can render the expected source.
 * @param {string[]} commands Plugin command names embedded in the expected source.
 * @param {boolean} required True when a missing file is a finding.
 * @param {object} options Doctor options. `repair` rewrites a mismatch. `bin` is embedded in the new source. `stdout` receives the repair line.
 * @param {string[]} findings Finding messages. This function appends to the list.
 * @param {string | undefined} projectDir Project directory for a repair install. Undefined for the user scope.
 * @param {{n: number}} managed Counter of managed installs that were checked. It is incremented when the file contains the marker.
 * @returns {void} No value. Results are appended to `findings` or written to stdout.
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
        findings.push(new CosplayError({
          name: 'doctor',
          method: 'inspectExtension',
          message: 'missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.',
          args: [file],
        }).message);
      }
      return;
    }
    if (error instanceof CosplayError) {
      findings.push(error.message);
      return;
    }
    const message = error.message;
    findings.push(new CosplayError({
      name: 'hooks',
      method: 'inspectExtension',
      message: 'could not read %s: %s. Fix the permissions on that file, or move it aside and run cosplaying install again.',
      args: [file, message],
    }).message);
    return;
  }
  if (!current.includes(harness.marker())) {
    findings.push(new CosplayError({
      name: 'hooks',
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
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectExtension',
      message: 'hook file %s does not match the current Node path or plugin commands. Run cosplaying doctor --repair to regenerate that Pi or OpenCode extension.',
      args: [file],
    }).message);
  }
}

/**
 * Checks one JSON hook file for this harness's owned commands.
 *
 * The file must be UTF-8 JSON with an object root. Every event the harness registers must contain an owned command. Each owned command is then checked by {@link inspectCommand}.
 *
 * @param {string} file Settings path.
 * @param {import('cosplaying/adapters').Harness} harness Adapter whose marker and events are required.
 * @param {boolean} required True when a missing file or a file with no owned hook is a finding.
 * @param {object} options Doctor options passed through to command inspection.
 * @param {string[]} findings Finding messages. This function appends to the list.
 * @param {Map<string, object>} probeCache Version and help results keyed by executable, so one binary is spawned once.
 * @param {object[]} plugins Loaded plugins. Their commands and examples must appear in `--help`.
 * @param {string | undefined} projectDir Project directory for a repair install.
 * @param {string[]} commands Plugin command names passed to a repair install.
 * @param {{n: number}} managed Counter of managed installs. It is incremented when the file has at least one owned command.
 * @param {Array<{harness: string, file: string}>} nodeRepairs Files whose Node path was repaired. Doctor prints the retrust note for these harnesses.
 * @returns {void} No value. Results are appended to `findings` or `nodeRepairs`.
 */
function inspectJsonHooks(file, harness, required, options, findings, probeCache, plugins, projectDir, commands, managed, nodeRepairs) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    const code = error.code;
    if (code === 'ENOENT') {
      if (required) {
        findings.push(new CosplayError({
          name: 'doctor',
          method: 'inspectJsonHooks',
          message: 'missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.',
          args: [file],
        }).message);
      }
      return;
    }
    const message = error.message;
    findings.push(new CosplayError({
      name: 'hooks',
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
    findings.push(new CosplayError({
      name: 'hooks',
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
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectJsonHooks',
      message: 'invalid config %s: %s. Fix the JSON, or move the file aside and run cosplaying install again.',
      args: [file, message],
    }).message);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    findings.push(new CosplayError({
      name: 'hooks',
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
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectJsonHooks',
      message: 'missing owned hook in %s. Run cosplaying install for the user scope, or cosplaying install --project-dir <dir> for a project.',
      args: [file],
    }).message);
    return;
  }
  managed.n += 1;
  const present = ownedEvents(parsed, owner);
  for (const event of harness.events()) {
    if (!present.has(event)) {
      findings.push(new CosplayError({
        name: 'doctor',
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
 * Lists the hook events that contain a command owned by this install.
 *
 * Doctor requires every event the harness registers to appear in this set.
 *
 * @param {unknown} value Parsed settings object.
 * @param {string} owner Marker text that identifies this install's commands.
 * @returns {Set<string>} Event names whose entries include `owner`. An empty set when `hooks` is missing or is not an object.
 */
function ownedEvents(value, owner) {
  /** @type {Set<string>} */
  const found = new Set();
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
 * Appends command strings that contain the ownership marker.
 *
 * Nested objects and arrays are searched. A command that does not contain the marker is ignored, so foreign hooks are not probed.
 *
 * @param {unknown} value Settings value, entry, or list of entries.
 * @param {string} owner Marker text that must appear in an owned command.
 * @param {string[]} commands Destination list. Matching `command`, `bash`, and `powershell` strings are appended.
 * @returns {void} No value. `commands` is updated in place.
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
 * Returns the program name from a hook executable path.
 *
 * Doctor uses it to recognize `node` and `cosplaying` without comparing the whole path first.
 *
 * @param {string} value Executable path or name from the hook command.
 * @returns {string} Final path segment with a trailing `.exe`, `.cmd`, or `.bat` removed.
 */
function executableBase(value) {
  return path.basename(value).replace(/\.(?:exe|cmd|bat)$/i, '');
}

/**
 * Reports whether two paths name the same file after symlinks are resolved.
 *
 * A hook may point at a symlink of this install. The canonical paths are compared. A path that cannot be resolved does not match.
 *
 * @param {string} left First path. An empty string does not match.
 * @param {string} right Second path. An empty string does not match.
 * @returns {boolean} True when both canonical paths are equal.
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
 * Reports whether doctor may spawn a hook executable to read `--version`.
 *
 * The probe is allowed for this install's Node script, a program named `cosplaying`, or this package's bin. Any other absolute path is not spawned.
 *
 * @param {string} executable First word of the hook command.
 * @param {string | undefined} script Script argument when the executable is Node. Undefined for a direct `cosplaying` command.
 * @returns {boolean} True when the executable is this install or a `cosplaying` basename.
 */
function canProbe(executable, script) {
  const base = executableBase(executable);
  if (script) return base === 'node' && sameFile(script, realMainPath());
  if (base === 'cosplaying') return true;
  return sameFile(executable, cosplayingBinPath());
}

/**
 * Checks one owned hook command and, when allowed, runs `--version` and `--help`.
 *
 * The command must be a direct `agent-hook` invocation for this harness, with no pipes or redirects. The executable must be this install. `--version` must print this package version. `--help` must list the built-in commands and each plugin command and example. A missing Node executable is reinstalled when `--repair` is set.
 *
 * @param {string} command Hook command string from the settings file.
 * @param {string} harness Harness id that must appear after `agent-hook`.
 * @param {string} file Settings file that contains the command. It is named in findings.
 * @param {object} options Doctor options. `repair` rewrites a missing Node path. `env` and `cwd` are used for the version probe.
 * @param {string[]} findings Finding messages. This function appends to the list.
 * @param {Map<string, object>} probeCache Cache of `{ version, help }` spawn results for one executable.
 * @param {object[]} plugins Plugins whose help lines and examples must be present.
 * @param {string | undefined} projectDir Project directory passed to a repair install.
 * @param {string[]} commands Plugin command names passed to a repair install.
 * @param {Array<{harness: string, file: string}>} nodeRepairs Repaired Node paths. One file is repaired once.
 * @returns {void} No value. Results are appended to `findings` or `nodeRepairs`.
 */
function inspectCommand(command, harness, file, options, findings, probeCache, plugins, projectDir, commands, nodeRepairs) {
  let tree;
  try {
    tree = parse(command);
  } catch (error) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: could not parse hook command: %s. Run cosplaying install to rewrite the owned hook. Do not hand-edit the command string.',
      args: [file, error.message],
    }).message);
    return;
  }
  const statement = tree.commands?.length === 1 ? tree.commands[0] : null;
  const node = statement?.type === 'Statement' ? statement.command : null;
  if (!node || node.type !== 'Command' || statement.redirects?.length || node.redirects?.length) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook command must be a direct invocation. Run cosplaying install so the owned hook is one command with no pipes, lists, or redirects.',
      args: [file],
    }).message);
    return;
  }
  if (node.prefix.length > 0) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook command must be a direct invocation. Run cosplaying install so the owned hook is one command with no pipes, lists, or redirects.',
      args: [file],
    }).message);
    return;
  }
  const words = [node.name, ...node.suffix].filter((word) => word).map((word) => word.value ?? word.text ?? '');
  const agent = words.indexOf('agent-hook');
  if (agent < 1 || words[agent + 1] !== harness || !words[agent + 2]) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook command must invoke agent-hook %s <event>. Run cosplaying install to rewrite the hook as node, the main script, agent-hook, the harness id, and the event.',
      args: [file, harness],
    }).message);
    return;
  }
  if (words.length !== agent + 3) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook command has unexpected arguments. Run cosplaying install to drop the extra arguments from the owned hook.',
      args: [file],
    }).message);
    return;
  }
  const executable = words[0];
  const script = agent === 2 ? words[1] : undefined;
  if (agent === 2 && executableBase(executable) !== 'node') {
    findings.push(new CosplayError({
      name: 'doctor',
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
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook executable does not exist: %s. Run cosplaying doctor --repair to reinstall the hook with the current Node executable.',
      args: [file, executable],
    }).message);
    return;
  }
  if (script) {
    if (path.isAbsolute(script) && !existsSync(script)) {
      findings.push(new CosplayError({
        name: 'doctor',
        method: 'inspectCommand',
        message: '%s: hook script does not exist: %s. Run cosplaying install so the hook points at this package\'s main.js.',
        args: [file, script],
      }).message);
      return;
    }
    if (existsSync(script) && realpathSync(script) !== realMainPath()) {
      findings.push(new CosplayError({
        name: 'doctor',
        method: 'inspectCommand',
        message: '%s: hook script is a different cosplaying install. Run cosplaying install from the install you want the harness to use.',
        args: [file],
      }).message);
      return;
    }
  }
  if (!canProbe(executable, script)) {
    findings.push(new CosplayError({
      name: 'doctor',
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
    const spawnOptions = { encoding: 'utf8', timeout: 15000, cwd: options.cwd, env: options.env };
    const version = defaultSpawn(executable, [...args, '--version'], spawnOptions);
    const help = defaultSpawn(executable, [...args, '--help'], spawnOptions);
    probe = { version, help };
    probeCache.set(cacheKey, probe);
  }
  if (!probe.version || probe.version.status !== 0 || (probe.version.stdout || '').trim() !== packageVersion()) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook --version did not match %s. Run cosplaying install so the hook uses this package version.',
      args: [file, packageVersion()],
    }).message);
    return;
  }
  if (!probe.help || probe.help.status !== 0) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'inspectCommand',
      message: '%s: hook --help failed. Run the hook executable with --help, fix the error it prints, then run cosplaying doctor again.',
      args: [file],
    }).message);
    return;
  }
  const lines = (probe.help.stdout || '').split('\n');
  for (const name of ['hook', 'agent-hook', 'rewrite', 'install', 'uninstall', 'doctor', 'plugin']) {
    if (!lines.some((line) => new RegExp(`^\\s+${name}\\b`).test(line))) {
      findings.push(new CosplayError({
        name: 'doctor',
        method: 'inspectCommand',
        message: '%s: hook --help is missing %s. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.',
        args: [file, name],
      }).message);
    }
  }
  for (const plugin of plugins || []) {
    const index = lines.findIndex((line) => new RegExp(`^\\s+${plugin.command}\\b`).test(line));
    if (index < 0) {
      findings.push(new CosplayError({
        name: 'doctor',
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
        findings.push(new CosplayError({
          name: 'doctor',
          method: 'inspectCommand',
          message: '%s: hook --help is missing %s. Update --help so the command is a line indented two spaces, with examples indented four spaces, then run cosplaying doctor again.',
          args: [file, `${plugin.command} example`],
        }).message);
      }
    }
  }
}

/**
 * Compares the `cosplaying` executable on `PATH` with this package version.
 *
 * An unrecognized binary is not spawned. A missing `cosplaying` on `PATH` is not a finding, because the hooks can invoke Node and `main.js` directly.
 *
 * @param {object} options Doctor options. `env`, `platform`, and `cwd` are used to resolve and spawn the executable.
 * @param {string[]} findings Finding messages. A version mismatch is appended.
 * @returns {void} No value.
 */
function checkPathVersion(options, findings) {
  const resolved = resolveRealBin('cosplaying', { env: options.env, platform: options.platform, cliPaths: [] });
  if (!resolved.bin || !canProbe(resolved.bin)) return;
  let result;
  try {
    result = defaultSpawn(resolved.bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    const message = error.message;
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'checkPathVersion',
      message: 'PATH: version %s differs from %s. Update the cosplaying executable on PATH so it matches this install.',
      args: [message, packageVersion()],
    }).message);
    return;
  }
  const got = (result?.stdout || '').trim();
  if (!result || result.status !== 0 || got !== packageVersion()) {
    findings.push(new CosplayError({
      name: 'doctor',
      method: 'checkPathVersion',
      message: 'PATH: version %s differs from %s. Update the cosplaying executable on PATH so it matches this install.',
      args: [got || '(empty)', packageVersion()],
    }).message);
  }
}
