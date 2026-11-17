import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

const source = [
  'using System;',
  'using System.IO;',
  'using System.Collections.Generic;',
  'using System.Reflection;',
  'class CosplayingStub {',
  '  static int Main(string[] args) {',
  '    string location = Assembly.GetExecutingAssembly().Location;',
  '    string specPath = location + ".spec";',
  '    Dictionary<string, string> spec = new Dictionary<string, string>();',
  '    if (File.Exists(specPath)) {',
  '      foreach (string line in File.ReadAllLines(specPath)) {',
  '        int split = line.IndexOf(\'=\');',
  '        if (split <= 0) continue;',
  '        spec[line.Substring(0, split)] = line.Substring(split + 1);',
  '      }',
  '    }',
  '    string value;',
  '    if (spec.TryGetValue("log", out value)) {',
  '      string logged = spec.ContainsKey("logLines") ? string.Join("\\n", args) + "\\n" : string.Join(" ", args) + "\\n";',
  '      if (spec.ContainsKey("overwriteLog")) File.WriteAllText(value, logged);',
  '      else File.AppendAllText(value, logged);',
  '      if (spec.ContainsKey("fileArgs")) {',
  '        foreach (string arg in args) {',
  '          if (!File.Exists(arg)) continue;',
  '          File.AppendAllText(value, "\\n--file " + arg + "--\\n");',
  '          File.AppendAllText(value, File.ReadAllText(arg));',
  '        }',
  '      }',
  '    }',
  '    if (args.Length > 0 && args[0] == "--version" && spec.TryGetValue("version", out value)) {',
  '      Console.Out.Write(value + "\\n");',
  '      return 0;',
  '    }',
  '    if (spec.ContainsKey("inside")) {',
  '      string hook = Environment.GetEnvironmentVariable("COSPLAYING_INSIDE_HOOK");',
  '      if (hook == null) hook = "";',
  '      Console.Out.Write("inside:" + hook + "\\n");',
  '    }',
  '    if (spec.TryGetValue("marker", out value)) File.WriteAllText(value, "");',
  '    string prefix;',
  '    if (!spec.TryGetValue("prefix", out prefix) || prefix == null) prefix = "";',
  '    foreach (string arg in args) Console.Out.Write(prefix + arg + "\\n");',
  '    return 0;',
  '  }',
  '}',
].join('\n');

let compiled = '';

/**
 * Returns the Windows variables a spawned program needs in order to start.
 *
 * `SystemRoot` and `windir` are copied when the parent process has them. On other platforms the result is empty.
 *
 * @returns {NodeJS.ProcessEnv} The copied variables. An empty object when neither variable is set.
 */
export function systemEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.windir) env.windir = process.env.windir;
  return env;
}

/**
 * Finds the .NET Framework C# compiler used to build the Windows command stub.
 *
 * The 64-bit compiler is preferred. A missing compiler returns an empty string so the caller can report that the stub cannot be built.
 *
 * @returns {string} Absolute path of `csc.exe`. An empty string when neither candidate exists.
 */
function cscPath() {
  const root = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((file) => existsSync(file)) || '';
}

/**
 * Compiles the Windows command stub once for this process and worker.
 *
 * Later calls reuse the executable. The stub reads a `.spec` file next to itself and records the arguments it received.
 *
 * @returns {string} Absolute path of the compiled executable.
 * @throws {Error} `csc.exe` is missing or the compile fails.
 */
function ensureStubExe() {
  if (compiled && existsSync(compiled) && statSync(compiled).size > 0) return compiled;
  const csc = cscPath();
  if (!csc) {
    throw new Error('csc.exe was not found, so the Windows program stand-in could not be compiled');
  }
  const dir = path.join(tmpdir(), 'cosplaying-win-stub');
  mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `stub-${process.pid}-${threadId}.exe`);
  const cs = path.join(dir, `stub-${process.pid}-${threadId}.cs`);
  if (!existsSync(exe) || statSync(exe).size === 0) {
    writeFileSync(cs, source);
    const result = spawnSync(csc, ['/nologo', '/t:exe', `/out:${exe}`, cs], { encoding: 'utf8' });
    if (result.status !== 0 || !existsSync(exe)) {
      throw new Error(result.stderr || result.stdout || 'csc.exe failed');
    }
  }
  compiled = exe;
  return exe;
}

/**
 * Writes the stand-in program that tests spawn instead of a real CLI.
 *
 * Other platforms write the shell script and mark it executable. Windows cannot execute a shebang script, so the same behavior is a compiled executable. A spec file next to that executable carries the options the stub reads.
 *
 * @param {string} file Destination path. On Windows, `.exe` is added when it is missing.
 * @param {string} shellScript Shell program used when the platform is not Windows.
 * @param {object} [spec={}] Options written to the Windows spec file. Empty values are omitted.
 * @param {string} [spec.marker] File the stub touches.
 * @param {string} [spec.prefix] Text the stub prints before the arguments.
 * @param {string} [spec.inside] Value compared with `COSPLAYING_INSIDE_HOOK`.
 * @param {string} [spec.version] Text printed for `--version`.
 * @param {string} [spec.log] File that receives the argument log.
 * @param {string} [spec.logLines] When set, each argument is logged on its own line.
 * @param {string} [spec.overwriteLog] When set, the log is replaced instead of appended.
 * @param {string} [spec.fileArgs] When set, arguments that are files are copied into the log.
 * @returns {string} Path of the program the test should execute.
 */
export function writeSpawnStub(file, shellScript, spec = {}) {
  if (process.platform !== 'win32') {
    writeFileSync(file, shellScript);
    chmodSync(file, 0o755);
    return file;
  }
  const exe = file.toLowerCase().endsWith('.exe') ? file : `${file}.exe`;
  copyFileSync(ensureStubExe(), exe);
  const lines = [];
  for (const [key, value] of Object.entries(spec)) {
    if (value) lines.push(`${key}=${value}`);
  }
  if (lines.length > 0) writeFileSync(`${exe}.spec`, `${lines.join('\n')}\n`);
  return exe;
}
