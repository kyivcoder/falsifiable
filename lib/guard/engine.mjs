// The guard engine: pure and tool-agnostic. An adapter (scripts/hook.mjs for
// Claude Code) turns its payload into a request and prints the message on a block.
//
//   evaluate({kind: 'bash', command, cwd, branch, env}, config)
//   evaluate({kind: 'edit', path, content, env}, config)
//   evaluate({kind: 'mcp', tool, input, env}, config)
//     -> {allow: true} | {allow: false, rule, message}
//
// `env` is the session's environment, `branch` the branch checked out in
// `cwd`, and `config` the resolved project config (the defaults when omitted).
// Only the packs named in config.guard.packs run; guard.blockCommands always do.
//
// Tests: node --test test/guard/engine.test.mjs
import { resolveConfig } from '../config.mjs';
import { splitGit } from './args.mjs';
import { checkoutBranch, gitLocation } from './packs/git.mjs';
import { PACK_LIST } from './packs/index.mjs';
import { expandVars } from './packs/database.mjs';
import { binName, collectCommands } from './shell.mjs';

/** "falsifiable guard blocked: <rule>: <why>. <what to do instead>." */
export function blockMessage(rule, why, instead) {
  const end = (s) => String(s).replace(/[.\s]+$/, '');
  return `falsifiable guard blocked: ${rule}: ${end(why)}. ${end(instead)}.`;
}

const ALLOW = Object.freeze({ allow: true });
const deny = (rule, why, instead) => ({ allow: false, rule, message: blockMessage(rule, why, instead) });
const fromHit = (hit) => deny(hit.rule, hit.why, hit.instead);

/** The block for a request or payload the guard cannot read: it fails closed. */
export const malformed = (why) => deny('malformed-input', why, 'The guard fails closed; retry the tool call, and tell the user if this keeps happening');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True only when `--help` is the last word and no earlier word is an option, so git commit --no-verify -m --help is not help. */
function isHelpRequest({ argv }) {
  const n = argv.length;
  return n >= 2 && argv[n - 1] === '--help' && argv.slice(1, n - 1).every((a) => !a.startsWith('-'));
}

/** `value` with $VAR references resolved from the shell variables `vars`; the literal when a reference cannot be resolved. */
const resolveValue = (value, vars) => {
  const expanded = expandVars(value, vars);
  return expanded === null ? value : expanded;
};

/** The environment a command runs with: the session, overlaid by the exported shell variables it sees, then its own prefix assignments. */
function commandEnv(sessionEnv, cmd) {
  const vars = cmd.vars ?? {};
  const env = { ...sessionEnv };
  for (const name of cmd.exported ?? []) if (Object.hasOwn(vars, name)) env[name] = resolveValue(vars[name], vars);
  for (const [name, value] of Object.entries(cmd.assigns ?? {})) env[name] = resolveValue(value, vars);
  return env;
}

// Programs the packs guard by their arguments, tried in place of a program name
// the guard cannot resolve ($GIT push). The deploy tools are left out: they are
// blocked by name, so standing in for an unknown program they would block
// almost any words and are no help here.
const GUARDED_PROGRAMS = ['git', 'gh', 'psql', 'pgcli', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pg_basebackup', 'prisma', 'supabase', 'claude'];

/** The guard.blockCommands entry whose words start this command, if any. */
function blockedCommand({ argv }, entries) {
  if (argv.length === 0) return undefined;
  const words = [binName(argv[0]), ...argv.slice(1)];
  return entries.find((entry) => entry.argv.length <= words.length && entry.argv.every((word, k) => (k === 0 ? binName(word) : word) === words[k]));
}

/** The first rule of `rules` that hits, as a block. */
function firstHit(rules, ...args) {
  for (const rule of rules ?? []) {
    const hit = rule(...args);
    if (hit) return fromHit(hit);
  }
  return null;
}

/** The branch for a git command's location: a prior checkout in that folder, else the lookup. */
function branchResolver(request, cwd0) {
  if (typeof request.branchOf === 'function') return (loc) => request.branchOf({ dir: loc.dir, gitDir: loc.gitDir });
  return (loc) => (loc.gitDir === undefined && loc.dir === cwd0 ? request.branch : null);
}

/** Each simple command in the line against the packs, then guard.blockCommands. */
function evaluateBash(request, ctx, packs) {
  const { command, cwd } = request;
  if (typeof command !== 'string') return malformed('the Bash command is missing');
  const cwd0 = cwd ?? '';
  const session = { vars: { ...ctx.env }, exported: new Set(Object.keys(ctx.env)) };
  const { commands, allAssigns } = collectCommands(command, cwd0, 0, session);
  ctx.allAssigns = allAssigns;
  const lookup = branchResolver(request, cwd0);
  const recorded = new Map();
  for (const pack of packs) {
    const hit = firstHit(pack.line, ctx);
    if (hit) return hit;
  }
  for (const cmd of commands) {
    cmd.env = commandEnv(ctx.env, cmd);
    if (cmd.argv[0] === 'git') {
      const loc = gitLocation(cmd.argv, cmd.dir, cmd.env);
      const key = loc.gitDir !== undefined ? `g:${loc.gitDir}` : `d:${loc.dir}`;
      if (splitGit(cmd.argv).sub === 'push') ctx.branch = recorded.has(key) ? recorded.get(key) : lookup(loc);
      const co = checkoutBranch(cmd.argv);
      if (co !== undefined) recorded.set(key, co);
    }
    const help = isHelpRequest(cmd);
    const run = (candidate) => {
      for (const pack of packs) {
        if (help && !pack.runsOnHelp) continue;
        const hit = firstHit(pack.command, candidate, ctx);
        if (hit) return hit;
      }
      const entry = help ? undefined : blockedCommand(candidate, ctx.guard.blockCommands);
      return entry ? deny(entry.id, entry.why, entry.instead) : null;
    };
    // A program name the guard cannot resolve ($GIT push): judge the words as each guarded program would.
    if (/[$`]/.test(cmd.argv[0] ?? '')) {
      const rest = cmd.argv.slice(1);
      const programs = [...GUARDED_PROGRAMS, ...ctx.guard.blockCommands.map((c) => c.argv[0])];
      for (const program of programs) {
        const hit = run({ ...cmd, argv: [program, ...rest] });
        if (hit) return hit;
      }
      continue;
    }
    const hit = run(cmd);
    if (hit) return hit;
  }
  return ALLOW;
}

/** A file tool write against the packs. */
function evaluateEdit({ path, content }, ctx, packs) {
  if (typeof path !== 'string' || path === '') return malformed('the file path is missing');
  for (const pack of packs) {
    const hit = firstHit(pack.edit, { path, content }, ctx);
    if (hit) return hit;
  }
  return ALLOW;
}

/** An MCP call, split into server and tool name, against the packs. */
function evaluateMcp({ tool, input }, ctx, packs) {
  if (typeof tool !== 'string' || tool === '') return malformed('the MCP tool name is missing');
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!m) return ALLOW;
  const call = { tool, server: m[1], name: m[2], input: isObject(input) ? input : {} };
  for (const pack of packs) {
    const hit = firstHit(pack.mcp, call, ctx);
    if (hit) return hit;
  }
  return ALLOW;
}

let defaults;
const defaultConfig = () => (defaults ??= resolveConfig(undefined).config);

const EVALUATORS = { bash: evaluateBash, edit: evaluateEdit, mcp: evaluateMcp };

/** The guard's decision on one request under `config`. */
export function evaluate(request, config = defaultConfig()) {
  if (!isObject(request)) return malformed('there is no request');
  const evaluator = EVALUATORS[request.kind];
  if (!evaluator) return malformed(`the request kind ${JSON.stringify(request.kind)} is unknown`);
  const { guard } = config;
  const ctx = { env: isObject(request.env) ? request.env : {}, guard, branch: request.branch ?? undefined, allAssigns: {} };
  const packs = PACK_LIST.filter((pack) => guard.packs.includes(pack.name));
  return evaluator(request, ctx, packs);
}
