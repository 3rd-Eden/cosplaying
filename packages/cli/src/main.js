import { Command } from 'commander';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIdentity } from 'cosplaying/attribution';
import {
  defaultSpawn,
  installPlugin,
  listPlugins,
  resolveRealBin,
  uninstallPlugin,
} from 'cosplaying/plugin';
import { bundledPlugins } from './bundled.js';
import { disableBundledPlugin, enableBundledPlugin } from './enable.js';
import { loadPlugins } from './plugins.js';
import { attributionApi, runAgentHook } from './agent-hook.js';
import { runDoctor } from './doctor.js';
import { adapters, getAdapter } from 'cosplaying/adapters';
import { gitRoot, installAll, installHarness, uninstallAll } from './harness.js';
import { commandPrefix, packageVersion, realMainPath } from './paths.js';
import { CosplayError } from 'cosplaying/errors';
import { rewriteModelFlags, rewriteShellCommand } from './shell.js';

const CORE_HELP = [
  ['hook', 'Run a wrapped command'],
  ['agent-hook', 'Handle a harness hook event'],
  ['rewrite', 'Print a rewritten shell command'],
  ['install', 'Install harness hooks'],
  ['uninstall', 'Remove harness hooks'],
  ['doctor', 'Check hooks, plugins, and config'],
  ['plugin', 'Install, uninstall, list, enable, or disable plugins'],
];

/**
 * Builds the help text for this CLI.
 *
 * The built-in commands are listed first. Plugin commands and their examples follow, so `cosplaying --help` shows the commands the agent may wrap.
 *
 * @param {Array<{command: string, descriptor: {description: string, examples: string[]}}>} [plugins=[]] Loaded plugins. Each descriptor supplies the help line and the example lines.
 * @returns {string} Help text ending with a newline.
 */
export function renderHelp(plugins = []) {
  const lines = ['cosplaying', ''];
  for (const [name, description] of CORE_HELP) lines.push(`  ${name}  ${description}`);
  const extra = pluginHelp(plugins);
  return extra ? `${lines.join('\n')}\n${extra}` : `${lines.join('\n')}\n`;
}

/**
 * Builds the error text for a harness id this CLI does not know.
 *
 * Install and model resolution use it when `--harness` or `--agent` names something other than the six supported agents.
 *
 * @param {string} id Harness id from the command line.
 * @returns {string} Error text that lists the supported harness ids.
 */
export function unknownHarness(id) {
  return new CosplayError({
    name: 'cli',
    method: 'install',
    message: 'unknown harness %s. Supported harnesses: %s. Run cosplaying install --harness <name> with one of those harness names.',
    args: [id, adapters.map((item) => item.id).join(', ')],
  }).message;
}

/**
 * Writes one CLI error line to stderr.
 *
 * The line starts with `cosplaying:` so the agent can tell this failure from the wrapped command's own output. A message that already ends with a newline is not given a second one.
 *
 * @param {{write: (chunk: string) => void}} stderr Stream that receives the line.
 * @param {string} message Error text. A trailing newline is added when it is missing.
 * @returns {void} No value.
 */
function report(stderr, message) {
  stderr.write(`cosplaying: ${message.endsWith('\n') ? message : `${message}\n`}`);
}

/**
 * Builds the plugin section of the help text.
 *
 * Doctor checks that `--help` contains each plugin command indented two spaces and each example indented four spaces.
 *
 * @param {Array<{command: string, descriptor: {description?: string, examples?: string[]}}>} plugins Loaded plugins.
 * @returns {string} A `Plugins:` section ending with a newline. An empty string when there are no plugins.
 */
function pluginHelp(plugins) {
  if (!plugins.length) return '';
  const lines = ['', 'Plugins:'];
  for (const plugin of plugins) {
    const description = plugin.descriptor.description;
    lines.push(`  ${plugin.command}  ${description}`);
    for (const example of plugin.descriptor.examples) lines.push(`    ${example}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parses argv and runs one cosplaying command.
 *
 * The commands are `hook`, `agent-hook`, `rewrite`, `install`, `uninstall`, `doctor`, and `plugin`. No arguments print help and exit with status 2.
 *
 * @param {object} [options] Wrapper settings and runtime options.
 * @param {object} [options.defaults] Wrapper defaults in the same format as a settings file.
 * @param {string | URL} [options.entrypoint] Path or file URL of the wrapper script to run with Node.
 * @param {NodeJS.WritableStream} [options.stdout] Stream for help and command output. The process stdout is used when this is omitted.
 * @param {NodeJS.WritableStream} [options.stderr] Stream for errors. The process stderr is used when this is omitted.
 * @param {NodeJS.ProcessEnv} [options.env] Environment for settings, plugins, and model lookup.
 * @param {string} [options.cwd] Working directory for project settings and Git root lookup.
 * @param {string} [options.home] Home directory for user settings and harness files.
 * @param {NodeJS.Platform} [options.platform] Platform used to quote hook commands.
 * @param {NodeJS.ReadStream} [options.stdin] Stdin for `agent-hook` and plugins.
 * @param {string[]} [argv=process.argv.slice(2)] Arguments after the program name.
 * @returns {Promise<number>} Process exit code. `0` for success and for help or version. `1` for a failed command. `2` for bad arguments or an unknown command.
 */
export async function cosplaying(options = {}, argv = process.argv.slice(2)) {
  const { entrypoint } = options;
  const context = {
    defaults: options.defaults,
    entrypoint: entrypoint && realpathSync(typeof entrypoint === 'string' && !entrypoint.startsWith('file:')
      ? resolve(entrypoint)
      : fileURLToPath(entrypoint)),
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    home: options.home || homedir(),
    platform: options.platform || process.platform,
    stdin: options.stdin,
  };
  const program = new Command();
  program
    .name('cosplaying')
    .exitOverride()
    .enablePositionalOptions()
    .configureOutput({
      writeOut: (text) => context.stdout.write(text),
      writeErr: () => {},
      getOutHelpWidth: () => 100,
      getErrHelpWidth: () => 100,
    })
    .version(packageVersion(), '-v, --version');
  let code = 0;
  /**
   * Appends one repeated Commander flag value.
   *
   * `--harness` and `--agent` may be passed more than once. Commander stores the growing list.
   *
   * @param {string} value Flag value from this occurrence.
   * @param {string[]} previous Values already collected for the same flag.
   * @returns {string[]} `previous` with `value` appended.
   */
  const collect = (value, previous) => previous.concat(value);
  program.command('hook')
    .description('Run a wrapped command')
    .option('--model <name>')
    .option('--model-base64 <value>')
    .option('--harness <id>')
    .argument('[command...]')
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (commandArgs, opts) => {
      code = await runHook(argv, commandArgs, opts, context);
    });
  program.command('agent-hook')
    .description('Handle a harness hook event')
    .argument('[harness]')
    .argument('[event]')
    .action(async (harness, event) => {
      code = await runAgentHook(harness, event, context);
    });
  program.command('rewrite')
    .description('Print a rewritten shell command')
    .option('--model <name>')
    .option('--model-base64 <value>')
    .option('--harness <id>')
    .option('--shell')
    .argument('[words...]')
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (words, opts) => {
      code = await runRewrite(words, opts, context);
    });
  const install = program.command('install').description('Install harness hooks');
  const uninstall = program.command('uninstall').description('Remove harness hooks');
  for (const [command, remove] of [[install, false], [uninstall, true]]) {
    command
      .option('-H, --harness <id>', 'harness', collect, [])
      .option('-a, --agent <id>', 'agent', collect, [])
      .option('--project-dir <dir>')
      .option('--bin <path>')
      .action(async (opts) => {
        code = await runInstall(opts, context, remove);
      });
  }
  program.command('doctor')
    .description('Check hooks, plugins, and config')
    .option('--repair')
    .option('--project-dir <dir>')
    .option('--bin <path>')
    .action(async (opts) => {
      code = await runDoctorCommand(opts, context);
    });
  const plugin = program.command('plugin').description('Install, uninstall, list, enable, or disable plugins');
  plugin.command('list').description('List plugins').action(async () => {
    code = await runPlugin(['list'], context);
  });
  plugin.command('install').argument('[source]').action(async (source) => {
    code = await runPlugin(source ? ['install', source] : ['install'], context);
  });
  plugin.command('uninstall').argument('[name]').action(async (name) => {
    code = await runPlugin(name ? ['uninstall', name] : ['uninstall'], context);
  });
  plugin.command('enable').argument('[name]').action(async (name) => {
    code = await runPlugin(name ? ['enable', name] : ['enable'], context);
  });
  plugin.command('disable').argument('[name]').action(async (name) => {
    code = await runPlugin(name ? ['disable', name] : ['disable'], context);
  });
  plugin.action(() => {
    report(context.stderr, pluginUsage());
    code = 2;
  });
  program.addHelpText('afterAll', pluginHelp(await pluginsForHelp(context)));
  if (argv.length === 0) {
    program.outputHelp();
    return 2;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    return commandError(context, error);
  }
  return code;
}

/**
 * Maps a Commander failure to a process exit code.
 *
 * Help and version are success. An unknown command and a bad flag are usage errors. Any other thrown error is a command failure.
 *
 * @param {object} context Runtime context.
 * @param {NodeJS.WritableStream} context.stderr Stream that receives the error line.
 * @param {unknown} error Value thrown by Commander or by a command action.
 * @returns {number} `0` for help and version, `2` for usage errors, and `1` for every other error.
 */
function commandError(context, error) {
  const code = error.code || '';
  const message = error.message;
  if (code === 'commander.helpDisplayed' || code === 'commander.help') return 0;
  if (code === 'commander.version') return 0;
  if (code === 'commander.unknownCommand') {
    const name = message.match(/'([^']+)'/)?.[1] || message;
    report(context.stderr, new CosplayError({
      name: 'cli',
      method: 'main',
      message: 'unknown command %s. Run cosplaying --help and use hook, agent-hook, rewrite, install, uninstall, doctor, or plugin.',
      args: [name],
    }).message);
    return 2;
  }
  if (code.startsWith('commander.')) {
    report(context.stderr, new CosplayError({
      name: 'cli',
      method: 'main',
      message: 'could not parse arguments: %s. Run cosplaying --help and fix the flags. String flags need a value.',
      args: [message],
    }).message);
    return 2;
  }
  report(context.stderr, message);
  return 1;
}

/**
 * Loads plugins for the help text.
 *
 * Help must still print when settings or a plugin cannot be loaded. In that case the plugin section is omitted.
 *
 * @param {object} context Runtime context passed to the plugin loader.
 * @returns {Promise<object[]>} Loaded plugins. An empty list when loading throws.
 */
async function pluginsForHelp(context) {
  try {
    return (await loadPlugins(context)).plugins;
  } catch {
    return [];
  }
}

/**
 * Builds the usage error for `cosplaying plugin` with no action.
 *
 * The text names `install`, `uninstall`, `list`, `enable`, and `disable`.
 *
 * @returns {string} Error text for a missing plugin action.
 */
function pluginUsage() {
  return new CosplayError({
    name: 'cli',
    method: 'plugin',
    message: 'cosplaying plugin: expected install, uninstall, list, enable, or disable. Run cosplaying plugin install, cosplaying plugin uninstall <name>, cosplaying plugin list, cosplaying plugin enable <name>, or cosplaying plugin disable <name>.',
  }).message;
}

/**
 * Chooses the model name for `hook` and `rewrite`.
 *
 * `--model-base64` is decoded first. `--model` is plain text and must not be empty or start with a dash. `COSPLAYING_MODEL` is next. `--harness` uses that harness label when no model was given. The settings file is never a source.
 *
 * @param {object} parsed Flags accepted by Commander.
 * @param {string} [parsed.model] Plain model name from `--model`.
 * @param {string} [parsed.modelBase64] Base64url model name from `--model-base64`.
 * @param {string} [parsed.harness] Harness id whose label is the fallback model.
 * @param {NodeJS.ProcessEnv} env Environment. `COSPLAYING_MODEL` is used when no flag sets the model.
 * @returns {{model: string, error?: string}} The model name, or an empty model and `error` text when a flag is present but invalid.
 */
function resolveCliModel(parsed, env) {
  if (Object.hasOwn(parsed, 'modelBase64')) {
    const raw = parsed.modelBase64 ?? '';
    if (!raw || raw.startsWith('-') || !/^[A-Za-z0-9_-]+$/.test(raw)) {
      return {
        model: '',
        error: new CosplayError({
          name: 'cli',
          method: 'resolveModel',
          message: '--model-base64 must be base64url. Pass the model name with --model <name> when typing the command. Pass the model as plain text with --model <name>. Hooks pass --model-base64 for you.',
        }).message,
      };
    }
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const model = normalizeIdentity(decoded);
    if (!model) {
      return {
        model: '',
        error: new CosplayError({
          name: 'cli',
          method: 'resolveModel',
          message: '--model-base64 did not contain a model name. Encode a non-empty model with base64url, or pass --model <name>.',
        }).message,
      };
    }
    return { model };
  }
  if (Object.hasOwn(parsed, 'model')) {
    const raw = parsed.model ?? '';
    if (!raw.trim() || raw.trim().startsWith('-')) {
      return {
        model: '',
        error: new CosplayError({
          name: 'cli',
          method: 'resolveModel',
          message: '--model requires the model name as plain text. Run cosplaying hook --model <name> -- <command>. Do not leave the value empty or starting with a dash.',
        }).message,
      };
    }
    return { model: normalizeIdentity(raw) };
  }
  if (env.COSPLAYING_MODEL) return { model: normalizeIdentity(env.COSPLAYING_MODEL) };
  if (parsed.harness) {
    const found = getAdapter(parsed.harness);
    if (!found) return { model: '', error: unknownHarness(parsed.harness) };
    return { model: found.label };
  }
  return { model: '' };
}

const HOOK_FLAGS = new Set(['--model', '--model-base64', '--harness']);

/**
 * Runs one wrapped command through its plugin.
 *
 * The plugin receives the real executable, the model, and the attribution helpers. `COSPLAYING_INSIDE_HOOK` makes a nested call spawn the real executable directly, so a plugin cannot call this CLI again for the same command.
 *
 * @param {string[]} argv Original arguments, used to see whether `--` separated the hook flags from the command.
 * @param {string[]} commandArgs Words after `hook`. The first word is the plugin command.
 * @param {object} options Parsed hook flags.
 * @param {string} [options.model] Plain model name.
 * @param {string} [options.modelBase64] Base64url model name.
 * @param {string} [options.harness] Harness id used as the model fallback.
 * @param {object} context Runtime context. It supplies the streams, environment, working directory, home, platform, and stdin.
 * @returns {Promise<number>} Exit code from the plugin, or `1` when the plugin or the real executable cannot be used, or `2` for a usage error.
 */
async function runHook(argv, commandArgs, options, context) {
  const separated = argv.includes('--');
  if (!separated) {
    const flag = commandArgs.slice(1).find((token) => token.startsWith('-'));
    if (flag) {
      report(context.stderr, HOOK_FLAGS.has(flag)
        ? new CosplayError({
          name: 'cli',
          method: 'hook',
          message: '%s is after the command. Put hook flags before the command, then --, then the command. Run cosplaying hook --model <name> -- <command>. Do not place --model, --model-base64, or --harness after the command name.',
          args: [flag],
        }).message
        : new CosplayError({
          name: 'cli',
          method: 'hook',
          message: 'could not parse arguments: %s. Run cosplaying --help and fix the flags. String flags need a value.',
          args: [`${flag} is after the command`],
        }).message);
      return 2;
    }
  }
  const resolved = resolveCliModel(options, context.env);
  if (resolved.error) {
    report(context.stderr, resolved.error);
    return 2;
  }
  if (commandArgs.length === 0) {
    report(context.stderr, new CosplayError({
      name: 'cli',
      method: 'hook',
      message: 'cosplaying hook: expected a command. Run cosplaying hook --model <name> -- <command> [args].',
    }).message);
    return 2;
  }
  const [command, ...args] = commandArgs;
  let plugins;
  let config;
  try {
    ({ config, plugins } = await loadPlugins(context));
  } catch (error) {
    report(context.stderr, error.message);
    return 1;
  }
  const plugin = plugins.find((entry) => entry.command === command);
  if (!plugin) {
    const shipped = bundledPlugins();
    report(context.stderr, shipped[command]
      ? new CosplayError({
        name: 'cli',
        method: 'hook',
        message: 'shipped plugin %s is off. Run cosplaying plugin enable %s, or add "%s" to the plugins list.',
        args: [command, command, command],
      }).message
      : new CosplayError({
        name: 'cli',
        method: 'hook',
        message: 'no plugin is installed for %s. Install it with cosplaying plugin install <git-url-or-path>, or add its path to the plugins list.',
        args: [command],
      }).message);
    return 1;
  }
  const own = [realMainPath(), context.entrypoint];
  try {
    own.push(realpathSync(process.execPath));
  } catch {
    // The executable path is not available.
  }
  const real = resolveRealBin(command, { env: context.env, platform: context.platform, cliPaths: own });
  if (!real.bin) {
    report(context.stderr, real.error);
    return 1;
  }
  if (context.env.COSPLAYING_INSIDE_HOOK === '1') {
    const result = await defaultSpawn(real.bin, args, { stdio: 'inherit', env: context.env, cwd: context.cwd });
    return result?.status ?? 1;
  }
  const code = await plugin.descriptor.run(args, {
    model: resolved.model,
    harness: options.harness || '',
    cwd: context.cwd,
    env: { ...context.env, COSPLAYING_INSIDE_HOOK: '1' },
    home: context.home,
    platform: context.platform,
    stdin: context.stdin || process.stdin,
    stdout: context.stdout,
    stderr: context.stderr,
    realBin: real.bin,
    spawn: defaultSpawn,
    attribution: attributionApi(context, resolved.model, config),
  });
  return code ?? 0;
}

/**
 * Prints a shell command with plugin executables rewritten.
 *
 * Pi and OpenCode call this before a bash tool runs. The output is one line. The command is not executed.
 *
 * @param {string[]} words Shell words, or one shell string when `--shell` is used. Commander leaves the text in this list.
 * @param {object} options Parsed rewrite flags.
 * @param {string} [options.model] Plain model name placed in the rewrite prefix.
 * @param {string} [options.modelBase64] Base64url model name.
 * @param {string} [options.harness] Harness id used as the model fallback.
 * @param {object} context Runtime context. `stdout` receives the rewritten command. `stderr` receives errors.
 * @returns {Promise<number>} `0` when the rewritten command was printed. `1` when plugins cannot be loaded. `2` for a usage or model error.
 */
async function runRewrite(words, options, context) {
  const command = words.join(' ');
  if (!command.trim()) {
    report(context.stderr, new CosplayError({
      name: 'cli',
      method: 'rewrite',
      message: 'cosplaying rewrite: expected a command. Run cosplaying rewrite --shell \'<command>\' or cosplaying rewrite <command> [args].',
    }).message);
    return 2;
  }
  const resolved = resolveCliModel(options, context.env);
  if (resolved.error) {
    report(context.stderr, resolved.error);
    return 2;
  }
  /** @type {Record<string, string>} */
  let routes = {};
  try {
    const { plugins } = await loadPlugins(context);
    for (const plugin of plugins) {
      if (plugin.descriptor.intercept === false) continue;
      routes[plugin.command] = commandPrefix(plugin.command, resolved.model, context.platform, context.entrypoint);
    }
  } catch (error) {
    report(context.stderr, error.message);
    return 1;
  }
  const rewritten = rewriteModelFlags(rewriteShellCommand(command, routes).command, resolved.model);
  context.stdout.write(`${rewritten}\n`);
  return 0;
}

/**
 * Splits repeated harness flags into individual ids.
 *
 * A single `--harness a,b` and two `--harness` options both become a list of ids.
 *
 * @param {string[]} values Flag values collected by Commander. Each value may contain comma-separated ids.
 * @returns {string[]} Trimmed ids. Empty pieces are omitted.
 */
function flagList(values) {
  return values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
}

/**
 * Returns the harness ids that install or uninstall should touch.
 *
 * `--harness` and `--agent` are combined. Repeated ids are kept once, in first-seen order. No ids means every supported harness.
 *
 * @param {Record<string, string | string[] | boolean | undefined>} values Parsed install or uninstall options. `harness` and `agent` are the id lists.
 * @returns {string[]} Harness ids to process.
 */
function selectedHarnesses(values) {
  const ids = [...flagList(values.harness || []), ...flagList(values.agent || [])];
  if (ids.length === 0) return adapters.map((item) => item.id);
  const seen = new Set();
  /** @type {string[]} */
  const selected = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
  }
  return selected;
}

/**
 * Reports whether a path is an existing directory.
 *
 * Doctor rejects `--project-dir` when the path is missing or is not a directory, before it looks for hook files.
 *
 * @param {string} directory Path from `--project-dir`.
 * @returns {boolean} True when `stat` says the path is a directory. False when it is missing or is not a directory.
 */
function isDirectory(directory) {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Installs or removes harness hooks and prints one line per harness.
 *
 * An unknown harness id stops the command before any file is written. After a successful install, each harness can print an approval note.
 *
 * @param {object} options Parsed install or uninstall flags.
 * @param {string[]} [options.harness] Harness ids from `--harness`.
 * @param {string[]} [options.agent] Harness ids from `--agent`. Combined with `harness`.
 * @param {string} [options.projectDir] Project directory. When set, project hooks are edited instead of user hooks.
 * @param {string} [options.bin] `cosplaying` executable embedded in the hook commands.
 * @param {object} context Runtime context used to find plugins and hook files.
 * @param {boolean} remove True for `uninstall`. False for `install`.
 * @returns {Promise<number>} `0` when every selected harness succeeded. `1` when one or more failed. `2` when a harness id is unknown.
 */
async function runInstall(options, context, remove) {
  const harnesses = selectedHarnesses(options);
  for (const harness of harnesses) {
    if (!getAdapter(harness)) {
      report(context.stderr, unknownHarness(harness));
      return 2;
    }
  }
  const projectDir = options.projectDir || undefined;
  const bin = options.bin || undefined;
  const commands = await interceptingCommands(context);
  const target = { ...context, projectDir, commands, bin };
  const results = remove ? uninstallAll(target, harnesses) : installAll(target, harnesses);
  let failed = false;
  /** @type {string[]} */
  const done = [];
  for (const result of results) {
    if (!result.ok) {
      failed = true;
      const text = result.error.message;
      context.stderr.write(`${result.harness}: ${text.endsWith('\n') ? text : `${text}\n`}`);
      continue;
    }
    const verb = remove
      ? (result.changed ? 'removed' : 'already configured')
      : (result.changed ? 'installed' : 'already configured');
    context.stdout.write(`${verb} ${result.harness} hooks (${result.file})\n`);
    done.push(result.harness);
  }
  if (!remove) {
    for (const id of done) {
      const note = getAdapter(id).installedNote({ projectDir });
      if (note) context.stdout.write(note);
    }
  }
  return failed ? 1 : 0;
}

/**
 * Runs doctor after checking that an explicit project directory exists.
 *
 * The plugin commands that intercept shell writes are passed in so extension files can be compared with the current command list.
 *
 * @param {object} options Parsed doctor flags.
 * @param {boolean} [options.repair] True when `--repair` was passed. Doctor then rewrites files it can fix.
 * @param {string} [options.projectDir] Project directory. It must already exist and be a directory.
 * @param {string} [options.bin] `cosplaying` executable that hook commands should use.
 * @param {object} context Runtime context. `stderr` receives the usage error for a bad project directory.
 * @returns {Promise<number>} Doctor's exit code, or `2` when `--project-dir` is not a directory.
 */
async function runDoctorCommand(options, context) {
  const projectDir = options.projectDir || undefined;
  if (projectDir && !isDirectory(projectDir)) {
    report(context.stderr, new CosplayError({
      name: 'cli',
      method: 'runDoctor',
      message: '%s is not a directory. Pass --project-dir an existing directory. Create the directory, or pass --project-dir a path that exists and is a directory.',
      args: [projectDir],
    }).message);
    return 2;
  }
  return runDoctor({
    ...context,
    repair: options.repair === true,
    projectDir,
    bin: options.bin || undefined,
    commands: await interceptingCommands(context),
  });
}

/**
 * Lists plugin commands that shell rewrite must wrap.
 *
 * A plugin with `intercept: false` is omitted. A load failure returns an empty list so install can still write hooks.
 *
 * @param {object} context Runtime context passed to the plugin loader.
 * @returns {Promise<string[]>} Command names. An empty list when plugins cannot be loaded.
 */
async function interceptingCommands(context) {
  try {
    const { plugins } = await loadPlugins(context);
    return plugins.filter((plugin) => plugin.descriptor.intercept !== false).map((plugin) => plugin.command);
  } catch {
    return [];
  }
}

/**
 * Runs `plugin list`, `install`, `uninstall`, `enable`, or `disable`.
 *
 * Enable and disable change the user settings for a shipped plugin. Install and uninstall copy or remove a plugin package. Each successful change regenerates Pi and OpenCode extensions so their command lists match.
 *
 * @param {string[]} argv Action and optional source or name. `argv[0]` is the action. `argv[1]` is the plugin source or name.
 * @param {object} context Runtime context. `stdout` receives the result lines. `stderr` receives usage and failure text.
 * @returns {Promise<number>} `0` on success. `1` when the action fails. `2` when the action or its argument is missing.
 */
async function runPlugin(argv, context) {
  const [action, source] = argv;
  if (action === 'list') {
    const plugins = await listPlugins(context);
    for (const plugin of plugins) {
      context.stdout.write(`${plugin.name}\t${plugin.command}\t${plugin.kind}\t${plugin.directory}\n`);
    }
    let configured;
    try {
      configured = (await loadPlugins(context)).plugins;
    } catch (error) {
      report(context.stderr, error.message);
      return 1;
    }
    const seen = new Set(plugins.map((plugin) => plugin.command));
    for (const plugin of configured) {
      if (plugin.kind !== 'bundled' || seen.has(plugin.command)) continue;
      context.stdout.write(`${plugin.name}\t${plugin.command}\tbundled\t${plugin.directory}\n`);
    }
    return 0;
  }
  if (action === 'enable' || action === 'disable') {
    if (!source) {
      report(context.stderr, action === 'enable'
        ? new CosplayError({
          name: 'cli',
          method: 'plugin',
          message: 'cosplaying plugin enable: expected a shipped plugin name. Run cosplaying plugin enable git or cosplaying plugin enable gh.',
        }).message
        : new CosplayError({
          name: 'cli',
          method: 'plugin',
          message: 'cosplaying plugin disable: expected a shipped plugin name. Run cosplaying plugin disable git or cosplaying plugin disable gh.',
        }).message);
      return 2;
    }
    const result = action === 'enable'
      ? await enableBundledPlugin(source, context)
      : await disableBundledPlugin(source, context);
    if (!result.ok) {
      report(context.stderr, result.error);
      return result.status;
    }
    await regenerateExtensions(context);
    context.stdout.write(action === 'enable' ? `${result.name}\t${result.directory}\n` : `${result.name}\n`);
    return 0;
  }
  if (action === 'install') {
    if (!source) {
      report(context.stderr, new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'cosplaying plugin install: expected a git URL or local path. Run cosplaying plugin install <git-url-or-path>.',
      }).message);
      return 2;
    }
    const result = await installPlugin(source, context);
    if (!result.ok) {
      report(context.stderr, result.error);
      return 1;
    }
    await regenerateExtensions(context);
    context.stdout.write(`${result.name}\t${result.directory}\n`);
    return 0;
  }
  if (action === 'uninstall') {
    if (!source) {
      report(context.stderr, new CosplayError({
        name: 'cli',
        method: 'plugin',
        message: 'cosplaying plugin uninstall: expected a plugin name. Run cosplaying plugin list, then cosplaying plugin uninstall <name>.',
      }).message);
      return 2;
    }
    const result = await uninstallPlugin(source, context);
    if (!result.ok) {
      report(context.stderr, result.error);
      return 1;
    }
    await regenerateExtensions(context);
    context.stdout.write(`${source}\n`);
    return 0;
  }
  report(context.stderr, pluginUsage());
  return 2;
}

/**
 * Rewrites installed Pi and OpenCode extensions after the plugin list changes.
 *
 * User extensions are always updated. A project extension is updated only when that file already exists, so a project that never installed hooks does not gain one.
 *
 * @param {object} context Runtime context used to load plugins and find the Git root.
 * @returns {Promise<void>} No value. Failures from the installer propagate to the caller.
 */
async function regenerateExtensions(context) {
  const commands = await interceptingCommands(context);
  for (const harness of adapters) {
    if (harness.kind !== 'extension') continue;
    installHarness(harness.id, { ...context, commands });
    const project = gitRoot(context.cwd);
    if (!project) continue;
    const file = harness.file({ ...context, projectDir: project });
    if (existsSync(file)) installHarness(harness.id, { ...context, projectDir: project, commands });
  }
}

/** Runs the CLI with the original argument order. */
export function main(argv, options) {
  return cosplaying(options, argv);
}

const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : '';
if (entry && entry === realMainPath()) {
  cosplaying().then((code) => {
    process.exit(code);
  });
}
