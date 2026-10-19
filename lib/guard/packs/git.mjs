// The git pack: git hooks stay on, and protected branches (guard.protectedBranches)
// change only through a pull request a person merges.
//
// A push's branch is the one checked out where the command runs: the engine
// resolves it per command from -C, --git-dir/GIT_DIR and the folder reached by
// cd, so `git -C ../wt push` or `cd ../wt && git push` use ../wt's branch, and
// a folder whose branch the guard cannot read makes a bare or HEAD push count
// as protected. `git checkout main && git push` is followed through.
//
// core.hooksPath may point only at the root of a protected hooks folder such
// as .githooks, .husky or .husky/_, whose hooks agents cannot change.
//
// Tests: node --test test/guard/engine.test.mjs
import path from 'node:path';

import { BUILT_IN_PROTECTED } from '../../config.mjs';
import { matches, overlaps } from '../../glob.mjs';
import { block, splitGit } from '../args.mjs';
import { ghCall } from './github.mjs';

/** True when `branch` is one of guard.protectedBranches, each a name or a glob such as release/*. */
export const isProtectedBranch = (branch, guard) =>
  typeof branch === 'string' && branch !== '' && guard.protectedBranches.some((glob) => matches(glob, branch));

const NO_VERIFY = '--no-verify';
/** git accepts any unambiguous prefix of a long option: --no-ver is --no-verify. */
const isNoVerify = (a) => {
  const name = a.split('=')[0];
  return name.length >= 6 && NO_VERIFY.startsWith(name);
};
const noVerify = (what) => block('git-no-verify', `${what} skips the repository's git hooks`, 'Run the commit or push normally and fix whatever the hook reports');

/** The hook bypass variable in `env`, or null: pre-commit's SKIP, husky, lefthook, overcommit and SKIP_*HOOK* style names. */
function bypassVariable(env) {
  for (const [name, value] of Object.entries(env)) {
    if (name === 'SKIP' || name === 'HUSKY_SKIP_HOOKS' || name === 'OVERCOMMIT_DISABLE') return name;
    if (/^SKIP_\w*(HOOK|COMMIT|PUSH|VERIFY|GIT)/.test(name)) return name;
    if ((name === 'HUSKY' || name === 'LEFTHOOK') && /^['"]?0['"]?$/.test(String(value))) return `${name}=0`;
  }
  return null;
}

/** True when git commit is given --no-verify or -n, alone or bundled (-nm). */
function commitSkipsHooks(args) {
  const valueLong = ['--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '--cleanup', '--trailer', '--pathspec-from-file'];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (isNoVerify(a)) return true;
      if (valueLong.includes(a)) k += 1;
      continue;
    }
    if (!a.startsWith('-') || a.length < 2) continue;
    for (let c = 1; c < a.length; c += 1) {
      const ch = a[c];
      if (ch === 'n') return true;
      if ('mFCct'.includes(ch)) {
        if (c === a.length - 1) k += 1;
        break;
      }
      if ('Su'.includes(ch)) break;
    }
  }
  return false;
}

// ── core.hooksPath may point only at the root of a protected hooks folder ────

const stripGlobRoot = (glob) => String(glob).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/(\*\*?)?$/, '').toLowerCase();
const basenameOf = (p) => p.split('/').filter(Boolean).pop() ?? '';
const normalizeHooksValue = (value) => String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
const HOOKS_FOLDER_NAME = /hook|husky/i;
/** The real git hooks directories: always fine, never the guard's own. */
const ALWAYS_HOOKS = new Set(['.git/hooks', '.husky/_']);
/** The guard's own protected directories, which are not git hooks folders. */
const GUARD_OWN = new Set(BUILT_IN_PROTECTED.map(stripGlobRoot).filter((root) => root !== '.git/hooks'));

/** True when core.hooksPath may point at `value`: the root of a protected hooks folder, never a subfolder or the guard's own. */
function hooksFolderAllowed(value, ctx) {
  const v = normalizeHooksValue(value);
  if (v === '') return false;
  if (ALWAYS_HOOKS.has(v)) return true;
  if (GUARD_OWN.has(v)) return false;
  if (!ctx.guard.protectedPaths.some((glob) => stripGlobRoot(glob) === v)) return false;
  return HOOKS_FOLDER_NAME.test(basenameOf(v));
}

/** True when a git config setting (`key=value`) points core.hooksPath somewhere agents could write. */
const badHooksSetting = (setting, ctx) => /^core\.hookspath=/i.test(setting) && !hooksFolderAllowed(setting.slice(setting.indexOf('=') + 1), ctx);

/** True when `git config <args>` unsets core.hooksPath or points it at a folder agents can write. */
function hooksPathChange(args, ctx) {
  const keyIndex = args.findIndex((a) => a.toLowerCase() === 'core.hookspath');
  if (keyIndex === -1) return false;
  if (args.some((a) => a === 'unset' || a.startsWith('--unset'))) return true;
  if (args.includes('--get') || args.includes('get')) return false;
  const value = args[keyIndex + 1];
  return value !== undefined && !hooksFolderAllowed(value, ctx);
}

/** True when GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT/KEY_n/VALUE_n point core.hooksPath somewhere agents can write. */
function envHooksPath(env, ctx) {
  const params = env.GIT_CONFIG_PARAMETERS;
  if (typeof params === 'string') {
    for (const m of params.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) {
      if (badHooksSetting((m[1] ?? m[2] ?? m[3] ?? '').replace(/^["']|["']$/g, ''), ctx)) return true;
    }
  }
  for (const [name, value] of Object.entries(env)) {
    const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
    if (m && String(value).toLowerCase() === 'core.hookspath' && !hooksFolderAllowed(env[`GIT_CONFIG_VALUE_${m[1]}`] ?? '', ctx)) return true;
  }
  return false;
}

// ── where a git command runs, and the branch it switches to ─────────────────

const GLOBAL_VALUE_OPTS = new Set(['-c', '--config-env', '--namespace', '--super-prefix', '--work-tree']);

/** A path word resolved against `base` (posix); null when it holds a variable or `base` is already unknown. */
function joinDir(base, p) {
  if (p === undefined || p === '') return base;
  if (typeof p !== 'string' || /[$`]/.test(p) || p.startsWith('~')) return null;
  if (p.startsWith('/')) return path.posix.normalize(p);
  return base === null ? null : path.posix.normalize(base === '' ? p : path.posix.join(base, p));
}

/** Where a git command acts: its working folder (after -C and cd) and the git directory it names, if any. */
export function gitLocation(argv, dir, env = {}) {
  let cur = dir === undefined ? '' : dir;
  let gitDir = typeof env.GIT_DIR === 'string' ? env.GIT_DIR : undefined;
  let k = 1;
  while (k < argv.length && argv[k].startsWith('-') && argv[k] !== '--') {
    const a = argv[k];
    if (a === '-C') {
      cur = joinDir(cur, argv[k + 1]);
      k += 2;
    } else if (a.length > 2 && a.startsWith('-C')) {
      cur = joinDir(cur, a.slice(2));
      k += 1;
    } else if (a === '--git-dir') {
      gitDir = argv[k + 1];
      k += 2;
    } else if (a.startsWith('--git-dir=')) {
      gitDir = a.slice('--git-dir='.length);
      k += 1;
    } else if (GLOBAL_VALUE_OPTS.has(a)) {
      k += 2;
    } else k += 1;
  }
  return { dir: cur, gitDir: gitDir === undefined ? undefined : joinDir(cur, gitDir) };
}

/** The branch a checkout or switch moves to: a name, null for the previous branch or an unnamed target, or undefined when it is not a branch switch. */
export function checkoutBranch(argv) {
  if (argv[0] !== 'git') return undefined;
  const { sub, args } = splitGit(argv);
  if ((sub !== 'checkout' && sub !== 'switch') || args.includes('--')) return undefined;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '-') return null;
    if (['-b', '-B', '-c', '-C', '--orphan'].includes(a)) return args[k + 1] ?? null;
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

// ── pushes that reach a protected branch ────────────────────────────────────

/** What a push reaches that is protected (a phrase, or null), and whether it forces. */
function pushTargets(args, ctx, configs) {
  let force = false;
  let all = false;
  let matching = false;
  let dryRun = false;
  const positional = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (name === '--force' || name === '--force-with-lease') force = true;
      if (name === '--mirror') force = all = true;
      if (name === '--all' || name === '--branches') all = true;
      if (name === '--dry-run') dryRun = true;
      if (!a.includes('=') && ['--repo', '--receive-pack', '--exec', '--push-option'].includes(a)) k += 1;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let c = 1; c < a.length; c += 1) {
        if (a[c] === 'f') force = true;
        if (a[c] === 'n') dryRun = true;
        if (a[c] === 'o') {
          if (c === a.length - 1) k += 1;
          break;
        }
      }
      continue;
    }
    positional.push(a);
  }
  const refspecs = positional.slice(1);
  for (const c of configs) {
    const m = /^remote\.[^=]*\.push=(.+)$/i.exec(c);
    if (m) refspecs.push(m[1]);
    if (/^push\.default\s*=\s*matching$/i.test(c)) matching = true;
  }
  const isProtected = (name) => isProtectedBranch(name, ctx.guard);
  const unknown = 'an unknown branch (the guard cannot read it, so it refuses)';
  const bare = () => (ctx.branch === null ? unknown : ctx.branch !== undefined && isProtected(ctx.branch) ? `the protected branch ${ctx.branch}` : null);
  let target = all || matching ? 'every branch, protected ones included' : null;
  if (refspecs.length === 0 && !all && !matching) target = bare();
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) force = true;
    const spec = refspec.replace(/^\+/, '');
    if (spec === '' || spec === ':') {
      target = target ?? 'every matching branch, protected ones included';
      continue;
    }
    const dst = (spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec).replace(/^refs\/heads\//, '');
    if (dst === 'HEAD' || dst === '@') target = bare() ?? target;
    else if (/[*?[]/.test(dst)) {
      if (ctx.guard.protectedBranches.some((pb) => overlaps(dst, pb))) target = `a protected branch (the refspec ${refspec} can match one)`;
    } else if (isProtected(dst)) target = `the protected branch ${dst}`;
  }
  return { target: dryRun ? null : target, force };
}

const PUSH_INSTEAD = 'Push a feature branch (git push -u origin <branch>) and open a pull request';

/**
 * A hook bypass the command line sets in a git command's environment. The
 * session's own environment is the user's choice, which the agent cannot
 * change, so a bypass that only it carries passes.
 */
function bypassCommand(cmd, ctx) {
  if (cmd.argv[0] !== 'git') return null;
  const env = cmd.env ?? {};
  const session = ctx.env ?? {};
  const set = Object.fromEntries(Object.entries(env).filter(([name, value]) => session[name] !== value));
  const name = bypassVariable(set);
  if (name) return noVerify(`setting ${name}`);
  if (Object.keys(set).some((key) => key.startsWith('GIT_CONFIG_')) && envHooksPath(env, ctx)) {
    return noVerify('setting core.hooksPath through the environment');
  }
  return null;
}

/** Hook bypasses and pushes that reach a protected branch. */
function gitCommand(cmd, ctx) {
  const { argv } = cmd;
  if (argv[0] !== 'git') return null;
  const { configs, sub, args } = splitGit(argv);
  const badHooksPath = configs.find((c) => badHooksSetting(c, ctx));
  if (badHooksPath) return noVerify(`git -c ${badHooksPath}`);
  if (sub === 'config' && hooksPathChange(args, ctx)) return noVerify('changing core.hooksPath');
  if (sub === 'commit' && commitSkipsHooks(args)) return noVerify('git commit --no-verify (or -n)');
  if (args.some(isNoVerify)) return noVerify(`git ${sub} --no-verify`);
  if (sub !== 'push') return null;
  const { target, force } = pushTargets(args, ctx, configs);
  if (target && force) return block('git-force-push-protected', `this force-push reaches ${target} and would rewrite its history`, PUSH_INSTEAD);
  if (target) return block('git-push-protected', `this push reaches ${target}; agents never push to a protected branch`, PUSH_INSTEAD);
  return null;
}

/** gh api calls that move a protected branch's ref directly. */
function ghRefMove({ argv }, ctx) {
  const api = ghCall(argv)?.api;
  if (!api || api.verb === 'GET' || api.verb === 'HEAD') return null;
  const ref = /(?:^|\/)git\/refs\/heads\/(.+?)\/?$/.exec(api.endpoint)?.[1];
  if (!isProtectedBranch(ref, ctx.guard)) return null;
  return block('git-push-protected', `gh api ${api.verb} ${api.endpoint} moves the protected branch ${ref}`, PUSH_INSTEAD);
}

const GITHUB_FILE_WRITES = new Set(['push_files', 'create_or_update_file', 'delete_file']);

/** GitHub MCP tools that commit files straight to a protected branch, or to the default branch. */
function githubCommit({ server, name, input }, ctx) {
  if (!/github/i.test(server) || !GITHUB_FILE_WRITES.has(name)) return null;
  const branch = String(input.branch ?? '').replace(/^refs\/heads\//, '');
  if (branch !== '' && !isProtectedBranch(branch, ctx.guard)) return null;
  return block('git-push-protected', `${name} would commit to ${branch || 'the default branch'} directly`, 'Commit to a feature branch and open a pull request');
}

export const pack = Object.freeze({
  name: 'git',
  emits: Object.freeze(['git-no-verify', 'git-push-protected', 'git-force-push-protected']),
  command: Object.freeze([bypassCommand, gitCommand, ghRefMove]),
  mcp: Object.freeze([githubCommit]),
});
