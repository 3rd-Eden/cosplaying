import { Command } from 'commander';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
 * @param {Array<{command: string, descriptor: {description: string, examples: string[]}}>} plugins
 * @returns {string}
 */
export function renderHelp(plugins = []) {
  const lines = ['cosplaying', ''];
  for (const [name, description] of CORE_HELP) lines.push(`  ${name}  ${description}`);
  const extra = pluginHelp(plugins);
  return extra ? `${lines.join('\n')}\n${extra}` : `${lines.join('\n')}\n`;
}

/**
 * @param {string} id
 * @returns {string}
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
 * @param {{write: (chunk: string) => void}} stderr
 * @param {string} message
 */
function report(stderr, message) {
  stderr.write(`cosplaying: ${message.endsWith('\n') ? message : `${message}\n`}`);
}

/**
 * @param {Array<{command: string, descriptor: {description?: string, examples?: string[]}}>} plugins
 * @returns {string}
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
 * @param {string[]} argv
 * @param {object} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  const context = {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    home: options.home || homedir(),
    platform: options.platform || process.platform,
    spawnImpl: options.spawnImpl,
    input: options.input,
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
 * @param {object} context
 * @param {unknown} error
 * @returns {number}
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
 * @param {object} context
 * @returns {Promise<object[]>}
 */
async function pluginsForHelp(context) {
  try {
    return (await loadPlugins(context)).plugins;
  } catch {
    return [];
  }
}

/**
 * @returns {string}
 */
function pluginUsage() {
  return new CosplayError({
    name: 'cli',
    method: 'plugin',
    message: 'cosplaying plugin: expected install, uninstall, list, enable, or disable. Run cosplaying plugin install, cosplaying plugin uninstall <name>, cosplaying plugin list, cosplaying plugin enable <name>, or cosplaying plugin disable <name>.',
  }).message;
}

/**
 * @param {object} parsed
 * @param {NodeJS.ProcessEnv} env
 * @returns {{model: string, error?: string}}
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
    let decoded = '';
    try {
      decoded = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
      return {
        model: '',
        error: new CosplayError({
          name: 'cli',
          method: 'resolveModel',
          message: '--model-base64 must be base64url. Pass the model name with --model <name> when typing the command. Pass the model as plain text with --model <name>. Hooks pass --model-base64 for you.',
        }).message,
      };
    }
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
 * @param {string[]} argv
 * @param {string[]} commandArgs
 * @param {{model?: string, modelBase64?: string, harness?: string}} options
 * @param {object} context
 * @returns {Promise<number>}
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
  /** @type {{model?: string, modelBase64?: string, harness?: string}} */
  const present = {};
  if (options.model !== undefined) present.model = options.model;
  if (options.modelBase64 !== undefined) present.modelBase64 = options.modelBase64;
  if (options.harness !== undefined) present.harness = options.harness;
  const resolved = resolveCliModel(present, context.env);
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
  const own = [realMainPath()];
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
  const spawn = context.spawnImpl || defaultSpawn;
  if (context.env.COSPLAYING_INSIDE_HOOK === '1') {
    const result = await spawn(real.bin, args, { stdio: 'inherit', env: context.env, cwd: context.cwd });
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
    spawn,
    attribution: attributionApi(context, resolved.model, config),
  });
  return code ?? 0;
}

/**
 * @param {string[]} words
 * @param {{model?: string, modelBase64?: string, harness?: string}} options
 * @param {object} context
 * @returns {Promise<number>}
 */
async function runRewrite(words, options, context) {
  /** @type {{model?: string, modelBase64?: string, harness?: string}} */
  const present = {};
  if (options.model !== undefined) present.model = options.model;
  if (options.modelBase64 !== undefined) present.modelBase64 = options.modelBase64;
  if (options.harness !== undefined) present.harness = options.harness;
  const command = words.join(' ');
  if (!command.trim()) {
    report(context.stderr, new CosplayError({
      name: 'cli',
      method: 'rewrite',
      message: 'cosplaying rewrite: expected a command. Run cosplaying rewrite --shell \'<command>\' or cosplaying rewrite <command> [args].',
    }).message);
    return 2;
  }
  const resolved = resolveCliModel(present, context.env);
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
      routes[plugin.command] = commandPrefix(plugin.command, resolved.model, context.platform);
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
 * @param {string[]} values
 * @returns {string[]}
 */
function flagList(values) {
  return values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
}

/**
 * @param {Record<string, string | string[] | boolean | undefined>} values
 * @returns {string[]}
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
 * @param {string} directory
 * @returns {boolean}
 */
function isDirectory(directory) {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {{harness?: string[], agent?: string[], projectDir?: string, bin?: string}} options
 * @param {object} context
 * @param {boolean} remove
 * @returns {Promise<number>}
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
 * @param {{repair?: boolean, projectDir?: string, bin?: string}} options
 * @param {object} context
 * @returns {Promise<number>}
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
 * @param {object} context
 * @returns {Promise<string[]>}
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
 * @param {string[]} argv
 * @param {object} context
 * @returns {Promise<number>}
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
 * @param {object} context
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

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry && entry === realMainPath()) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
