import { CosplayError } from 'cosplaying/errors';
import { block } from 'cosplaying/plugin';

export const description = 'Attribute Git commits and check pushes for a missing AI-Assisted-By trailer.';

export const examples = [
  'cosplaying hook --model "Example" -- git commit -m "Add retry support"',
  'cosplaying hook --model "Example" -- git push',
];

/** @type {Set<string>} */
const VALUE_FLAGS = new Set(['-C', '-c', '--config-env', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);

/** @type {Set<string>} */
const GLOBAL_FLAGS = new Set([
  '--bare', '--exec-path', '--glob-pathspecs', '--html-path', '--icase-pathspecs', '--info-path', '--no-advice',
  '--literal-pathspecs', '--man-path', '--no-lazy-fetch', '--no-optional-locks', '--no-pager',
  '--no-replace-objects', '--noglob-pathspecs', '--paginate', '--version', '--help', '-P', '-p', '-v', '-h',
]);
const TERMINAL_FLAGS = new Set(['--version', '--help', '-v', '-h']);

/** @type {Set<string>} */
const COMMIT_CREATORS = new Set(['commit', 'merge', 'pull', 'cherry-pick', 'revert', 'am', 'rebase']);

/** @type {Set<string>} */
const REWRITE_AFTER = new Set(['commit', 'cherry-pick', 'revert', 'am']);

/** @type {Set<string>} */
const REBASE_NO_WRITE = new Set(['--abort', '--quit', '--show-current-patch', '--edit-todo']);

/** @type {Set<string>} */
const REBASE_NONCOMMIT_ACTIONS = new Set(['start', 'finish', 'abort', 'quit', 'reset']);

/**
 * Builds a Git plugin error whose message names the failure and the next action.
 *
 * Callers throw it or return `message` as a block reason. The command is not given a second error type.
 *
 * @param {string} message Error template. `%s` is replaced from `args`.
 * @param {(string | number)[]} [args=[]] Values for each `%s` in `message`.
 * @returns {CosplayError} Error with method `git`.
 */
function gitError(message, args = []) {
  return new CosplayError({ name: 'cli', method: 'git', message, args });
}

/**
 * Finds the Git subcommand after the global options.
 *
 * Attribution applies only to known subcommands. An option this plugin does not recognize is a block reason, because the subcommand might still create a commit. `--` before the subcommand is also a block reason. `--help` and `--version` are not attributed.
 *
 * @param {string[]} args Arguments after the `git` executable, including global options.
 * @returns {{command: string, index: number, blockedReason?: string} | {command: null, index: number, blockedReason: string} | null} The subcommand and the index of its name. A blocked result when the command cannot be classified. Null when the invocation is help, version, or has no subcommand.
 */
function commandInfo(args) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      return {
        command: null,
        index,
        blockedReason: gitError('cannot classify a Git command after the option separator. Remove -- before the command and retry through cosplaying hook.').message,
      };
    }
    if (TERMINAL_FLAGS.has(arg)) return null;
    if (!arg.startsWith('-')) return { command: arg, index };
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (VALUE_FLAGS.has(flag)) index += equals < 0 ? 2 : 1;
    else if (GLOBAL_FLAGS.has(flag)) index += 1;
    else {
      return {
        command: null,
        index,
        blockedReason: gitError('cannot classify the Git command after option %s. Use a supported global option, then retry through cosplaying hook.', [arg]).message,
      };
    }
  }
  return null;
}

/**
 * Converts an `AI-Assisted-By` line into the token `git interpret-trailers` accepts.
 *
 * The trailer line uses a colon. The token uses `key=value`.
 *
 * @param {string} trailer One trailer line, `AI-Assisted-By: <text>`.
 * @returns {string} `AI-Assisted-By=<text>` with the space after the colon removed.
 */
function trailerToken(trailer) {
  const separator = trailer.indexOf(':');
  return `${trailer.slice(0, separator)}=${trailer.slice(separator + 1).trimStart()}`;
}

/**
 * Renders the trailer that a commit created by this command must carry.
 *
 * An empty model or an invalid policy link throws from the attribution helper. The caller turns that into a block reason.
 *
 * @param {object} context Hook context passed to the plugin.
 * @param {{renderTrailer: () => string}} context.attribution Helper that returns one `AI-Assisted-By` line.
 * @returns {string} One trailer line.
 * @throws {CosplayError} The model is empty, the link is not an http(s) URL, or the rendered trailer contains a line break.
 */
function requireTrailer(context) {
  return context.attribution.renderTrailer();
}

/**
 * Adds the attribution trailer to a `git commit` command before Git runs.
 *
 * Other commit-creating commands are recorded so the commits can be rewritten after Git exits. A command that cannot be classified, or a missing model, is returned as a block reason and is not run. Rebase operations that do not write commits are left unchanged.
 *
 * @param {string[]} inputArgs Arguments after the `git` executable.
 * @param {object} context Hook context. `attribution.renderTrailer` supplies the trailer for `commit`.
 * @returns {{args: string[], changed: boolean, command: string | null, blockedReason: string | null, trailer?: string}} Arguments to spawn, whether they differ from the input, the subcommand, a block reason when the command must not run, and the trailer when one was rendered.
 */
function rewriteGitArgs(inputArgs, context) {
  const info = commandInfo(inputArgs);
  if (info?.blockedReason) {
    return { args: [...inputArgs], changed: false, command: null, blockedReason: info.blockedReason };
  }
  if (info?.command === 'rebase' && inputArgs.slice(info.index + 1).some((arg) => REBASE_NO_WRITE.has(arg))) {
    return { args: [...inputArgs], changed: false, command: 'rebase', blockedReason: null };
  }
  if (!info || !COMMIT_CREATORS.has(info.command)) {
    return { args: [...inputArgs], changed: false, command: info?.command || null, blockedReason: null };
  }
  let trailer;
  try {
    trailer = requireTrailer(context);
  } catch (error) {
    return { args: [...inputArgs], changed: false, command: info.command, blockedReason: error.message };
  }
  const args = [...inputArgs];
  if (info.command === 'commit') {
    const separator = args.indexOf('--', info.index + 1);
    args.splice(separator < 0 ? args.length : separator, 0, '--trailer', trailer);
    args.splice(info.index, 0, '-c', 'trailer.AI-Assisted-By.ifExists=replace');
  }
  return { args, changed: info.command === 'commit', command: info.command, blockedReason: null, trailer };
}

/**
 * Runs Git and returns its stdout when the command exits 0.
 *
 * Inspection commands use this. A spawn error or a non-zero status means the fact could not be read, so the caller refuses to guess.
 *
 * @param {string} bin Real `git` executable.
 * @param {string[]} args Arguments, including any global options that were in front of the subcommand.
 * @param {object} [options]
 * @param {string} [options.cwd] Repository working directory.
 * @param {NodeJS.ProcessEnv} [options.env] Environment passed to Git.
 * @param {Function} [options.spawn] Spawn function from the hook context.
 * @param {string | Buffer} [options.input] Stdin for commands such as `interpret-trailers` and `hash-object`.
 * @param {BufferEncoding | 'buffer'} [options.encoding='utf8'] Stdout encoding. `buffer` keeps raw commit bytes.
 * @returns {string | Buffer | null} Stdout on success. Null when Git cannot be run or exits non-zero.
 */
function captureGit(bin, args, { cwd, env, spawn, input, encoding = 'utf8' } = {}) {
  const child = spawn(bin, args, { cwd, env, input, encoding, maxBuffer: Infinity });
  if (!child || child.error || child.status !== 0) return null;
  return child.stdout ?? (encoding === 'utf8' ? '' : Buffer.alloc(0));
}

/**
 * Reads the current `HEAD` commit id.
 *
 * The id from before the Git command is compared with the id after it, so only commits that command created are rewritten.
 *
 * @param {string} bin Real `git` executable.
 * @param {string[]} prefix Global Git options that preceded the subcommand. They are repeated so `--git-dir` still applies.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {string | null} Full `HEAD` oid. Null when `HEAD` does not exist or cannot be read.
 */
function head(bin, prefix, options) {
  return String(captureGit(bin, [...prefix, 'rev-parse', '--verify', 'HEAD'], options) || '').trim() || null;
}

/**
 * Reads one commit object as headers and a raw message.
 *
 * The message bytes are kept intact so a rewrite can add a trailer without changing the rest of the commit. Non-UTF-8 headers are rejected because the header lines are edited as text.
 *
 * @param {string} bin Real `git` executable.
 * @param {string} sha Commit id to read.
 * @param {string[]} prefix Global Git options that preceded the subcommand.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {{headers: string[], message: Buffer} | null} Header lines and the raw message body. Null when the object cannot be read or has no header terminator.
 * @throws {CosplayError} The commit headers are not valid UTF-8.
 */
function commitObject(bin, sha, prefix, options) {
  const raw = captureGit(bin, [...prefix, 'cat-file', '-p', sha], { ...options, encoding: 'buffer' });
  if (!Buffer.isBuffer(raw)) return null;
  const split = raw.indexOf(Buffer.from('\n\n'));
  if (split < 0) return null;
  const headerBytes = raw.subarray(0, split);
  const headerText = headerBytes.toString('utf8');
  if (!Buffer.from(headerText).equals(headerBytes)) {
    throw gitError('commit %s has non-UTF-8 headers. cosplaying will not rewrite it.', [sha]);
  }
  return { headers: headerText.split('\n'), message: raw.subarray(split + 2) };
}

/**
 * Reports whether this `git pull` will rebase instead of merging.
 *
 * A rebase creates different commits from a merge, so the commits are found from `FETCH_HEAD` rather than from a merge commit. The command line wins. Otherwise the branch `rebase` setting, then `pull.rebase`, is read.
 *
 * @param {string} bin Real `git` executable.
 * @param {string[]} args Full Git arguments, including global options.
 * @param {number} index Index of the `pull` word in `args`.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {boolean} True when the pull rebases. False when it merges or the setting is off.
 */
function pullUsesRebase(bin, args, index, options) {
  let requested;
  for (const arg of args.slice(index + 1)) {
    if (arg === '--no-rebase') requested = false;
    else if (arg === '--rebase' || arg === '-r') requested = true;
    else if (arg.startsWith('--rebase=')) {
      requested = !['false', 'no', 'off', '0'].includes(arg.slice('--rebase='.length).trim().toLowerCase());
    }
  }
  if (requested !== undefined) return requested;
  const prefix = args.slice(0, index);
  const branch = String(captureGit(bin, [...prefix, 'symbolic-ref', '--quiet', '--short', 'HEAD'], options) || '').trim();
  const setting = branch
    ? captureGit(bin, [...prefix, 'config', '--get', `branch.${branch}.rebase`], options)
    : null;
  const configured = setting ?? captureGit(bin, [...prefix, 'config', '--get', 'pull.rebase'], options);
  return configured !== null && !['false', 'no', 'off', '0'].includes(String(configured).trim().toLowerCase());
}

/**
 * Reads the `HEAD` reflog from newest to oldest.
 *
 * Merge, pull, and rebase identify the commits they created by comparing the reflog from before the command with the reflog after it.
 *
 * @param {string} bin Real `git` executable.
 * @param {string[]} prefix Global Git options that preceded the subcommand.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {Array<{sha: string, action: string}> | null} Newest entries first. Each entry has the commit id and the reflog subject. Null when the reflog cannot be read.
 */
function reflogEntries(bin, prefix, options) {
  const output = captureGit(bin, [...prefix, 'reflog', '--format=%H%x00%gs', 'HEAD'], options);
  if (output === null) return null;
  return String(output).trimEnd().split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('\0');
    return { sha: line.slice(0, separator), action: line.slice(separator + 1) };
  });
}

/**
 * Returns the reflog entries that were added after a Git command.
 *
 * The old entries must still be the suffix of the new reflog. A reflog that was truncated or rewritten cannot be compared, so the result is null and the caller does not guess which commits were created.
 *
 * @param {Array<{sha: string, action: string}>} before Reflog captured before the command, newest first.
 * @param {Array<{sha: string, action: string}>} after Reflog captured after the command, newest first.
 * @returns {Array<{sha: string, action: string}> | null} The new prefix, newest first. Null when `after` is shorter or the old entries are not a suffix.
 */
function newReflogEntries(before, after) {
  if (after.length < before.length) return null;
  const offset = after.length - before.length;
  if (!before.every((entry, index) => entry.sha === after[offset + index].sha && entry.action === after[offset + index].action)) return null;
  return after.slice(0, offset);
}

/**
 * Writes a new commit object that has the attribution trailer and rewritten parents.
 *
 * A commit that already has the trailer and whose parents did not change is returned as the same id. A signed commit is refused because a new object would invalidate the signature. A non-UTF-8 message encoding is refused.
 *
 * @param {string} bin Real `git` executable.
 * @param {string} sha Commit id to copy.
 * @param {Map<string, string>} parentMap Map of an original parent id to the attributed id that must replace it.
 * @param {string} trailer One `AI-Assisted-By` line.
 * @param {string[]} prefix Global Git options that preceded the subcommand.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {string} Id of the attributed commit. `sha` when no bytes needed to change.
 * @throws {CosplayError} The commit cannot be read or written, is signed, or uses a non-UTF-8 message encoding.
 */
function commitWithTrailer(bin, sha, parentMap, trailer, prefix, options) {
  const commit = commitObject(bin, sha, prefix, options);
  if (!commit) throw gitError('could not read commit %s. Check the repository object store, then retry through cosplaying hook.', [sha]);
  const message = captureGit(bin, [
    ...prefix, '-c', 'trailer.AI-Assisted-By.ifExists=addIfDifferent',
    'interpret-trailers', '--trailer', trailerToken(trailer),
  ], { ...options, input: commit.message, encoding: 'buffer' });
  if (!Buffer.isBuffer(message)) throw gitError('could not add attribution to commit %s. Check the repository object store, then retry through cosplaying hook.', [sha]);
  const parentChanged = commit.headers.some((line) => {
    const parent = line.match(/^parent ([0-9a-f]+)$/);
    return parent && parentMap.has(parent[1]) && parentMap.get(parent[1]) !== parent[1];
  });
  if (!parentChanged && message.equals(commit.message)) return sha;
  if (commit.headers.some((line) => /^(?:gpgsig|gpgsig-sha256) /.test(line))) {
    throw gitError('commit %s is signed. cosplaying will not invalidate its signature. Re-sign it after adding attribution.', [sha]);
  }
  if (commit.headers.some((line) => /^encoding (?!UTF-8$|utf-8$)/i.test(line))) {
    throw gitError('commit %s uses a non-UTF-8 message encoding. cosplaying will not rewrite it.', [sha]);
  }
  const headers = [];
  for (const line of commit.headers) {
    const parent = line.match(/^parent ([0-9a-f]+)$/);
    if (parent && parentMap.has(parent[1])) headers.push(`parent ${parentMap.get(parent[1])}`);
    else headers.push(line);
  }
  const raw = Buffer.concat([Buffer.from(`${headers.join('\n')}\n\n`), message]);
  const rewritten = captureGit(bin, [...prefix, 'hash-object', '-w', '-t', 'commit', '--stdin'], { ...options, input: raw });
  const next = String(rewritten || '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(next)) throw gitError('could not write attributed commit %s. Check the repository object store, then retry through cosplaying hook.', [sha]);
  return next;
}

/**
 * Adds the attribution trailer to commits a Git command just created, then points `HEAD` at the result.
 *
 * `commit`, `cherry-pick`, `revert`, and `am` use the commits reachable from the new `HEAD` and not from the old one. Merge and pull use the new reflog, and a fast-forward is left unchanged. Rebase uses reflog actions that record a commit. `pull --rebase` uses commits reachable from the new `HEAD` and not from `FETCH_HEAD`.
 *
 * @param {string} bin Real `git` executable.
 * @param {string} command Subcommand name. `pull-rebase` selects the fetch-base range.
 * @param {string | null} oldHead `HEAD` before the command. Null when there was no `HEAD`.
 * @param {string | null} newHead `HEAD` after the command. A null or unchanged id does nothing, except for rebase.
 * @param {string} trailer One `AI-Assisted-By` line.
 * @param {string[]} prefix Global Git options that preceded the subcommand.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @param {string | null} [rangeBase] `FETCH_HEAD` id for `pull --rebase`.
 * @param {Array<{sha: string, action: string}> | null} [oldReflog] Reflog from before the command.
 * @param {Array<{sha: string, action: string}> | null} [newReflog] Reflog from after the command.
 * @returns {void} No value. `HEAD` is updated when a commit object changed.
 * @throws {CosplayError} The created commits cannot be identified or rewritten, or `HEAD` moved during the update.
 */
function attributeCreatedCommits(bin, command, oldHead, newHead, trailer, prefix, options, rangeBase, oldReflog, newReflog) {
  if (!newHead || (newHead === oldHead && command !== 'rebase')) return;
  let commits;
  if (command === 'merge' || command === 'pull') {
    const entries = oldReflog && newReflog ? newReflogEntries(oldReflog, newReflog) : null;
    const headEntry = entries?.find((entry) => entry.sha === newHead);
    if (!headEntry) {
      throw gitError('could not identify commits created by %s from the HEAD reflog. The command completed. Do not push these commits.', [command]);
    }
    if (/fast-forward/i.test(headEntry.action)) return;
    commits = [newHead];
  } else if (command === 'pull-rebase') {
    if (!rangeBase) throw gitError('could not read FETCH_HEAD after pull --rebase. The command completed. Do not push these commits.');
    const range = captureGit(bin, [
      ...prefix, 'rev-list', '--topo-order', '--reverse', newHead, `^${rangeBase}`,
    ], options);
    if (range === null) throw gitError('could not list commits created by pull --rebase. The command completed. Do not push these commits.');
    commits = String(range || '').trim().split(/\r?\n/).filter(Boolean);
  } else if (command === 'rebase') {
    const entries = oldReflog && newReflog ? newReflogEntries(oldReflog, newReflog) : null;
    if (!entries) throw gitError('could not identify commits created by rebase from the HEAD reflog. The command completed. Do not push these commits.');
    if (!entries.length) throw gitError('HEAD moved without a new reflog entry during rebase. cosplaying could not verify which commits were created.');
    const candidates = new Set();
    for (const { sha, action } of entries) {
      if (action === 'rebase: fast-forward') continue;
      const step = action.match(/^rebase \(([^)]+)\):/);
      if (step && REBASE_NONCOMMIT_ACTIONS.has(step[1])) continue;
      if (step || /^commit(?: \([^)]+\))?:/.test(action)) candidates.add(sha);
      else if (!/^(?:reset|checkout):/.test(action)) throw gitError('unrecognized HEAD reflog action during rebase: %s', [action || '(empty)']);
    }
    if (!candidates.size) return;
    const range = captureGit(bin, [...prefix, 'rev-list', '--topo-order', '--reverse', newHead], options);
    if (range === null) throw gitError('could not list the rebased commits. The command completed. Do not push these commits.');
    commits = String(range).trim().split(/\r?\n/).filter((sha) => candidates.has(sha));
    if (!commits.length) throw gitError('the rebase reflog commits are not reachable from HEAD. cosplaying will not alter unrelated history.');
  } else if (REWRITE_AFTER.has(command)) {
    const range = captureGit(bin, [
      ...prefix, 'rev-list', '--first-parent', '--reverse', newHead,
      ...(oldHead ? [`^${oldHead}`] : []),
    ], options);
    if (range === null) throw gitError('could not list commits created by %s. The command completed. Do not push these commits.', [command]);
    commits = String(range).trim().split(/\r?\n/).filter(Boolean);
  } else return;
  if (!commits.length) return;

  const parentMap = new Map();
  for (const sha of commits) parentMap.set(sha, commitWithTrailer(bin, sha, parentMap, trailer, prefix, options));
  if (parentMap.get(newHead) === newHead) return;
  const ref = String(captureGit(bin, [...prefix, 'symbolic-ref', '-q', 'HEAD'], options) || '').trim() || 'HEAD';
  const result = captureGit(bin, [
    ...prefix, 'update-ref', ref, parentMap.get(newHead) || newHead,
    ...(newHead ? [newHead] : []),
  ], options);
  if (result === null) throw gitError('HEAD moved while cosplaying was adding commit trailers. Do not push these commits.');
}

/**
 * Lists the commits a `git push` would send to the destination.
 *
 * Dry-run and delete pushes send no commits. A push that can send more than one ref, a wildcard, a negative refspec, or `push.default=matching` is an error because each destination cannot be checked. A commit list that cannot be read is null so the push is blocked instead of allowed.
 *
 * @param {string} bin Real `git` executable.
 * @param {string[]} args Full Git arguments, including global options.
 * @param {{command: string, index: number}} info Parsed `push` command. `index` is the `push` word.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {Array<{sha: string, email: string, trailer: string, subject: string}> | CosplayError | null} Outgoing commits. An error when the destinations are ambiguous. Null when the remote or the commit list cannot be read.
 */
function outgoingCommits(bin, args, info, options) {
  const prefix = args.slice(0, info.index);
  const format = '--format=%H%x00%ce%x00%(trailers:key=AI-Assisted-By,valueonly,separator=%x1e)%x00%s';
  /**
   * Lists commits selected by a `git log` range, with the committer email and the attribution trailer.
   *
   * @param {string[]} range Revision arguments passed to `git log`, for example a source and `--not` tips.
   * @returns {Array<{sha: string, email: string, trailer: string, subject: string}> | null} One record per commit. Null when `git log` cannot be run.
   */
  const branchCommits = (range) => {
    const output = captureGit(bin, [...prefix, 'log', format, '--stdin'], { ...options, input: `${range.join('\n')}\n` });
    if (output === null) return null;
    return String(output).trimEnd().split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, email, trailer, subject] = line.split('\0');
      return { sha, email, trailer, subject };
    });
  };

  const tail = args.slice(info.index + 1);
  if (tail.some((arg) => ['--delete', '-d', '--dry-run', '-n'].includes(arg))) return [];
  if (tail.some((arg) => ['--all', '--mirror', '--tags'].includes(arg))) {
    return gitError('this push can send multiple refs. Pass explicit refspecs through cosplaying hook so each destination can be checked.');
  }
  const upstream = captureGit(bin, [...prefix, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], options);
  const branch = String(captureGit(bin, [...prefix, 'symbolic-ref', '--quiet', '--short', 'HEAD'], options) || '').trim();
  const branchPushRemote = branch ? captureGit(bin, [...prefix, 'config', '--get', `branch.${branch}.pushRemote`], options) : null;
  const defaultPushRemote = captureGit(bin, [...prefix, 'config', '--get', 'remote.pushDefault'], options);
  const upstreamRef = String(upstream || '').trim();
  const configuredRemotes = String(captureGit(bin, [...prefix, 'remote'], options) || '').split(/\r?\n/).filter(Boolean);
  const upstreamRemote = configuredRemotes
    .filter((name) => upstreamRef.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)[0] || upstreamRef.split('/')[0];
  const upstreamBranch = upstreamRef.startsWith(`${upstreamRemote}/`) ? upstreamRef.slice(upstreamRemote.length + 1) : '';
  const positional = [];
  let optionRemote;
  const valuedOptions = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo', '--recurse-submodules']);
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (valuedOptions.has(arg)) {
      if (arg === '--repo') optionRemote = tail[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  const equalsRemote = tail.find((arg) => arg.startsWith('--repo='))?.slice('--repo='.length);
  /**
   * Reports whether a positional push argument is a refspec rather than a remote name.
   *
   * The first positional word is the remote only when it does not look like a refspec.
   *
   * @param {string} value Positional argument after `git push`.
   * @returns {boolean} True when the value contains `:`, starts with `+` or `^`, or is `HEAD`.
   */
  const looksLikeRefspec = (value) => value.includes(':') || value.startsWith('+') || value.startsWith('^') || value === 'HEAD';
  const positionalHasRemote = !optionRemote && !equalsRemote && positional.length > 0 && !looksLikeRefspec(positional[0]);
  const explicitRemote = equalsRemote || optionRemote || (positionalHasRemote ? positional[0] : undefined);
  const remote = explicitRemote || String(branchPushRemote || defaultPushRemote || upstreamRemote || 'origin').trim();
  const refspecs = optionRemote || equalsRemote ? positional : positionalHasRemote ? positional.slice(1) : positional;
  /**
   * Lists the push URLs for the selected remote.
   *
   * A name that is not a configured remote is used as a URL. A configured remote can have more than one push URL, and each URL is checked.
   *
   * @returns {string[] | null} Push URLs. Null when the remote list or the push URLs cannot be read.
   */
  const pushTargets = () => {
    const remotes = captureGit(bin, [...prefix, 'remote'], options);
    if (remotes === null) return null;
    if (!String(remotes).split(/\r?\n/).includes(remote)) return [remote];
    const output = captureGit(bin, [...prefix, 'remote', 'get-url', '--push', '--all', remote], options);
    if (output === null) return null;
    const targets = String(output).trim().split(/\r?\n/).filter(Boolean);
    return targets.length ? targets : null;
  };
  /**
   * Lists commits from `source` that are not already on every push URL.
   *
   * Advertised tips from each push URL are excluded when their commit objects are available locally. A remote that cannot be queried fails the whole lookup.
   *
   * @param {string} source Local revision, such as `HEAD` or a branch name.
   * @param {string} destination Destination ref, such as `refs/heads/main`.
   * @returns {Array<{sha: string, email: string, trailer: string, subject: string}> | null} Commits that are not already on every reachable tip. Null when a remote query fails or `destination` is empty.
   */
  const commitsFor = (source, destination) => {
    if (!destination) return null;
    const targets = pushTargets();
    if (!targets) return null;
    const commits = new Map();
    for (const target of targets) {
      const output = captureGit(bin, [...prefix, 'ls-remote', '--refs', target], options);
      if (output === null) return null;
      const tips = [...new Set(String(output).trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/)[0]))];
      const objects = captureGit(bin, [...prefix, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        ...options, input: tips.map((sha) => `${sha}^{commit}\n`).join(''),
      });
      if (objects === null) return null;
      const knownTips = String(objects).trim().split(/\r?\n/).flatMap((line) => {
        const [sha, type] = line.split(' ');
        return type === 'commit' ? [sha] : [];
      });
      const outgoing = branchCommits(knownTips.length ? [source, ...knownTips.map((tip) => `^${tip}`)] : [source]);
      if (!outgoing) return null;
      for (const commit of outgoing) commits.set(commit.sha, commit);
    }
    return [...commits.values()];
  };
  /**
   * Turns a refspec destination into a full ref name.
   *
   * A destination that already starts with `refs/` is kept. A short name is expanded from the source namespace, so a branch stays a branch and a tag stays a tag.
   *
   * @param {string} source Source side of the refspec.
   * @param {string | undefined} destination Destination side. Undefined means the destination is the same ref as the source.
   * @returns {string | null} Full destination ref. Null when the source ref cannot be resolved or its namespace is not a branch or a tag.
   */
  const destinationFor = (source, destination) => {
    if (destination?.startsWith('refs/')) return destination;
    const sourceRef = String(captureGit(bin, [...prefix, 'rev-parse', '--symbolic-full-name', source], options) || '').trim();
    if (!sourceRef.startsWith('refs/')) return null;
    if (!destination) return sourceRef;
    if (sourceRef.startsWith('refs/heads/')) return `refs/heads/${destination}`;
    if (sourceRef.startsWith('refs/tags/')) return `refs/tags/${destination}`;
    return null;
  };
  /**
   * Lists the commits that an explicit list of refspecs would send.
   *
   * A matching refspec, a negative refspec, a wildcard, or a destination that cannot be resolved is an error. Those forms can send refs this check would miss.
   *
   * @param {string[]} specs Refspecs from the command line or from `remote.<name>.push`.
   * @returns {Array<{sha: string, email: string, trailer: string, subject: string}> | CosplayError | null} Combined commits. An error for an ambiguous refspec. Null when a commit list cannot be read.
   */
  const inspectRefspecs = (specs) => {
    const commits = new Map();
    for (const refspec of specs) {
      const normalized = refspec.replace(/^\+/, '');
      const separator = normalized.indexOf(':');
      const source = separator < 0 ? normalized : normalized.slice(0, separator);
      const destinationSpec = separator < 0 ? undefined : normalized.slice(separator + 1);
      if (!source && !destinationSpec) {
        return gitError('matching push refspecs can send other branches. Pass one explicit source:destination refspec at a time through cosplaying hook.');
      }
      if (!source) continue;
      if (source.startsWith('^')) {
        return gitError('negative push refspecs cannot be inspected. Pass an explicit source:destination refspec through cosplaying hook.');
      }
      if (source.includes('*') || destinationSpec?.includes('*')) {
        return gitError('wildcard push refspecs can send multiple refs. Pass one explicit refspec at a time through cosplaying hook.');
      }
      if (separator >= 0 && destinationSpec === '') {
        return gitError('could not determine the destination ref for push refspec %s. Pass an explicit source:destination refspec through cosplaying hook.', [refspec]);
      }
      const destination = destinationFor(source, destinationSpec);
      if (!destination) {
        return gitError('could not determine the destination ref for push refspec %s. Pass an explicit source:destination refspec through cosplaying hook.', [refspec]);
      }
      const outgoing = commitsFor(source, destination);
      if (!outgoing) return null;
      for (const commit of outgoing) commits.set(commit.sha, commit);
    }
    return [...commits.values()];
  };
  if (refspecs.length) return inspectRefspecs(refspecs);
  const remotePush = captureGit(bin, [...prefix, 'config', '--get-all', `remote.${remote}.push`], options);
  if (remotePush !== null && String(remotePush).trim()) {
    const configuredRefspecs = String(remotePush).trim().split(/\r?\n/).filter(Boolean);
    return inspectRefspecs(configuredRefspecs);
  }
  const pushDefaultValue = captureGit(bin, [...prefix, 'config', '--get', 'push.default'], options);
  const pushDefault = String(pushDefaultValue || 'simple').trim().toLowerCase();
  if (pushDefault === 'matching') {
    return gitError('push.default=matching can send other branches. Pass explicit refspecs through cosplaying hook, or set push.default to simple, upstream, or current.');
  }
  if (pushDefault === 'nothing') return [];
  if (!['simple', 'upstream', 'current'].includes(pushDefault)) {
    return gitError('could not determine which branches this push will send. Configure push.default or pass an explicit refspec through cosplaying hook.');
  }
  if (pushDefault !== 'current' && (!upstreamRef || !upstreamBranch)) {
    return gitError('could not identify the upstream branch for this push. Set an upstream or pass an explicit refspec through cosplaying hook.');
  }
  if (pushDefault !== 'current' && explicitRemote && explicitRemote !== upstreamRemote) {
    return gitError('push destination %s does not match the upstream remote %s. Pass an explicit refspec through cosplaying hook.', [explicitRemote, upstreamRemote]);
  }
  if (pushDefault === 'simple' && upstreamBranch !== branch) {
    return gitError('the upstream branch does not match the current branch. Pass an explicit refspec through cosplaying hook.');
  }
  const destinationBranch = pushDefault === 'current' ? branch : upstreamBranch;
  if (!destinationBranch) return gitError('could not determine the destination branch for this push. Set an upstream or pass an explicit refspec through cosplaying hook.');
  return commitsFor('HEAD', `refs/heads/${destinationBranch}`);
}

/**
 * Returns the reason a push must not run, or null when the push may run.
 *
 * A push is blocked when a commit that this repository's committer authored has no `AI-Assisted-By` trailer. Commits by other authors are not blocked. No model means this push is not an attributed session, so it is not blocked here.
 *
 * @param {string} bin Real `git` executable.
 * @param {string[]} args Full Git arguments.
 * @param {{command: string, index: number}} info Parsed `push` command.
 * @param {object} context Hook context. `model` selects whether the check applies.
 * @param {object} options Spawn options passed to {@link captureGit}.
 * @returns {string | null} Block reason for stderr. Null when the push may run.
 */
function pushBlockReason(bin, args, info, context, options) {
  if (!context.model) return null;
  const outgoing = outgoingCommits(bin, args, info, options);
  if (outgoing instanceof CosplayError) return outgoing.message;
  if (!outgoing) return gitError('could not inspect outgoing commits for the destination remote. Check the remote connection and settings, then retry through cosplaying hook. The push was not run.').message;
  if (!outgoing.length) return null;
  const identity = captureGit(bin, [...args.slice(0, info.index), 'var', 'GIT_COMMITTER_IDENT'], options);
  const email = String(identity || '').match(/<([^>]+)>/)?.[1]?.toLowerCase();
  if (!email) return gitError('could not determine the local Git committer identity. Configure user.name and user.email, then retry through cosplaying hook. The push was not run.').message;
  const blocked = outgoing.filter((commit) => commit.email?.toLowerCase() === email && !commit.trailer?.trim());
  if (!blocked.length) return null;
  const list = blocked.map(({ sha, subject }) => `  ${sha.slice(0, 12)} ${subject || '(no subject)'}`).join('\n');
  return gitError('outgoing commits from the local committer lack AI-Assisted-By:\n%s\nRepair or replay them through cosplaying before pushing.', [list]).message;
}

/**
 * Runs Git after adding attribution to commits this command creates.
 *
 * `commit` receives the trailer on its command line. Merge, pull, cherry-pick, revert, am, and rebase are attributed after Git exits, using the commits those commands created. `push` is refused when an outgoing commit from the local committer has no trailer. The real Git executable is `context.realBin`.
 *
 * @param {string[]} args Arguments after `git`.
 * @param {object} context Hook context.
 * @param {string} context.model Model name. An empty model blocks a commit that needs a trailer and skips the push check.
 * @param {string} context.cwd Repository working directory.
 * @param {NodeJS.ProcessEnv} context.env Environment passed to Git.
 * @param {NodeJS.WritableStream} context.stderr Stream that receives a block reason.
 * @param {string} context.realBin Absolute path of the real `git` executable.
 * @param {Function} context.spawn Spawn function. It returns a `{ status }` result.
 * @param {{renderTrailer: () => string}} context.attribution Helper that builds the trailer.
 * @returns {Promise<number>} Git's exit status. `2` when the command is blocked before Git runs. The Git status, or `2` when it is missing, when attribution repair fails after Git exits.
 */
export default async function run(args, context) {
  const prepared = rewriteGitArgs(args, context);
  if (prepared.blockedReason) {
    block(context.stderr, prepared.blockedReason);
    return 2;
  }
  const info = commandInfo(args);
  const bin = context.realBin;
  const options = { cwd: context.cwd, env: context.env, spawn: context.spawn };
  if (info?.command === 'push') {
    const reason = pushBlockReason(bin, args, info, context, options);
    if (reason) {
      block(context.stderr, reason);
      return 2;
    }
  }

  const prefix = args.slice(0, info?.index ?? 0);
  const pullRebase = info?.command === 'pull' && pullUsesRebase(bin, args, info.index, options);
  const rebaseOperation = info?.command === 'rebase' && !args.slice(info.index + 1).some((arg) => REBASE_NO_WRITE.has(arg));
  const tracksCreatedCommits = Boolean(info && (['merge', 'pull', ...REWRITE_AFTER].includes(info.command) || rebaseOperation));
  const before = tracksCreatedCommits ? head(bin, prefix, options) : null;
  const inspectsReflog = rebaseOperation || info?.command === 'merge' || info?.command === 'pull';
  const oldReflog = inspectsReflog ? reflogEntries(bin, prefix, options) : null;
  if (rebaseOperation && oldReflog === null) {
    block(context.stderr, gitError('could not inspect the HEAD reflog needed to identify commits created by the rebase. The rebase was not run.').message);
    return 2;
  }
  const child = await Promise.resolve(context.spawn(bin, prepared.args, {
    cwd: context.cwd,
    env: context.env,
    stdio: 'inherit',
  }));
  if (child.error) return child.status ?? 127;
  const status = child.status ?? 1;
  if (tracksCreatedCommits) {
    const after = head(bin, prefix, options);
    if (after === null && (status === 0 || before !== null)) {
      const error = gitError('could not read HEAD after Git completed. Check the repository refs before you push.');
      context.stderr.write(`cosplaying: BLOCKED after Git completed. Attribution repair failed. Do not push these commits. Reason: ${error.message}\n`);
      return status || 2;
    }
    const newReflog = inspectsReflog ? reflogEntries(bin, prefix, options) : null;
    const rebaseHasNewEntries = newReflog && (newReflogEntries(oldReflog, newReflog)?.length ?? 0) > 0;
    if (after && (after !== before || rebaseHasNewEntries)) {
      try {
        const trailer = requireTrailer(context);
        const rangeBase = pullRebase
          ? String(captureGit(bin, [...prefix, 'rev-parse', '--verify', 'FETCH_HEAD'], options) || '').trim() || null
          : null;
        attributeCreatedCommits(
          bin,
          pullRebase ? 'pull-rebase' : rebaseOperation ? 'rebase' : info.command,
          before,
          after,
          trailer,
          prefix,
          options,
          rangeBase,
          oldReflog,
          newReflog,
        );
      } catch (error) {
        context.stderr.write(`cosplaying: BLOCKED after Git completed. Attribution repair failed. Do not push these commits. Reason: ${error.message}\n`);
        return status || 2;
      }
    }
  }
  return status;
}
