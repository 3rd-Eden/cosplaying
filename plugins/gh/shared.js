import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { CosplayError } from 'cosplaying/errors';

export const API_FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field']);
export const API_INPUT_FLAGS = new Set(['--input']);

/**
 * Finds `gh api` field flags whose key is in an allowlist.
 *
 * The key comparison is case-insensitive. The original key is kept so a replacement can write the same spelling. A field without `key=value` is ignored.
 *
 * @param {string[]} args Arguments that may contain `-f`, `--raw-field`, `-F`, and `--field`.
 * @param {string[]} fields Lowercase field names this endpoint is allowed to carry.
 * @returns {Array<{flag: string, index: number, valueIndex: number, inline: boolean, attached?: boolean, key: string, field: string, value: string}>} Matches. `key` is the text before `=`. `field` is that key in lowercase. `value` is the text after `=`.
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
 * Builds the error for a GitHub CLI rewrite that cannot attribute the text.
 *
 * The message already tells the agent what to change. Callers throw it, and the command is not run.
 *
 * @param {string} message Complete error text, including the next action.
 * @returns {CosplayError} Error with method `gh`.
 */
export function ghError(message) {
  return new CosplayError({ name: 'cli', method: 'gh', message });
}

/**
 * Reports whether a JSON value is a plain object.
 *
 * Arrays and null are not records. Request bodies and GraphQL variables must be objects before their fields are attributed.
 *
 * @param {unknown} value Parsed JSON value.
 * @returns {value is Record<string, unknown>} True when `value` is a non-null object and not an array.
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks that attribution can be rendered before a write that needs it.
 *
 * The check calls the Markdown helper with empty text. That throws when the model is missing, the policy link is not an http(s) URL, or the template contains a marker comment. The rendered block is discarded.
 *
 * @param {object} context Hook context.
 * @param {{annotateMarkdown: function(string): string}} context.attribution Helper that appends the Markdown byline.
 * @returns {void} No value. A usable configuration returns normally.
 * @throws {CosplayError} The model or the attribution settings cannot produce a byline.
 */
export function requireAttribution(context) {
  context.attribution.annotateMarkdown('');
}

/**
 * Finds selected flags and records where their values sit in the argument list.
 *
 * `--flag value`, `--flag=value`, and a short flag with an attached value are all recorded. The scan stops at `--`. A separate value is consumed so it is not scanned as another flag.
 *
 * @param {string[]} args Argument list. It is not mutated.
 * @param {Iterable<string>} flags Flag spellings to match, including the leading dashes.
 * @returns {Array<{flag: string, index: number, valueIndex: number, inline: boolean, attached: boolean, value: string | undefined}>} One record per match. `inline` is true when the value is in the same argument. `attached` is true for a short flag whose value is glued on, such as `-Ffile`. `value` is undefined when a separate value is missing.
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
 * Appends one `AI-Assisted-By` trailer to a commit message body.
 *
 * An existing `AI-Assisted-By` line in the trailer block is removed first, so a repeated merge does not stack trailers. The body text above that block is kept.
 *
 * @param {string} text Existing message body. It can be empty.
 * @param {string} trailer One rendered `AI-Assisted-By` line.
 * @returns {string} Body, a blank line when the body is non-empty, the trailer, and a trailing newline.
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
 * Creates a private directory for rewritten `gh` input and a way to delete it.
 *
 * File arguments are copied here so the user's file is not modified. The directory is created on the first write. Cleanup removes the directory and every file in it.
 *
 * @returns {{write: (text: string, extension?: string) => string, cleanup: () => void}} `write` stores text and returns the file path. `cleanup` deletes the directory. Cleanup before the first write does nothing.
 */
export function createTempFiles() {
  let directory;
  const files = [];
  return {
    /**
     * Writes text to a new private file in this temporary directory.
     *
     * The file mode is `0600`. The extension is kept so `gh` still sees a markdown or JSON name.
     *
     * @param {string} text File contents.
     * @param {string} [extension='.md'] Extension, with or without a leading dot.
     * @returns {string} Absolute path of the new file.
     * @throws {CosplayError} The directory or the file cannot be created. The source file was not modified.
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
     * Deletes the temporary directory created by {@link createTempFiles}, including every file written into it.
     *
     * A call before the first write does nothing. Removal uses a forced recursive delete.
     *
     * @returns {void} No value.
     */
    cleanup() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Returns a reader that consumes stdin once and then returns the same text.
 *
 * Several flags can use `-`. They must all see the same input, and the stream must not be read twice.
 *
 * @param {string | Buffer | NodeJS.ReadStream} [input=process.stdin] Text, bytes, or a stream. Tests pass a string. The hook passes the process stdin.
 * @returns {() => string} Function that returns the stdin text. The first call reads the source. Later calls return the cached text.
 * @throws {CosplayError} The stream cannot be read. The message tells the caller to pass a file or readable UTF-8 stdin.
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
 * Replaces the value of one flag that {@link flagOccurrences} already located.
 *
 * An attached short flag stays attached. An inline `--flag=value` stays inline. A separate value is written at `valueIndex`.
 *
 * @param {string[]} args Mutable argument list.
 * @param {{flag: string, index: number, valueIndex: number, inline: boolean, attached?: boolean}} occurrence Parsed flag location.
 * @param {string} value New flag value, without the flag name.
 * @returns {void} No value. `args` is updated in place.
 */
export function replaceOccurrence(args, occurrence, value) {
  if (occurrence.attached) args[occurrence.index] = `${occurrence.flag}${value}`;
  else if (occurrence.inline) args[occurrence.index] = `${occurrence.flag}=${value}`;
  else args[occurrence.valueIndex] = value;
}

/**
 * Reads a text file, or stdin when the path is `-`.
 *
 * Stdin is reported separately because the wrapped process cannot read it again. The caller copies that text to a private file.
 *
 * @param {string} file Path from a file flag, or `-` for stdin.
 * @param {function(): string} readStdin Cached stdin reader from {@link stdinReader}.
 * @returns {{text: string, fromStdin: boolean}} The file or stdin text, and whether it came from stdin.
 * @throws {CosplayError} The path exists as an argument but the file cannot be read.
 */
export function readTextFile(file, readStdin) {
  if (file === '-') return { text: readStdin(), fromStdin: true };
  try { return { text: fs.readFileSync(file, 'utf8'), fromStdin: false }; }
  catch (error) { throw ghError(`cannot read input file ${file}: ${error.message}. Check that the path exists and is readable, or use - for stdin where supported.`); }
}
