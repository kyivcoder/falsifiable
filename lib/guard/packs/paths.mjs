// The paths pack: agents never change a protected path (guard.protectedPaths
// plus the built-in policy files), with a file tool, an MCP file tool or the
// shell, and never change Claude Code's plugins, MCP servers or settings with
// the claude CLI. Only a session a person started with the unlock variable
// (guard.unlockEnv=1) may.
//
// A protected glob is matched against a target relative to the root of the git
// worktree that holds it (at any depth inside it), so a checkout under a folder
// named like a protected path is judged by its own layout; a target outside
// every worktree is matched by its absolute path. A write is judged as written,
// where a symlink really lands, and through a symlink made earlier in the same
// command line. Paths compare case-insensitively, because macOS and Windows
// file systems do.
//
// Tests: node --test test/guard/engine.test.mjs and test/guard/paths.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { matches, matchesAtAnyDepth, segmentsOf } from '../../glob.mjs';
import { block, flagValue, positionals, splitGit } from '../args.mjs';
import { realTarget, worktreeRoot } from '../worktree.mjs';
import { expandVars } from './database.mjs';

const WILDCARD = /[*?]/;
const toPosix = (p) => p.split(path.sep).join('/');
const lower = (p) => toPosix(String(p)).toLowerCase();

/** `p` relative to the worktree that holds it (original case), or its absolute path when outside every worktree, or itself when relative. */
function worktreeRelative(p) {
  if (!path.isAbsolute(p)) return toPosix(p);
  const root = worktreeRoot(p);
  return root ? toPosix(path.relative(root, p)) : toPosix(p);
}

/** The lower-case path a protected glob is matched against: worktree-relative, normalised, brackets read as ?. */
const matchable = (p) => path.posix.normalize(lower(worktreeRelative(p))).replace(/\[[^\]]*\]/g, '?').replace(/\/+$/, '');

/** Where an absolute path really lands as a matchable string, when a symlink leads elsewhere; null otherwise. */
function realMatchable(p) {
  if (!path.isAbsolute(p)) return null;
  try {
    const real = realTarget(p);
    return real === p ? null : matchable(real);
  } catch {
    return null;
  }
}

// ── matching a target against the protected globs ───────────────────────────

/** One folder name from a shell word against one from a protected glob; a shell * never matches a leading dot. */
function segmentsMeet(word, glob) {
  const wordWild = WILDCARD.test(word);
  const globWild = WILDCARD.test(glob);
  if (wordWild && glob.startsWith('.') && !word.startsWith('.')) return false;
  if (!wordWild && !globWild) return word === glob;
  if (!wordWild) return matches(glob, word);
  if (!globWild) return matches(word, glob);
  return true;
}

/** True when some path matches both the shell glob `t` and the protected glob `g` (segment lists). */
function shellOverlap(t, g) {
  if (t.length === 0 && g.length === 0) return true;
  if (g[0] === '**') return shellOverlap(t, g.slice(1)) || (t.length > 0 && shellOverlap(t.slice(1), g));
  if (t[0] === '**') return shellOverlap(t.slice(1), g) || (g.length > 0 && shellOverlap(t, g.slice(1)));
  return t.length > 0 && g.length > 0 && segmentsMeet(t[0], g[0]) && shellOverlap(t.slice(1), g.slice(1));
}

/** True when the segments `t` match a leading part of the glob segments `g` that still has more to match. */
function leadsInto(t, g) {
  if (t.length === 0) return g.length > 0;
  if (g.length === 0) return false;
  if (g[0] === '**') return true;
  return segmentsMeet(t[0], g[0]) && leadsInto(t.slice(1), g.slice(1));
}

/**
 * True when the folder `t` holds a path that `g` matches, by g's own leading
 * folders: .claude holds .claude/settings.json. A glob that starts with **
 * names no folder, or every folder would hold .mcp.json.
 */
const holds = (t, g) => t.length > 0 && g.length > 0 && g[0] !== '**' && leadsInto(t, g);

/** True when the matchable `target` is a protected path, a folder that holds one, or a shell glob that can reach one. */
function reachesGlobs(target, globs) {
  const t = segmentsOf(target);
  const wild = t.some((s) => WILDCARD.test(s));
  return globs.some((glob) => {
    const g = segmentsOf(lower(glob));
    if (!wild && matchesAtAnyDepth(lower(glob), target)) return true;
    for (let start = 0; start < t.length; start += 1) {
      const tail = t.slice(start);
      if ((wild && shellOverlap(tail, g)) || holds(tail, g)) return true;
    }
    return false;
  });
}

/** True when `file` (a file-tool path or an MCP path) is a protected path, judged as written and where a symlink lands. */
export function isProtectedPath(file, globs) {
  const candidates = [matchable(file), realMatchable(file)].filter((c) => c !== null);
  return candidates.some((target) => reachesGlobs(target, globs));
}

// ── resolving a shell write target ──────────────────────────────────────────

/** A shell word resolved to a path: $VARs expanded from `vars` (its literal part when a reference is unresolved), joined to `dir`. */
function resolveWord(word, dir, vars) {
  if (!word || word.startsWith('-')) return null;
  const expanded = expandVars(word, vars ?? {});
  const text = expanded === null ? word.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, '') : expanded;
  if (text === '' || text.includes('$') || text.includes('`')) return null;
  if (text.startsWith('~')) return text === '~' || text.startsWith('~/') ? text : null;
  return path.isAbsolute(text) ? path.posix.normalize(text) : path.posix.normalize(path.posix.join(dir ?? '', text));
}

/** The matchable candidates a resolved target reaches: as written, where a symlink lands, and through a link made earlier in the line. */
function candidatesFor(resolved, links) {
  const out = [matchable(resolved)];
  const real = realMatchable(resolved);
  if (real !== null) out.push(real);
  const rel = matchable(resolved);
  for (const [link, dest] of links) {
    if (rel === link) out.push(dest);
    else if (rel.startsWith(`${link}/`)) out.push(`${dest}${rel.slice(link.length)}`);
  }
  return out;
}

// ── what a command writes ───────────────────────────────────────────────────

/** A git pathspec as a matchable glob: `.`, `:/` and `:(top)` reach the whole tree; an exclude pathspec is dropped. */
function normalizePathspec(p) {
  if (p === '.' || p === ':/' || p === ':(top)' || p === ':(top,glob)') return '**';
  if (/^:(!|\(exclude)/.test(p)) return null;
  const top = /^:\(top\)(.+)$/.exec(p);
  if (top) return top[1];
  if (p.startsWith(':/')) return p.slice(2) || '**';
  if (p.startsWith(':(')) return p.slice(p.indexOf(')') + 1) || '**';
  return p;
}

/** The target paths of a readable `git apply`/`git am` patch, or [] when there is no readable patch. */
function patchTargets(argv, dir) {
  const { args } = splitGit(argv);
  const files = positionals([argv[0], ...args], ['-p', '--exclude', '--include', '--directory', '--whitespace', '-C']);
  const out = [];
  for (const file of files) {
    const abs = resolveWord(file, dir, {});
    if (abs === null) continue;
    try {
      const text = readFileSync(abs, 'utf8');
      for (const m of text.matchAll(/^\+\+\+ b\/(.+)$/gm)) out.push(m[1].trim());
      for (const m of text.matchAll(/^rename to (.+)$/gm)) out.push(m[1].trim());
    } catch {
      /* an unreadable patch leaves no target for the paths pack; the fence blocks it for a role agent */
    }
  }
  return out;
}

/** Paths a git command overwrites or deletes in the working tree. */
function gitPathTargets(argv, dir) {
  const { sub, args } = splitGit(argv);
  const dashDash = args.indexOf('--');
  if (sub === 'restore') {
    const pos = dashDash !== -1 ? args.slice(dashDash + 1) : positionals([sub, ...args], ['-s', '--source']);
    return pos.map(normalizePathspec).filter(Boolean);
  }
  if (sub === 'checkout') {
    if (dashDash !== -1) return args.slice(dashDash + 1).map(normalizePathspec).filter(Boolean);
    // without --, a lone positional is a branch to switch to; a pathspec, or paths after a tree-ish, are targets
    const pos = positionals([sub, ...args]);
    const paths = pos.length <= 1 ? pos.filter((p) => p === '.' || p.startsWith(':')) : pos.slice(1);
    return paths.map(normalizePathspec).filter(Boolean);
  }
  if (sub === 'rm' || sub === 'mv') return args.filter((a) => !a.startsWith('-')).map(normalizePathspec).filter(Boolean);
  if (sub === 'apply' || sub === 'am') return patchTargets(argv, dir);
  return [];
}

const WRITES_ALL_ARGS = new Set(['rm', 'rmdir', 'unlink', 'truncate', 'shred', 'chmod', 'chown', 'chgrp', 'mv', 'tee']);
const WRITES_LAST_ARG = new Set(['cp', 'install', 'rsync', 'scp']);
const isTarExtract = (argv) => argv.slice(1).some((a) => !a.startsWith('--') && /^-?[a-zA-Z]*x/.test(a)) || argv.includes('--extract') || argv.includes('--get');

/** Every path a simple command writes, as written: redirects, writing-command arguments, both ends of a link, cp -t/tar -C targets, sed -i, git paths and patch targets. */
export function writeTargets(cmd) {
  const { argv, redirects = [], dir } = cmd;
  const targets = [...redirects];
  const [name] = argv;
  const nonOpt = argv.slice(1).filter((a) => !a.startsWith('-'));
  const targetDir = flagValue(argv, '-t') ?? flagValue(argv, '--target-directory');
  if (WRITES_ALL_ARGS.has(name)) targets.push(...nonOpt);
  else if (name === 'ln') targets.push(...nonOpt);
  else if (WRITES_LAST_ARG.has(name)) {
    if (targetDir !== undefined) targets.push(targetDir);
    else if (nonOpt.length) targets.push(nonOpt[nonOpt.length - 1]);
  } else if (name === 'tar' && isTarExtract(argv)) {
    const into = flagValue(argv, '-C') ?? flagValue(argv, '--directory');
    if (into !== undefined) targets.push(into);
  } else if (name === 'sed' && argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) targets.push(...nonOpt);
  else if ((name === 'perl' || name === 'ruby') && argv.some((a) => /^-[a-zA-Z]*i/.test(a))) targets.push(...nonOpt);
  else if (name === 'dd') targets.push(...argv.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  else if (name === 'git') targets.push(...gitPathTargets(argv, dir));
  return targets;
}

const unlocked = (ctx) => ctx.env[ctx.guard.unlockEnv] === '1';
const instead = (ctx) => `Leave it as it is; if the change is needed, ask the user to start a new session with ${ctx.guard.unlockEnv}=1`;

/** Record the link `ln` makes (link path -> where it points), so a later write through it is judged against its real target. */
function recordLink(cmd, ctx) {
  const ends = cmd.argv.slice(1).filter((a) => !a.startsWith('-'));
  if (ends.length < 2) return;
  const dest = resolveWord(ends[ends.length - 2], cmd.dir, cmd.vars);
  const link = resolveWord(ends[ends.length - 1], cmd.dir, cmd.vars);
  if (dest !== null && link !== null) (ctx.links ??= new Map()).set(matchable(link), matchable(dest));
}

/** A shell command that writes a protected path, directly or through a symlink. */
function shellWrite(cmd, ctx) {
  if (unlocked(ctx)) return null;
  const links = (ctx.links ??= new Map());
  if (cmd.argv[0] === 'ln') recordLink(cmd, ctx);
  for (const word of writeTargets(cmd)) {
    const resolved = resolveWord(word, cmd.dir, cmd.vars);
    if (resolved === null) continue;
    if (candidatesFor(resolved, links).some((t) => reachesGlobs(t, ctx.guard.protectedPaths))) {
      return block('protected-path', `this command changes ${word}, a protected path that agents may not change`, instead(ctx));
    }
  }
  return null;
}

/** A file tool write to a protected path. */
function fileWrite(edit, ctx) {
  if (unlocked(ctx) || !isProtectedPath(edit.path, ctx.guard.protectedPaths)) return null;
  return block('protected-path', `${edit.path} is a protected path that agents may not change`, instead(ctx));
}

const PATH_FIELDS = ['path', 'file_path', 'filePath', 'paths', 'source', 'destination', 'target', 'filename', 'uri'];
const MCP_WRITE_VERB = /(write|edit|create|update|delete|remove|append|move|rename|copy|mkdir|upload|patch|put|save|overwrite)/i;
const fileUri = (v) => (typeof v === 'string' && v.startsWith('file://') ? decodeURIComponent(v.slice('file://'.length).replace(/^\/\/[^/]*/, '')) : null);

/** An MCP file tool whose name writes and whose input names a protected path. */
function mcpFileWrite({ name, input }, ctx) {
  if (unlocked(ctx) || !MCP_WRITE_VERB.test(name)) return null;
  for (const field of PATH_FIELDS) {
    const value = input[field];
    const paths = field === 'uri' ? [fileUri(value)] : Array.isArray(value) ? value : [value];
    for (const p of paths) {
      if (typeof p === 'string' && p !== '' && isProtectedPath(p, ctx.guard.protectedPaths)) {
        return block('protected-path', `the MCP tool ${name} would change ${p}, a protected path that agents may not change`, instead(ctx));
      }
    }
  }
  return null;
}

const CLAUDE_HARNESS = { plugin: ['disable', 'uninstall', 'remove'], marketplace: ['remove'], mcp: ['add', 'remove', 'add-json'], config: ['set', 'add', 'remove'] };

/** The claude CLI changing plugins, MCP servers or settings. */
function claudeHarness(cmd, ctx) {
  if (cmd.argv[0] !== 'claude' || unlocked(ctx)) return null;
  const [group, action] = positionals(cmd.argv);
  if (!CLAUDE_HARNESS[group]?.includes(action)) return null;
  return block('harness-change', `claude ${group} ${action} changes Claude Code's plugins, MCP servers or settings`, instead(ctx));
}

export const pack = Object.freeze({
  name: 'paths',
  emits: Object.freeze(['protected-path', 'harness-change']),
  // `<cli> --help` only prints help, but where its output goes still counts.
  runsOnHelp: true,
  command: Object.freeze([claudeHarness, shellWrite]),
  edit: Object.freeze([fileWrite]),
  mcp: Object.freeze([mcpFileWrite]),
});
