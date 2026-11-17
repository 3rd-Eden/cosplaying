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
 * Windows needs SystemRoot so a spawned program can start.
 * On other platforms this is empty.
 * @returns {NodeJS.ProcessEnv}
 */
export function systemEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.windir) env.windir = process.env.windir;
  return env;
}

/**
 * @returns {string}
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
 * @returns {string}
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
 * Writes the shell program the tests spawn. Windows cannot execute a shebang
 * script, so the same behavior is a real executable next to a spec file.
 * @param {string} file
 * @param {string} shellScript
 * @param {{marker?: string, prefix?: string, inside?: string, version?: string, log?: string, logLines?: string, overwriteLog?: string, fileArgs?: string}} [spec]
 * @returns {string}
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
