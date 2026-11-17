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
  '--bare', '--exec-path', '--glob-pathspecs', '--html-path', '--icase-pathspecs', '--info-path',
  '--literal-pathspecs', '--man-path', '--no-lazy-fetch', '--no-optional-locks', '--no-pager',
  '--no-replace-objects', '--noglob-pathspecs', '--paginate', '-P', '-p',
]);

/** @type {Set<string>} */
const COMMIT_CREATORS = new Set(['commit', 'merge', 'pull', 'cherry-pick', 'revert', 'am', 'rebase']);

/** @type {Set<string>} */
const REWRITE_AFTER = new Set(['commit', 'cherry-pick', 'revert', 'am']);

/** @type {Set<string>} */
const REBASE_NO_WRITE = new Set(['--abort', '--quit', '--show-current-patch', '--edit-todo']);

/** @type {Set<string>} */
const REBASE_NONCOMMIT_ACTIONS = new Set(['start', 'finish', 'abort', 'quit', 'reset']);

/**
 * @param {string} message
 * @param {(string | number)[]} [args]
 * @returns {CosplayError}
 */
function gitError(message, args = []) {
  return new CosplayError({ name: 'cli', method: 'git', message, args });
}

/**
 * @param {string[]} args
 * @returns {{command: string, index: number} | null}
 */
function commandInfo(args) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') return null;
    if (!arg.startsWith('-')) return { command: arg, index };
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (VALUE_FLAGS.has(flag)) index += equals < 0 ? 2 : 1;
    else if (GLOBAL_FLAGS.has(flag)) index += 1;
    else return null;
  }
  return null;
}

/**
 * @param {string} trailer
 * @returns {string}
 */
function trailerToken(trailer) {
  const separator = trailer.indexOf(':');
  return `${trailer.slice(0, separator)}=${trailer.slice(separator + 1).trimStart()}`;
}

/**
 * @param {object} context
 * @returns {string}
 */
function requireTrailer(context) {
  return context.attribution.renderTrailer();
}

/**
 * @param {string[]} inputArgs
 * @param {object} context
 */
function rewriteGitArgs(inputArgs, context) {
  const info = commandInfo(inputArgs);
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
 * @param {string} bin
 * @param {string[]} args
 * @param {object} options
 * @returns {string | Buffer | null}
 */
function captureGit(bin, args, { cwd, env, spawn, input, encoding = 'utf8' } = {}) {
  const child = spawn(bin, args, { cwd, env, input, encoding });
  if (!child || child.error || child.status !== 0) return null;
  return child.stdout ?? (encoding === 'utf8' ? '' : Buffer.alloc(0));
}

/**
 * @param {string} bin
 * @param {string[]} prefix
 * @param {object} options
 * @returns {string | null}
 */
function head(bin, prefix, options) {
  return String(captureGit(bin, [...prefix, 'rev-parse', '--verify', 'HEAD'], options) || '').trim() || null;
}

/**
 * @param {string} bin
 * @param {string} sha
 * @param {string[]} prefix
 * @param {object} options
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
 * @param {string} bin
 * @param {string[]} args
 * @param {number} index
 * @param {object} options
 * @returns {boolean}
 */
function pullUsesRebase(bin, args, index, options) {
  let requested;
  for (const arg of args.slice(index + 1)) {
    if (arg === '--no-rebase') requested = false;
    else if (arg === '--rebase' || arg.startsWith('--rebase=') || arg === '-r') requested = true;
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
 * @param {string} bin
 * @param {string[]} prefix
 * @param {object} options
 * @returns {Array<{sha: string, action: string}> | null}
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
 * @param {Array<{sha: string, action: string}>} before
 * @param {Array<{sha: string, action: string}>} after
 * @returns {Array<{sha: string, action: string}> | null}
 */
function newReflogEntries(before, after) {
  if (after.length < before.length) return null;
  const offset = after.length - before.length;
  if (!before.every((entry, index) => entry.sha === after[offset + index].sha && entry.action === after[offset + index].action)) return null;
  return after.slice(0, offset);
}

/**
 * @param {string} bin
 * @param {string} sha
 * @param {Map<string, string>} parentMap
 * @param {string} trailer
 * @param {string[]} prefix
 * @param {object} options
 * @returns {string}
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
 * @param {string} bin
 * @param {string} command
 * @param {string | null} oldHead
 * @param {string | null} newHead
 * @param {string} trailer
 * @param {string[]} prefix
 * @param {object} options
 * @param {string | null} [rangeBase]
 * @param {Array<{sha: string, action: string}> | null} [oldReflog]
 * @param {Array<{sha: string, action: string}> | null} [newReflog]
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
 * @param {string} bin
 * @param {string[]} args
 * @param {{command: string, index: number}} info
 * @param {object} options
 * @returns {Array<{sha: string, email: string, trailer: string, subject: string}> | CosplayError | null}
 */
function outgoingCommits(bin, args, info, options) {
  const prefix = args.slice(0, info.index);
  const format = '--format=%H%x00%ce%x00%(trailers:key=AI-Assisted-By,valueonly,separator=%x1e)%x00%s';
  const branchCommits = (range) => {
    const output = captureGit(bin, [...prefix, 'log', format, ...range], options);
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
  const upstreamRemote = upstreamRef.split('/')[0];
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
  const looksLikeRefspec = (value) => value.includes(':') || value.startsWith('+') || value.startsWith('^') || value === 'HEAD';
  const positionalHasRemote = !optionRemote && !equalsRemote && positional.length > 0 && !looksLikeRefspec(positional[0]);
  const explicitRemote = equalsRemote || optionRemote || (positionalHasRemote ? positional[0] : undefined);
  const remote = explicitRemote || String(branchPushRemote || defaultPushRemote || upstreamRemote || 'origin').trim();
  const refspecs = optionRemote || equalsRemote ? positional : positionalHasRemote ? positional.slice(1) : positional;
  const pushTargets = () => {
    const remotes = captureGit(bin, [...prefix, 'remote'], options);
    if (remotes === null) return null;
    if (!String(remotes).split(/\r?\n/).includes(remote)) return [remote];
    const output = captureGit(bin, [...prefix, 'remote', 'get-url', '--push', '--all', remote], options);
    if (output === null) return null;
    const targets = String(output).trim().split(/\r?\n/).filter(Boolean);
    return targets.length ? targets : null;
  };
  const commitsFor = (source) => {
    const targets = pushTargets();
    if (!targets) return null;
    const commits = new Map();
    for (const target of targets) {
      const output = captureGit(bin, [...prefix, 'ls-remote', '--refs', target], options);
      if (output === null) return null;
      const tips = String(output).trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/, 1)[0]);
      const outgoing = branchCommits(tips.length ? [source, '--not', ...tips] : [source]);
      if (!outgoing) return null;
      for (const commit of outgoing) commits.set(commit.sha, commit);
    }
    return [...commits.values()];
  };
  if (refspecs.length) {
    const commits = new Map();
    for (const refspec of refspecs) {
      const [sourceSpec, destinationSpec] = refspec.replace(/^\+/, '').split(':', 2);
      const source = sourceSpec;
      if (!source || source.startsWith('^')) continue;
      if (source.includes('*') || destinationSpec?.includes('*')) {
        return gitError('wildcard push refspecs can send multiple refs. Pass one explicit refspec at a time through cosplaying hook.');
      }
      const outgoing = commitsFor(source);
      if (!outgoing) return null;
      for (const commit of outgoing) commits.set(commit.sha, commit);
    }
    return [...commits.values()];
  }
  const remotePush = captureGit(bin, [...prefix, 'config', '--get-all', `remote.${remote}.push`], options);
  if (remotePush !== null && String(remotePush).trim()) {
    return gitError('push configuration for remote %s sets refspecs. Pass explicit refspecs through cosplaying hook, or remove that setting.', [remote]);
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
  if (pushDefault !== 'current' && !upstreamRef) {
    return gitError('could not identify the upstream branch for this push. Set an upstream or pass an explicit refspec through cosplaying hook.');
  }
  if (pushDefault !== 'current' && explicitRemote && explicitRemote !== upstreamRemote) {
    return gitError('push destination %s does not match the upstream remote %s. Pass an explicit refspec through cosplaying hook.', [explicitRemote, upstreamRemote]);
  }
  if (pushDefault === 'simple' && upstreamRef.split('/').at(-1) !== branch) {
    return gitError('the upstream branch does not match the current branch. Pass an explicit refspec through cosplaying hook.');
  }
  return commitsFor('HEAD');
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{command: string, index: number}} info
 * @param {object} context
 * @param {object} options
 * @returns {string | null}
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
 * @param {{status?: number | null}} result
 * @returns {number}
 */
function exitCode(result) {
  return typeof result?.status === 'number' ? result.status : 1;
}

/**
 * @param {string[]} args
 * @param {object} context
 * @returns {Promise<number>}
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
  if (child?.error) return child.status ?? 127;
  const status = exitCode(child);
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
