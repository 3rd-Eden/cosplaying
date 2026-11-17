import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';

export const API_FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field']);
export const API_INPUT_FLAGS = new Set(['--input']);

/**
 * Parses gh api field flags and selects fields allowed for an endpoint.
 * @param {string[]} args - gh api arguments.
 * @param {string[]} fields - Allowlisted text field names.
 * @returns {Array<{flag: string, index: number, valueIndex: number, inline: boolean, key: string, field: string, value: string}>} Matching text field occurrences.
 * @private
 */
export function apiFieldOccurrences(args, fields) {
  const result = [];
  for (const occurrence of flagOccurrences(args, API_FIELD_FLAGS)) {
    if (occurrence.value === undefined) continue;
    const equals = occurrence.value.indexOf('=');
    if (equals < 1) continue;
    const key = occurrence.value.slice(0, equals);
    const field = key.toLowerCase();
    if (fields.includes(field)) result.push({ ...occurrence, key, field, value: occurrence.value.slice(equals + 1) });
  }
  return result;
}

/**
 * @param {string} message
 * @returns {CosplayError}
 */
export function ghError(message) {
  return new CosplayError({ name: 'cli', method: 'gh', message });
}

/**
 * Checks whether a value is a non-array object.
 * @param {unknown} value - Value to inspect.
 * @returns {value is Record<string, unknown>} Whether the value is a record.
 * @private
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves the required write identity and validated attribution settings.
 * @param {Record<string, string | undefined>} [env=process.env] - Environment variables used for model and config values.
 * @param {string} [cwd=process.cwd()] - Working directory used to find project config.
 * @param {{env?: Record<string, string | undefined>, cwd?: string, home?: string, platform?: string}} [configPaths] - Additional environment and path overrides for config lookup.
 * @returns {{model: string, template: string, link: string | undefined}} Model identity and attribution settings.
 * @throws {CosplayError} If the model identity is missing or attribution configuration is invalid.
 * @public
 */
export function requireAttribution(context) {
  context.attribution.annotateMarkdown('');
}

/**
 * Finds occurrences of selected flags and records their value positions.
 * @param {string[]} args - Argument list to scan.
 * @param {Iterable<string>} flags - Flag names to match.
 * @returns {Array<{flag: string, index: number, valueIndex: number, inline: boolean, attached?: boolean, value: string | undefined}>} Matching flag occurrences.
 * @private
 */
export function flagOccurrences(args, flags) {
  const result = [];
  const names = new Set(flags);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    for (const flag of names) {
      if (arg === flag) {
        result.push({ flag, index: i, valueIndex: i + 1, inline: false, attached: false, value: args[i + 1] });
        if (i + 1 < args.length) i += 1;
        break;
      }
      if (arg.startsWith(`${flag}=`)) {
        result.push({ flag, index: i, valueIndex: i, inline: true, attached: false, value: arg.slice(flag.length + 1) });
        break;
      }
      if (flag.length === 2 && flag[0] === '-' && arg.startsWith(flag) && arg.length > flag.length) {
        const value = arg.slice(flag.length);
        result.push({ flag, index: i, valueIndex: i, inline: true, attached: true, value: value.startsWith('=') ? value.slice(1) : value });
        break;
      }
    }
  }
  return result;
}

/**
 * Adds one attribution trailer to a merge body, replacing a prior footer value.
 * @param {string} text - Existing merge commit body.
 * @param {string} trailer - Rendered `AI-Assisted-By` trailer.
 * @returns {string} Body with a single final attribution trailer.
 * @private
 */
export function mergeBodyWithTrailer(text, trailer) {
  const lines = String(text).replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const footerStart = lines.lastIndexOf('') + 1;
  for (let i = lines.length - 1; i >= footerStart; i -= 1) {
    if (/^AI-Assisted-By:\s/i.test(lines[i])) lines.splice(i, 1);
  }
  const body = lines.join('\n').trimEnd();
  return `${body}${body ? '\n\n' : ''}${trailer}\n`;
}

/**
 * Creates private temporary files and a cleanup function for rewritten inputs.
 * @returns {{write: function(string, string=): string, cleanup: function(): void}} Temporary file writer and cleanup operations.
 * @private
 */
export function createTempFiles() {
  let directory;
  const files = [];
  return {
    /**
     * Writes text to a private temporary file.
     * @param {string} text - File contents.
     * @param {string} [extension='.md'] - File extension to preserve for the wrapped CLI.
     * @returns {string} Path to the written temporary file.
     * @throws {CosplayError} If the temporary directory or file cannot be created.
     * @private
     */
    write(text, extension = '.md') {
      try {
        directory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cosplaying-'));
        const file = path.join(directory, `input${files.length}${extension.startsWith('.') ? extension : `.${extension}`}`);
        fs.writeFileSync(file, text, { mode: 0o600 });
        files.push(file);
        return file;
      } catch (error) {
        throw ghError(`cannot create private attributed input copy: ${error.message}. Check the system temporary directory and available space; the source file was not modified.`);
      }
    },
    /**
     * Removes the temporary directory and all files written by this instance.
     * @returns {void}
     * @throws {CosplayError} If the temporary directory cannot be removed.
     * @private
     */
    cleanup() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Creates a lazy reader that consumes stdin at most once.
 * @param {string | Buffer | NodeJS.ReadStream} [input=process.stdin] - Stdin source or injected text value.
 * @returns {function(): string} Function returning the cached stdin text.
 * @throws {CosplayError} If stdin cannot be read.
 * @private
 */
export function stdinReader(input = process.stdin) {
  let read = false;
  let value = '';
  return () => {
    if (!read) {
      if (typeof input === 'string' || Buffer.isBuffer(input)) value = String(input);
      else {
        try { value = fs.readFileSync(input.fd ?? 0, 'utf8'); }
        catch (error) { throw ghError(`cannot read stdin: ${error.message}. Provide UTF-8 input on stdin or use a readable file where supported.`); }
      }
      read = true;
    }
    return value;
  };
}

/**
 * Replaces the value portion of a previously parsed flag occurrence.
 * @param {string[]} args - Mutable GitHub CLI argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean}} occurrence - Parsed flag location.
 * @param {string} value - Replacement value.
 * @returns {void}
 * @private
 */
export function replaceOccurrence(args, occurrence, value) {
  if (occurrence.attached) args[occurrence.index] = `${occurrence.flag}${value}`;
  else if (occurrence.inline) args[occurrence.index] = `${occurrence.flag}=${value}`;
  else args[occurrence.valueIndex] = value;
}

/**
 * Reads a text file or consumes the injected stdin reader for a dash path.
 * @param {string} file - Text file path or dash to read stdin.
 * @param {function(): string} readStdin - Cached stdin reader.
 * @returns {{text: string, fromStdin: boolean}} File text and whether it came from stdin.
 * @throws {CosplayError} If the requested file cannot be read.
 * @private
 */
export function readTextFile(file, readStdin) {
  if (file === '-') return { text: readStdin(), fromStdin: true };
  try { return { text: fs.readFileSync(file, 'utf8'), fromStdin: false }; }
  catch (error) { throw ghError(`cannot read input file ${file}: ${error.message}. Check that the path exists and is readable, or use - for stdin where supported.`); }
}
