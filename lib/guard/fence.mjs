// Role fences: what each falsifiable role agent may write, read and run. They
// are allow-lists, so a role can use only what its job needs.
//
//   fence({tool, input, agentType, cwd, scratchpadDir, projectDir}, config)
//     -> {allow: true} | {allow: false, rule, message}
//
// Only agent types falsifiable:<role> are fenced. The main session, other
// agents and the builder pass; the workflow and the reviewer check a builder.
//
//   planner    writes only <specsDir>/changes/*/tasks.md; reads and runs freely
//   verifier   writes only .verify/**; reads only the change specs, .verify/
//              and verify.readPaths; runs only curl or wget to the local app,
//              a few housekeeping commands and verify.commands; uses only the
//              verify.mcpServers MCP servers; never sees the diff or the web
//   reviewer   writes nothing; runs only read-only commands and read-shaped
//   scout      MCP tools; reads anything
//
// Shell output may also go to /dev/null or the agent's scratchpad, and no
// fenced role changes the repository through git. An allowed path is judged
// against the root of the git worktree that holds it, so it is allowed in
// every worktree of the project's repository and nowhere else. Paths compare
// case-insensitively. Shell reading and program detection are best effort.
//
// Tests: node --test test/guard/fence.test.mjs
import os from 'node:os';
import path from 'node:path';

import { PLUGIN } from '../config.mjs';
import { contains, matches } from '../glob.mjs';
import { positionals, splitGit } from './args.mjs';
import { blockMessage } from './engine.mjs';
import { ghCall } from './packs/github.mjs';
import { writeTargets } from './packs/paths.mjs';
import { collectCommands, unwrapCommand } from './shell.mjs';
import { isInside, realTarget, sharedGitDir, worktreeRoot } from './worktree.mjs';

const ALLOW = Object.freeze({ allow: true });
const deny = (rule, why, instead) => ({ allow: false, rule, message: blockMessage(rule, why, instead) });
const malformed = (why) => deny('malformed-input', why, 'The guard fails closed; retry the tool call with the missing field');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toPosix = (p) => p.split(path.sep).join('/');
const lower = (p) => toPosix(String(p)).toLowerCase();

const WRITE_TOOLS = {
  Write: (input) => input.file_path,
  Edit: (input) => input.file_path,
  MultiEdit: (input) => input.file_path,
  NotebookEdit: (input) => input.notebook_path,
};

const READ_INSTEAD = 'Judge the scenario from the running app; read only the change specs, .verify/ and the paths the config lets the verifier read';
const PROGRAM_INSTEAD = 'Drive the running app with curl to the local base URL, your browser tool, or a configured test command, and report what you find';

const SPEC_READS = (config) => [`${config.delivery.specsDir}/changes/**/specs/**`, '.verify/**', ...config.verify.readPaths];

const POLICIES = {
  planner: (config) => ({
    role: 'planner',
    writes: [`${config.delivery.specsDir}/changes/*/tasks.md`],
    writeInstead: "Write the plan into the change's tasks.md and leave every other file to the builders",
    reads: null,
    programs: null,
  }),
  verifier: (config) => ({
    role: 'verifier',
    writes: ['.verify/**'],
    writeInstead: 'Keep evidence under .verify/ and report defects in your result instead of fixing them',
    reads: SPEC_READS(config),
    programs: 'verifier',
    mcpServers: config.verify.mcpServers,
    commands: config.verify.commands,
  }),
  reviewer: (config) => ({ role: 'reviewer', writes: [], writeInstead: 'Put what you found in your result instead', reads: null, programs: 'review', secondOpinion: config.review.secondOpinion }),
  scout: (config) => ({ role: 'scout', writes: [], writeInstead: 'Put what you found in your result instead', reads: null, programs: 'review', secondOpinion: config.review.secondOpinion }),
};

/** The fenced role an agent type names (falsifiable:verifier -> verifier), or null. */
function roleOf(agentType) {
  const prefix = `${PLUGIN}:`;
  if (typeof agentType !== 'string' || !agentType.startsWith(prefix)) return null;
  const role = agentType.slice(prefix.length);
  return Object.hasOwn(POLICIES, role) ? role : null;
}

// ── where a path is ─────────────────────────────────────────────────────────

/** A path inside a worktree as {root, relative}; outside every worktree, root is null and relative is the absolute path. */
function locate(target) {
  const root = worktreeRoot(target);
  return root ? { root, relative: toPosix(path.relative(root, target)) } : { root: null, relative: toPosix(target) };
}

/** The target and, when a symlink leads elsewhere, where it really lands. A broken symlink yields only the target. */
function asWrittenAndReal(target) {
  try {
    const real = realTarget(target);
    return real === target ? [target] : [target, real];
  } catch {
    return [target];
  }
}

/** True when `target` really lands inside the scratchpad, symlinks resolved. */
function inScratchpad(target, scratchpadDir) {
  if (!scratchpadDir) return false;
  try {
    return isInside(realTarget(target), realTarget(path.resolve(scratchpadDir)));
  } catch {
    return false;
  }
}

/** The git folder the project shares, or a reason the project cannot be placed. */
function repositoryOf(place) {
  if (!place.projectDir) return { problem: 'the project folder is unknown' };
  const projectRoot = worktreeRoot(path.resolve(place.projectDir));
  if (!projectRoot) return { problem: `the project ${place.projectDir} is not in a git repository` };
  return { repository: sharedGitDir(projectRoot) };
}

/** Why writing the absolute `target` breaks the allow-list `globs`, or null when it may. */
function writeProblem(target, globs, place) {
  const { repository, problem } = repositoryOf(place);
  if (problem) return problem;
  const judge = (file) => {
    const { root, relative } = locate(file);
    if (!root || sharedGitDir(root) !== repository) return `${file} is outside every worktree of this repository`;
    return globs.some((glob) => contains(lower(glob), lower(relative))) ? null : `${relative} is outside it`;
  };
  const asWritten = judge(target);
  if (asWritten) return asWritten;
  let real;
  try {
    real = realTarget(target);
  } catch {
    return `${target} goes through a broken symlink`;
  }
  const landing = real === target ? null : judge(real);
  return landing && `${target} leads through a symlink, and ${landing}`;
}

/** Why the verifier may not read the absolute `target`, or null when it may. */
function readProblem(target, policy, place) {
  for (const real of asWrittenAndReal(target)) {
    if (inScratchpad(real, place.scratchpadDir)) continue;
    const { root, relative } = locate(real);
    if (root === null) return `${relative} is outside every worktree, which the verifier may not read`;
    if (!policy.reads.some((glob) => matches(lower(glob), lower(relative)))) {
      return `${relative} is outside the change specs, .verify/ and the configured read paths`;
    }
  }
  return null;
}

/** Why the verifier may not search the absolute folder `root`, or null when it may. A search reads every file under it. */
function searchProblem(root, policy, place) {
  for (const real of asWrittenAndReal(root)) {
    if (inScratchpad(real, place.scratchpadDir)) continue;
    const { root: worktree, relative } = locate(real);
    if (worktree === null) return `${relative} is outside every worktree, which the verifier may not search`;
    const inner = relative === '' ? '**' : `${lower(relative)}/**`;
    if (!policy.reads.some((glob) => contains(lower(glob), inner))) {
      return `a search of ${relative || 'the whole worktree'} reaches outside the change specs, .verify/ and the configured read paths`;
    }
  }
  return null;
}

/** A shell word as an absolute path, or null when the guard cannot tell where it points. */
function shellPath(word, dir) {
  if (typeof word !== 'string' || word === '' || /[$`]/.test(word)) return null;
  const glob = word.replace(/\[[^\]]*\]/g, '?');
  if (glob === '~' || glob.startsWith('~/')) return path.join(os.homedir(), glob.slice(1));
  if (glob.startsWith('~')) return null;
  if (path.isAbsolute(glob)) return path.normalize(glob);
  return dir ? path.resolve(dir, glob) : null;
}

const DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** Why a shell write to `word` breaks the role's fence, or null when it may. */
function shellWriteProblem(word, dir, policy, place) {
  if (DEVICES.test(word)) return null;
  const target = shellPath(word, dir);
  if (target === null) return `the guard cannot tell where ${word} points`;
  if (inScratchpad(target, place.scratchpadDir)) return null;
  if (policy.writes.length === 0) return `this command writes ${word}`;
  return writeProblem(target, policy.writes, place);
}

/** Where a Glob call starts: its folder plus the pattern's leading folders that hold no wildcard. */
function globRoot(input, cwd) {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const leading = [];
  for (const segment of pattern.split('/')) {
    if (/[*?[{]/.test(segment)) break;
    leading.push(segment);
  }
  return path.resolve(cwd, typeof input.path === 'string' ? input.path : '.', leading.join('/') || '.');
}

// ── what the verifier may not see ───────────────────────────────────────────

const GIT_HISTORY = new Set(['diff', 'show', 'blame', 'annotate', 'difftool', 'range-diff', 'format-patch', 'whatchanged', 'cat-file']);
const PATCH_OPTION = /^(-p|-u|-U\d*|-L.*|--patch|--patch-with-stat|--patch-with-raw|--unified|--stat|--numstat|--shortstat|--dirstat|--name-only|--name-status|--raw|--summary|--compact-summary|--cc|--word-diff|--color-words|--full-diff)$/;

/** What in this command shows the diff or the history (a phrase), or null. */
function showsHistory(argv) {
  if (argv[0] === 'git') {
    const { sub, args } = splitGit(argv);
    if (GIT_HISTORY.has(sub)) return `git ${sub}`;
    const option = (sub === 'log' || sub === 'reflog') && args.find((a) => PATCH_OPTION.test(a.split('=')[0]));
    if (option) return `git ${sub} ${option}`;
    if (sub === 'stash' && args[0] === 'show') return 'git stash show';
    return null;
  }
  const call = ghCall(argv);
  if (call?.group === 'pr' && ['diff', 'view'].includes(call.action)) return `gh pr ${call.action}`;
  if (call?.api && /(^|\/)(pulls|commits|compare)(\/|$)/.test(call.api.endpoint)) return `gh api ${call.api.endpoint}`;
  if (call?.api?.endpoint === 'graphql' && /pullRequest|commit/i.test(call.api.text)) return 'gh api graphql';
  return null;
}

// ── git that changes the repository (for the planner) ───────────────────────

const GIT_WRITES = new Set(['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'switch', 'update-ref']);
const STASH_READS = new Set(['list', 'show']);
const WORKTREE_WRITES = new Set(['add', 'remove', 'move', 'prune', 'repair', 'lock', 'unlock']);

/** The git command that changes the working tree or the history (a phrase), or null. */
function changesRepository(argv) {
  if (argv[0] !== 'git') return null;
  const { sub, args } = splitGit(argv);
  if (GIT_WRITES.has(sub)) return `git ${sub}`;
  if (sub === 'stash' && !STASH_READS.has(args[0])) return 'git stash';
  if (sub === 'worktree' && WORKTREE_WRITES.has(args[0])) return `git worktree ${args[0]}`;
  return null;
}

// ── read-only git and gh (for the reviewer and the scout) ───────────────────

const READONLY_GIT = new Set(['status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'describe', 'shortlog', 'reflog', 'whatchanged']);
const BRANCH_WRITE = /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--force|-f|--edit-description|--set-upstream-to|--unset-upstream|-u)$/;
const TAG_WRITE = /^(-d|--delete|-a|-s|-m|-f|--force|--create-reflog|-F)$/;
const CONFIG_READ = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/;

/** Why a reviewer or scout may not run this git command, or null when it is read-only. */
function readOnlyGitProblem(argv) {
  const { sub, args } = splitGit(argv);
  if (READONLY_GIT.has(sub)) return null;
  const bare = args.filter((a) => !a.startsWith('-'));
  if (sub === 'remote') return bare.length === 0 || (bare.length === 1 && bare[0] === 'show') || args.every((a) => a.startsWith('-')) ? null : 'git remote only lists';
  if (sub === 'config') return args.some((a) => CONFIG_READ.test(a.split('=')[0])) && !args.some((a) => !a.startsWith('-') && a.includes('=')) ? null : 'git config may only read a value';
  if (sub === 'worktree') return args[0] === 'list' ? null : 'git worktree only lists';
  if (sub === 'stash') return STASH_READS.has(args[0]) ? null : 'git stash may only list or show';
  if (sub === 'branch' || sub === 'tag') {
    const writeFlag = args.some((a) => (sub === 'branch' ? BRANCH_WRITE : TAG_WRITE).test(a));
    const creates = bare.length > 0 && !args.some((a) => a === '-l' || a === '--list');
    return writeFlag || creates ? `git ${sub} only lists` : null;
  }
  return `git ${sub} is not a read-only command`;
}

const GH_READ = { pr: ['view', 'diff', 'list', 'checks', 'status'], issue: ['view', 'list', 'status'], release: ['view', 'list'], run: ['view', 'list'], api: null };
const GH_FIELD = /^(-f|-F|--field|--raw-field|--input|--input=.*|-f.+|-F.+|--field=.*|--raw-field=.*)$/;

/** Why a reviewer or scout may not run this gh command, or null when it is read-only. */
function readOnlyGhProblem(argv) {
  const call = ghCall(argv);
  if (!call) return 'gh could not be read';
  const { group, action, api } = call;
  if (!Object.hasOwn(GH_READ, group)) return `gh ${group ?? ''} is not a read-only command`;
  if (group === 'api') {
    if (api.verb !== 'GET' && api.verb !== 'HEAD') return `gh api with ${api.verb} can change data`;
    if (argv.slice(1).some((a) => GH_FIELD.test(a))) return 'gh api with -f, -F, --field, --raw-field or --input can change data';
    return null;
  }
  return GH_READ[group].includes(action) ? null : `gh ${group} ${action ?? ''} is not a read-only command`;
}

const NAV = new Set(['cd', 'pushd', 'popd', ':']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** True when a command only wraps others that collectCommands already enumerates (bash -c, eval). */
function isWrapper(argv) {
  const name = argv[0];
  if (name === 'eval') return true;
  return SHELLS.has(name) && argv.slice(1).some((a) => /^-[a-zA-Z]*c/.test(a));
}
const REVIEW_READERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'cat', 'ls', 'find', 'sed', 'head', 'tail', 'wc', 'sort', 'uniq', 'jq', 'diff', 'stat', 'file', 'tree', 'echo', 'printf', 'true', 'nl', 'less', 'more', 'awk', 'column']);
const FIND_WRITE = /^(-delete|-exec|-execdir|-ok|-okdir|-fprint.*)$/;

/** Why a reader program in a reviewer or scout command is not read-only, or null. */
function readerFlagProblem(name, argv) {
  const findWrite = name === 'find' && argv.slice(1).find((a) => FIND_WRITE.test(a));
  if (findWrite) return `find with ${findWrite} can change files`;
  if (name === 'sed' && argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return 'sed -i changes files';
  return null;
}

/** True when `argv` starts with the words of `prefix`. */
const startsWith = (argv, prefix) => prefix.length > 0 && prefix.length <= argv.length && prefix.every((w, k) => argv[k] === w);

/** True when `argv` matches a configured verify.commands entry (as written, or with its wrappers stripped). */
function matchesVerifyCommand(argv, commands) {
  return commands.some((entry) => {
    if (startsWith(argv, entry)) return true;
    const stripped = unwrapCommand(entry).argv;
    return stripped.length > 0 && startsWith(argv, stripped);
  });
}

// ── curl and wget to the local app (for the verifier) ───────────────────────

const CURL_VALUE_FLAGS = new Set(['-o', '--output', '--output-dir', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '-X', '--request', '-A', '--user-agent', '-b', '--cookie', '-c', '--cookie-jar', '-e', '--referer', '-u', '--user', '-F', '--form', '-T', '--upload-file', '-w', '--write-out', '-K', '--config', '-x', '--proxy', '--proxy-user', '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--resolve', '--interface', '-y', '-Y', '--limit-rate', '--cacert', '--cert', '--key', '-E', '--range', '-r', '--url']);

/** The URL words of a curl or wget command: its positionals and any --url value. */
function fetchUrls(argv) {
  const urls = [];
  for (let k = 1; k < argv.length; k += 1) {
    const a = argv[k];
    if (a === '--url') {
      if (argv[k + 1] !== undefined) urls.push(argv[(k += 1)]);
    } else if (a.startsWith('--url=')) urls.push(a.slice('--url='.length));
    else if (a.startsWith('-')) {
      if (CURL_VALUE_FLAGS.has(a)) k += 1;
    } else urls.push(a);
  }
  return urls;
}

/** The host of a URL authority (after the scheme), lower-cased; null when there is none. */
function hostOf(authority) {
  let a = authority;
  const at = a.indexOf('@');
  if (at !== -1) a = a.slice(at + 1);
  a = a.split(/[/?#]/)[0];
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end === -1 ? null : lower(a.slice(1, end));
  }
  const colon = a.indexOf(':');
  if (colon !== -1) a = a.slice(0, colon);
  return a === '' ? null : lower(a);
}

/** Why a curl or wget URL word is not http(s) to a local host, or null when it is. */
function badUrl(word, config) {
  const localHosts = (config.guard.localHosts ?? ['localhost', '127.0.0.1', '::1']).map(lower);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(word);
  if (scheme) {
    const name = lower(scheme[1]);
    if (name !== 'http' && name !== 'https') return `uses the ${name}: scheme, not http`;
  } else {
    const single = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(word);
    if (single && !word.startsWith('[')) {
      const name = lower(single[1]);
      if (name !== 'http' && name !== 'https') return `uses the ${name}: scheme, not http`;
    }
  }
  const host = hostOf(scheme ? word.slice(scheme[0].length) : word);
  if (host === null) return 'has no host';
  return localHosts.includes(host) ? null : `is not on a local host (${host})`;
}

/** The write targets of a curl or wget command besides its redirects, with stdout (`-`) left out. */
function fetchOutputs(name, argv) {
  const out = [];
  let hasOutputDoc = false;
  for (let k = 1; k < argv.length; k += 1) {
    const a = argv[k];
    if (name === 'curl') {
      if (a === '-o' || a === '--output' || a === '--output-dir') out.push(argv[(k += 1)]);
      else if (a.startsWith('--output=')) out.push(a.slice('--output='.length));
      else if (a.startsWith('--output-dir=')) out.push(a.slice('--output-dir='.length));
      else if (a === '-O' || a === '--remote-name' || a === '-J' || a === '--remote-header-name' || /^-[a-zA-Z]*O/.test(a)) out.push('.');
    } else if (a === '-O' || a === '--output-document') {
      hasOutputDoc = true;
      if (argv[k + 1] !== undefined) out.push(argv[(k += 1)]);
    } else if (a.startsWith('--output-document=')) {
      hasOutputDoc = true;
      out.push(a.slice('--output-document='.length));
    } else if (/^-[a-zA-Z]*O$/.test(a) && argv[k + 1] !== undefined) {
      hasOutputDoc = true;
      out.push(argv[(k += 1)]);
    } else if (a === '-P' || a === '--directory-prefix') out.push(argv[(k += 1)]);
  }
  if (name === 'wget' && !hasOutputDoc) out.push('.');
  return out.filter((t) => t !== undefined && t !== '-');
}

/** Why a verifier curl or wget command is not allowed, or null when it is. */
function fetchProblem(cmd, policy, config, place) {
  const name = cmd.argv[0];
  for (const word of fetchUrls(cmd.argv)) {
    const reason = badUrl(word, config);
    if (reason) return { rule: 'fence-tool', why: `${name} would reach ${word}, which ${reason}`, instead: 'Call the local base URL over http, for example curl -s http://localhost:3000/...' };
  }
  for (const word of fetchOutputs(name, cmd.argv)) {
    const problem = shellWriteProblem(word, cmd.dir, policy, place);
    if (problem) return { rule: 'fence-write', why: `${name} would write ${word}, and ${problem}`, instead: policy.writeInstead };
  }
  return null;
}

// ── the verifier's housekeeping commands ────────────────────────────────────

const VERIFY_READERS = new Set(['cat', 'head', 'tail', 'wc', 'jq', 'ls', 'test']);
const VERIFY_WRITERS = new Set(['mkdir']);
const VERIFY_QUIET = new Set(['echo', 'printf', 'sleep', 'date', 'true']);

/** Why a verifier housekeeping command touches a path outside what it may read or write, or null. */
function housekeepingProblem(cmd, policy, place) {
  const name = cmd.argv[0];
  if (VERIFY_QUIET.has(name)) return null;
  const isWriter = VERIFY_WRITERS.has(name);
  const valueOpts = name === 'head' || name === 'tail' ? ['-n', '-c'] : [];
  const words = name === 'jq' ? positionals(cmd.argv).slice(1) : positionals(cmd.argv, valueOpts);
  for (const word of words) {
    const target = shellPath(word, cmd.dir);
    if (target === null) continue;
    if (inScratchpad(target, place.scratchpadDir)) continue;
    if (isWriter) {
      const problem = writeProblem(target, policy.writes, place);
      if (problem) return { rule: 'fence-write', why: `${name} would write ${word}, and ${problem}`, instead: policy.writeInstead };
    } else {
      const problem = readProblem(target, policy, place);
      if (problem) return { rule: 'fence-read', why: problem, instead: READ_INSTEAD };
    }
  }
  return null;
}

// ── the program allow-lists ─────────────────────────────────────────────────

/** Why the verifier may not run this simple command, or null when it may. */
function verifierProgramProblem(cmd, policy, config, place) {
  const name = cmd.argv[0];
  if (name === undefined || NAV.has(name) || isWrapper(cmd.argv)) return null;
  if (matchesVerifyCommand(cmd.argv, policy.commands)) return null;
  if (name === 'curl' || name === 'wget') return fetchProblem(cmd, policy, config, place);
  if (VERIFY_QUIET.has(name) || VERIFY_READERS.has(name) || VERIFY_WRITERS.has(name)) return housekeepingProblem(cmd, policy, place);
  return { rule: 'fence-tool', why: `the verifier may run only curl or wget to the local app, a few housekeeping commands and the commands it is configured to run, and ${name} is none of them`, instead: PROGRAM_INSTEAD };
}

/** Why a reviewer or scout may not run this simple command, or null when it may. */
function reviewProgramProblem(cmd, policy) {
  const name = cmd.argv[0];
  if (name === undefined || NAV.has(name) || isWrapper(cmd.argv)) return null;
  const words = typeof policy.secondOpinion === 'string' && policy.secondOpinion.trim() ? policy.secondOpinion.trim().split(/\s+/) : [];
  if (words.length && startsWith(cmd.argv, words)) return null;
  let reason;
  if (name === 'git') reason = readOnlyGitProblem(cmd.argv);
  else if (name === 'gh') reason = readOnlyGhProblem(cmd.argv);
  else if (REVIEW_READERS.has(name)) reason = readerFlagProblem(name, cmd.argv);
  else reason = `${name} is not a read-only command`;
  return reason ? { rule: 'fence-tool', why: `the ${policy.role} agent may run only read-only commands, and ${reason}`, instead: 'Read the diff, the files and the history with read-only commands, and report what you find' } : null;
}

// ── the fences ──────────────────────────────────────────────────────────────

/** A file tool write against the role's allow-list. */
function fileWriteFence(policy, tool, file, place) {
  if (policy.writes.length === 0) return deny('fence-write', `the ${policy.role} agent writes nothing, and ${tool} would change ${file}`, policy.writeInstead);
  const problem = writeProblem(path.resolve(place.cwd, file), policy.writes, place);
  return problem ? deny('fence-write', `the ${policy.role} agent may write only ${policy.writes.join(', ')}, and ${problem}`, policy.writeInstead) : ALLOW;
}

/** Every simple command in a Bash call against the role's fence. */
function bashFence(policy, command, config, place) {
  const { commands } = collectCommands(command, place.cwd);
  const shellWrites = policy.writes.length ? `${policy.writes.join(', ')} (and /dev/null or its scratchpad)` : null;
  for (const cmd of commands) {
    if (policy.role === 'verifier') {
      const history = showsHistory(cmd.argv);
      if (history) return deny('fence-diff', `the verifier must not see the diff or the history, and ${history} shows it`, 'Judge the change only by driving the running app');
    }
    if (policy.programs) {
      const problem = policy.programs === 'verifier' ? verifierProgramProblem(cmd, policy, config, place) : reviewProgramProblem(cmd, policy);
      if (problem) return deny(problem.rule, problem.why, problem.instead);
    } else {
      const change = changesRepository(cmd.argv);
      if (change) return deny('fence-write', `${change} changes the repository, and the ${policy.role} agent never does`, 'Leave git state to the builders and the user; report what should change in your result');
    }
    if (policy.reads) {
      for (const word of cmd.inputs ?? []) {
        const target = shellPath(word, cmd.dir);
        const problem = target ? readProblem(target, policy, place) : `the guard cannot tell what ${word} reads`;
        if (problem) return deny('fence-read', problem, READ_INSTEAD);
      }
    }
    for (const word of writeTargets(cmd)) {
      const problem = shellWriteProblem(word, cmd.dir, policy, place);
      if (!problem) continue;
      const allowed = shellWrites ? `may write only ${shellWrites}` : 'writes only to /dev/null or its scratchpad';
      return deny('fence-write', `the ${policy.role} agent ${allowed}, and ${problem}`, policy.writes.length ? policy.writeInstead : 'Write notes to the scratchpad folder, or put them in your result');
    }
  }
  return ALLOW;
}

/** A Read, Grep or Glob call by the verifier against its read allow-list. */
function verifierReadFence(tool, input, policy, place) {
  if (tool === 'Read') {
    if (typeof input.file_path !== 'string' || input.file_path === '') return malformed('the Read call has no file path');
    const problem = readProblem(path.resolve(place.cwd, input.file_path), policy, place);
    return problem ? deny('fence-read', problem, READ_INSTEAD) : ALLOW;
  }
  const root = tool === 'Grep' ? path.resolve(place.cwd, typeof input.path === 'string' ? input.path : '.') : globRoot(input, place.cwd);
  const problem = searchProblem(root, policy, place);
  return problem ? deny('fence-read', problem, 'Search only the change specs folder, .verify/ or a configured read path') : ALLOW;
}

const READ_SHAPED = /(list|get|search|read|view|fetch|describe|query)/i;
const WRITE_VERB = /(write|edit|create|update|delete|remove|append|move|rename|set|add|insert|upload|patch|put|post|send|run|exec|execute|deploy|merge|cancel|approve|revoke|restore|pause|publish|modify|replace|drop|truncate|import|sync|trigger)/i;

/** An MCP tool call against the role's fence. */
function mcpFence(policy, tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  const server = m?.[1] ?? '';
  const name = m?.[2] ?? '';
  if (policy.role === 'verifier') {
    const allowed = (policy.mcpServers ?? []).some((s) => lower(server).includes(lower(s)));
    return allowed ? ALLOW : deny('fence-tool', `the verifier may use only its browser or testing MCP servers (${(policy.mcpServers ?? []).join(', ') || 'none configured'}), and ${server} is not one`, 'Drive the app through the configured browser or testing tool, or curl to the local base URL');
  }
  if (policy.role === 'reviewer' || policy.role === 'scout') {
    return READ_SHAPED.test(name) && !WRITE_VERB.test(name)
      ? ALLOW
      : deny('fence-tool', `the ${policy.role} agent may use only read-shaped MCP tools, and ${name} is not one`, 'Read with a list, get, search, read or view tool, and put what you find in your result');
  }
  return ALLOW;
}

/** The fence's decision on one tool call by a falsifiable role agent; every other caller is allowed. */
export function fence(request, config) {
  const role = roleOf(request?.agentType);
  if (!role) return ALLOW;
  const { tool } = request;
  const input = request.input;
  if (!isObject(input)) return malformed(`the ${tool} input is not an object`);
  const policy = POLICIES[role](config);
  const cwd = request.cwd || request.projectDir || process.cwd();
  const place = { cwd, projectDir: request.projectDir || request.cwd, scratchpadDir: request.scratchpadDir };
  if (tool in WRITE_TOOLS) {
    const file = WRITE_TOOLS[tool](input);
    if (typeof file !== 'string' || file === '') return malformed(`the ${tool} call has no file path`);
    return fileWriteFence(policy, tool, file, place);
  }
  if (tool === 'Bash') {
    if (typeof input.command !== 'string') return malformed('the Bash call has no command');
    return bashFence(policy, input.command, config, place);
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    return policy.role === 'verifier'
      ? deny('fence-tool', `the verifier may not use ${tool}; it reaches the web, and the verifier only drives the local app`, 'Reach the running app with curl to the local base URL or your browser tool')
      : ALLOW;
  }
  if (typeof tool === 'string' && tool.startsWith('mcp__')) return mcpFence(policy, tool);
  if (policy.role === 'verifier' && ['Read', 'Grep', 'Glob'].includes(tool)) return verifierReadFence(tool, input, policy, place);
  return ALLOW;
}
