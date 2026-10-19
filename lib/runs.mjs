// What a project's CI workflows and git hooks run, for the rule check's
// [check:<name>] tags (scripts/check-rules.mjs, RUN BY).
//
//   ranChecks(root, {scripts, make}) -> Set of the script and target names run
//   workflowRuns(yaml)               -> the run: commands that run in the project folder
//   scriptCalls(command)             -> [{kind: 'script' | 'target', name}] a command line runs
//   makeRules(text)                  -> {rules: Map(target -> {prerequisites, recipe}), goal}
//
// It reads the run: steps of .github/workflows/*.yml and the git hooks that
// can stop a commit or a push in .husky/ and .githooks/, then follows npm,
// pnpm, yarn, bun run, node --run and make through the scripts and targets
// they reach. Reading is best effort: what it cannot read does not count, and
// conditions are not followed, so a command behind if, && or || counts as run.
//
// Tests: node --test test/check-rules.test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseShell } from './guard/shell.mjs';

export const WORKFLOWS_DIR = '.github/workflows';
export const HOOK_DIRS = ['.husky', '.githooks'];

const MAKE_RULE = /^([^\s:#=%][^:#=%]*?)\s*::?(?![:=])/;
const MAKE_TARGET = /^[^.$%][^$%]*$/;
const WORKFLOW_FILE = /\.ya?ml$/;
/** The git hooks that can stop a commit, a merge, a rebase or a push. */
const BLOCKING_HOOKS = new Set(['applypatch-msg', 'pre-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'pre-rebase', 'pre-push']);
/** working-directory values that are the project folder itself, spaces removed. */
const ROOT_DIRS = new Set(['.', './', '${{github.workspace}}']);
const YAML_KEY = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/;
const YAML_BLOCK = /^[|>][-+0-9]*(?:\s+#.*)?$/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'exec']);
/** Options that run a package manager's script in another package or folder. */
const ELSEWHERE = {
  npm: new Set(['--prefix', '-C', '--workspace', '-w', '--workspaces', '-ws', '--global', '-g']),
  pnpm: new Set(['--dir', '-C', '--filter', '-F', '--recursive', '-r']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '--filter']),
};
const NPM_TEST = new Set(['test', 't', 'tst']);
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_LIFECYCLE = new Set(['start', 'stop', 'restart']);
/** pnpm and yarn commands of their own, which a script of the same name does not replace. */
const PM_COMMANDS = new Set(['add', 'audit', 'bin', 'cache', 'config', 'create', 'dedupe', 'dlx', 'exec', 'i', 'import', 'info', 'init', 'install', 'link', 'list', 'ls', 'outdated', 'pack', 'prune', 'publish', 'rebuild', 'remove', 'rm', 'store', 'unlink', 'up', 'update', 'upgrade', 'version', 'why', 'x']);
const MAKE_VARIABLE = /\$[({]MAKE[)}]/g;
const MAKE_DEFAULT_GOAL = /^\.DEFAULT_GOAL\s*[:?]?=\s*(\S+)/;
const MAKE_ELSEWHERE = /^(?:-C|--directory|-f|--file|--makefile)/;
/** make options that print, question or touch instead of running the recipes. */
const MAKE_DRY = /^--(?:just-print|dry-run|recon|question|print-data-base|touch)$|^-(?!-)[A-Za-z]*[npqt]/;
const MAKE_VALUE_OPTIONS = new Set(['-o', '--old-file', '-W', '--what-if', '--new-file', '--assume-new', '-I', '--include-dir', '-l', '--load-average']);

/** True when the path exists and is a file (following links). */
const isFile = (absolute) => {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
};

/** True when the path exists and is a folder (following links). */
const isDirectory = (absolute) => {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The explicit rules of a Makefile in file order (target -> {prerequisites,
 * recipe}) and its default goal: .DEFAULT_GOAL, or the first target.
 * Variables, special targets and pattern rules are not targets.
 */
export function makeRules(text) {
  const rules = new Map();
  let goal = null;
  let first = null;
  let open = [];
  let continued = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      const text = line.slice(1).trim();
      const command = (continued ? text : text.replace(/^[@+-]+/, '')).replace(/\\$/, '').trimEnd();
      for (const name of open) {
        const { recipe } = rules.get(name);
        if (continued && recipe.length > 0) recipe[recipe.length - 1] += ` ${command}`;
        else recipe.push(command);
      }
      continued = text.endsWith('\\');
      continue;
    }
    continued = false;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    open = [];
    const setGoal = line.match(MAKE_DEFAULT_GOAL);
    if (setGoal) {
      goal = setGoal[1];
      continue;
    }
    const rule = line.match(MAKE_RULE);
    if (!rule) continue;
    const rest = line.slice(rule[0].length);
    const semicolon = rest.indexOf(';');
    const prerequisites = (semicolon === -1 ? rest : rest.slice(0, semicolon))
      .replace(/#.*$/, '')
      .split(/\s+/)
      .filter((word) => word !== '' && word !== '|');
    const inline = semicolon === -1 ? '' : rest.slice(semicolon + 1).trim();
    for (const name of rule[1].trim().split(/\s+/)) {
      if (!MAKE_TARGET.test(name)) continue;
      if (!rules.has(name)) rules.set(name, { prerequisites: [], recipe: [] });
      const entry = rules.get(name);
      entry.prerequisites.push(...prerequisites);
      if (inline) entry.recipe.push(inline);
      open.push(name);
      first ??= name;
    }
  }
  return { rules, goal: goal ?? first };
}

/** A YAML scalar as written after `key: `: unquoted, without a trailing comment. */
function yamlScalar(text) {
  const quote = text[0];
  if (quote !== "'" && quote !== '"') return text.replace(/\s+#.*$/, '').trim();
  let out = '';
  for (let k = 1; k < text.length; k += 1) {
    const c = text[k];
    if (quote === "'" && c === "'" && text[k + 1] === "'") {
      out += "'";
      k += 1;
    } else if (quote === '"' && c === '\\' && k + 1 < text.length) {
      const next = text[(k += 1)];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
    } else if (c === quote) {
      return out;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * One record per YAML line that holds a key or a list item: its column, the
 * column of the `-` that opens it as a list item (or null), the key, and its
 * scalar value, a block scalar's lines included. Enough YAML for GitHub
 * workflows; flow collections and multi-line plain scalars are not read.
 */
function yamlRecords(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:#|$)/.test(lines[i])) continue;
    let col = lines[i].length - lines[i].trimStart().length;
    let rest = lines[i].slice(col);
    let item = null;
    while (/^-(?:\s|$)/.test(rest)) {
      item = col;
      const after = rest.slice(1);
      col += 1 + after.length - after.trimStart().length;
      rest = after.trimStart();
    }
    const key = YAML_KEY.exec(rest);
    if (!key) {
      if (item !== null) records.push({ col, item, key: null, value: '' });
      continue;
    }
    let value = (key[2] ?? '').trim();
    if (YAML_BLOCK.test(value)) {
      const body = [];
      let indent = null;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() !== '' && nextIndent <= col) break;
        i += 1;
        if (next.trim() === '') {
          body.push('');
          continue;
        }
        indent ??= nextIndent;
        body.push(next.slice(Math.min(indent, nextIndent)));
      }
      while (body.at(-1) === '') body.pop();
      const joined = body.join('\n');
      value = value.startsWith('>') ? joined.replace(/([^\n])\n(?=[^\n])/g, '$1 ') : joined;
    } else {
      value = yamlScalar(value);
    }
    records.push({ col, item, key: key[1], value });
  }
  return records;
}

/** The commands of a workflow's `run:` steps that run in the project folder, in file order. */
export function workflowRuns(text) {
  const records = yamlRecords(text);
  const parentOf = records.map((record, k) => {
    for (let j = k - 1; j >= 0; j -= 1) if (records[j].col < record.col) return j;
    return -1;
  });
  const child = (k, key) => records.findIndex((record, j) => parentOf[j] === k && record.key === key);
  /** The keys of the mapping that holds records[k]: a step, for a step's run. */
  const mappingOf = (k) => {
    const { col } = records[k];
    const keys = [k];
    for (let j = k - 1; records[k].item === null && j >= 0 && records[j].col >= col; j -= 1) {
      if (records[j].col > col) continue;
      keys.push(j);
      if (records[j].item !== null) break;
    }
    for (let j = k + 1; j < records.length && records[j].col >= col; j += 1) {
      if (records[j].col > col) continue;
      if (records[j].item !== null) break;
      keys.push(j);
    }
    return keys;
  };
  const ownDir = (k) => {
    const dir = mappingOf(k).find((j) => records[j].key === 'working-directory');
    return dir === undefined ? undefined : records[dir].value;
  };
  /** The defaults.run.working-directory set in the mapping under records[k] (k = -1: the top level). */
  const defaultDir = (k) => {
    const defaults = child(k, 'defaults');
    const run = defaults === -1 ? -1 : child(defaults, 'run');
    const dir = run === -1 ? -1 : child(run, 'working-directory');
    return dir === -1 ? undefined : records[dir].value;
  };
  const runs = [];
  records.forEach((record, k) => {
    if (record.key !== 'run' || record.value === '' || parentOf[k] === -1 || records[parentOf[k]].key !== 'steps') return;
    let dir = ownDir(k);
    for (let ancestor = parentOf[k]; dir === undefined && ancestor !== null; ancestor = ancestor === -1 ? null : parentOf[ancestor]) {
      dir = defaultDir(ancestor);
    }
    if (dir === undefined || ROOT_DIRS.has(dir.replace(/\s+/g, ''))) runs.push(record.value);
  });
  return runs;
}

const scriptCall = (name) => ({ kind: 'script', name });
const targetCall = (name) => ({ kind: 'target', name });

/** The targets `make <args>` builds in the project folder: the ones named, or the default goal (null). */
function makeCalls(args) {
  if (args.some((word) => MAKE_ELSEWHERE.test(word) || MAKE_DRY.test(word))) return [];
  const targets = [];
  for (let k = 0; k < args.length; k += 1) {
    const word = args[k];
    if (word === '--') continue;
    if (word.startsWith('-')) {
      if (MAKE_VALUE_OPTIONS.has(word) || (word === '-j' && /^\d+$/.test(args[k + 1] ?? ''))) k += 1;
      continue;
    }
    if (!word.includes('=')) targets.push(targetCall(word));
  }
  return targets.length > 0 ? targets : [targetCall(null)];
}

/** The scripts and targets one program run with `args` reaches in the project folder. */
function callsOf(program, args) {
  if (program === 'make' || program === 'gmake') return makeCalls(args);
  const end = args.indexOf('--');
  const own = end === -1 ? args : args.slice(0, end);
  const option = (word) => word.split('=')[0];
  if (Object.hasOwn(ELSEWHERE, program) && own.some((word) => ELSEWHERE[program].has(option(word)))) return [];
  const [sub, name] = own.filter((word) => !word.startsWith('-'));
  if (program === 'npm') {
    if (NPM_TEST.has(sub)) return [scriptCall('test')];
    if (NPM_LIFECYCLE.has(sub)) return [scriptCall(sub)];
    return NPM_RUN.has(sub) && name ? [scriptCall(name)] : [];
  }
  if (program === 'pnpm' || program === 'yarn') {
    if (sub === 'run' || sub === 'run-script') return name ? [scriptCall(name)] : [];
    if (sub === undefined || sub === 'workspace' || sub === 'workspaces' || PM_COMMANDS.has(sub)) return [];
    return [scriptCall(program === 'pnpm' && NPM_TEST.has(sub) ? 'test' : sub)];
  }
  if (program === 'bun') return sub === 'run' && name ? [scriptCall(name)] : [];
  if (program === 'node') {
    const at = own.findIndex((word) => option(word) === '--run');
    const named = at === -1 ? undefined : own[at].includes('=') ? own[at].slice(own[at].indexOf('=') + 1) : own[at + 1];
    return named ? [scriptCall(named)] : [];
  }
  return [];
}

/**
 * The package scripts and make targets a command line runs in the project
 * folder, in order: [{kind: 'script' | 'target', name}], name null for make's
 * default goal. A cd leaves the project folder, so what follows it is left out.
 */
export function scriptCalls(command) {
  const calls = [];
  for (const { words } of parseShell(String(command).replace(MAKE_VARIABLE, 'make'))) {
    let i = 0;
    while (i < words.length && (SHELL_KEYWORDS.has(words[i]) || SHELL_ASSIGNMENT.test(words[i]))) i += 1;
    if (i === words.length) continue;
    const program = path.posix.basename(words[i]);
    const args = words.slice(i + 1);
    if ((program === 'cd' || program === 'pushd') && !ROOT_DIRS.has(args[0] ?? '')) break;
    calls.push(...callsOf(program, args));
  }
  return calls;
}

/** The names of the files directly in a project folder, sorted; none when it is missing. */
const filesIn = (root, dir) =>
  isDirectory(path.join(root, dir)) ? readdirSync(path.join(root, dir)).filter((name) => isFile(path.join(root, dir, name))).sort() : [];

/** The commands that run on their own: the run steps of the project's CI workflows and its blocking git hooks. */
function entryCommands(root) {
  const read = (dir, name) => readFileSync(path.join(root, dir, name), 'utf8');
  const workflows = filesIn(root, WORKFLOWS_DIR)
    .filter((name) => WORKFLOW_FILE.test(name))
    .flatMap((name) => workflowRuns(read(WORKFLOWS_DIR, name)));
  const hooks = HOOK_DIRS.flatMap((dir) => filesIn(root, dir).filter((name) => BLOCKING_HOOKS.has(name)).map((name) => read(dir, name)));
  return [...workflows, ...hooks];
}

/** The names of the scripts and make targets that CI or a git hook runs, directly or through other scripts and targets. */
export function ranChecks(root, { scripts, make }) {
  const ran = new Set();
  const seen = new Set();
  const queue = entryCommands(root).flatMap(scriptCalls);
  while (queue.length > 0) {
    const call = queue.shift();
    const name = call.kind === 'target' ? (call.name ?? make.goal) : call.name;
    const key = `${call.kind}:${name}`;
    if (name === null || seen.has(key)) continue;
    seen.add(key);
    if (call.kind === 'script' && scripts.has(name)) {
      ran.add(name);
      queue.push(...scriptCalls(scripts.get(name)));
    } else if (call.kind === 'target' && make.rules.has(name)) {
      ran.add(name);
      const { prerequisites, recipe } = make.rules.get(name);
      queue.push(...prerequisites.map(targetCall), ...recipe.flatMap(scriptCalls));
    }
  }
  return ran;
}
