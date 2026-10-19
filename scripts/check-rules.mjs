#!/usr/bin/env node
//
// Checks that every rule in the project's rulebooks names what enforces it.
//
// A rule an agent reads ("never push to main") is only a promise until
// something fails when it is broken. So every rule ends with exactly one tag
// that names its enforcer, and the tag must resolve in this project:
//
//   [hook:<id>]      a rule id the guard hook reports: a built-in one in a pack
//                    the config turns on, or a guard.blockCommands id
//   [check:<name>]   a script in the project's package.json or a Makefile
//                    target that a CI workflow or a git hook runs (RUN BY)
//   [test:<path>]    a file that exists, relative to the project folder
//   [review:<slug>]  a `slug`: item in the review checklist (review.checklist)
//   [lint:<rule>]    an ESLint rule at "error" for a source file in scope, read
//                    from the project's own ESLint, loaded only when needed
//
// WHERE RULES ARE
//   Rulebooks are the files that match rules.files. A rules section is a
//   markdown heading whose next non-blank line is the marker <!-- rules -->
//   (Claude Code drops HTML comments from context, so the marker costs no
//   tokens). The section runs until the next heading of the same or a higher
//   level; its subheadings belong to it. Inside it, each top-level list item
//   (`-`, `*`, `+` or `1.` at column 0) is one rule, and indented lines right
//   after it continue it. Prose, fenced code and other sections are not
//   checked, and a tag inside `inline code` does not count. A rulebook with no
//   rules section fails, so a dropped marker cannot hide its rules.
//
// RUN BY
//   A check counts only when something runs it on its own: a `run:` step of a
//   workflow in .github/workflows/, or a git hook that can stop a commit or a
//   push (pre-commit, commit-msg, pre-push, …) in .husky/ or .githooks/, all
//   in the project folder. The check follows npm, pnpm, yarn, bun run,
//   node --run and make ($(MAKE) too) through the scripts and targets they
//   reach, a target's prerequisites and recipe included. A command in another
//   folder does not count: one after a cd, one given --prefix, -C, a workspace
//   or a filter, or a step whose working-directory (its own or the nearest
//   default) is another folder. Reading is best effort: what it cannot read
//   does not count, and it does not follow conditions, so a command behind
//   if, && or || counts as run.
//
// LINT SCOPE
//   A workspace is any folder with its own eslint.config.*. A rulebook at the
//   project root covers every workspace; a nested rulebook covers its own
//   folder, under the nearest workspace at or above it. The file checked is
//   the first source file in sorted order (under a workspace's src/ when it
//   has one) that is not a test, a spec or a .d.ts and that ESLint does not
//   ignore.
//
// USAGE
//   node scripts/check-rules.mjs [projectDir] [file...]
//
//   projectDir defaults to the current folder; files are relative to it.
//   Without files, every rulebook git lists is checked (outside a repository,
//   every one on disk, skipping node_modules and dot folders). A folder with
//   its own .claude/falsifiable.json is a project of its own and is skipped.
//
// Exit codes: 0 every rule resolves, 1 a rule does not or there is no
// rulebook, 2 bad usage or a config that breaks the schema (a planning
// problem such as an unowned sensitive path is config.mjs --check's to
// report). Zero dependencies.
// Tests: node --test test/check-rules.test.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONFIG_FILE, PACKS, loadConfig } from '../lib/config.mjs';
import { matches } from '../lib/glob.mjs';
import { RULES, ruleIds } from '../lib/guard/rule-ids.mjs';
import { HOOK_DIRS, WORKFLOWS_DIR, makeRules, ranChecks } from '../lib/runs.mjs';

export const TAG_KINDS = ['lint', 'hook', 'check', 'test', 'review'];

const RULES_MARKER = '<!-- rules -->';
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const NOT_SOURCE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '__tests__', '__mocks__', 'e2e', 'test', 'tests']);
const RULE_TEXT_MAX_CHARS = 160;
const GIT_LIST_MAX_BYTES = 256 * 1024 * 1024;
const USAGE = 'usage: node scripts/check-rules.mjs [projectDir] [file...]';

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`[^`\n]*`/g;
const TAG = /\[(lint|hook|check|test|review):([^\]]*)\]/g;
const CHECKLIST_ITEM = /^(?:[-*+]|\d+[.)])\s+`([a-z0-9][a-z0-9-]*)`:/;
const ESLINT_CONFIG = /^eslint\.config\.[cm]?[jt]s$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const NOT_SOURCE_FILE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[^.]+$/;
const SEVERITY_NAMES = { 0: 'off', 1: 'warn', 2: 'error' };

const toPosix = (p) => p.split(path.sep).join('/');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const truncate = (text) => (text.length > RULE_TEXT_MAX_CHARS ? `${text.slice(0, RULE_TEXT_MAX_CHARS - 1)}…` : text);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** True when the path exists and is a folder (following links). */
const isDirectory = (absolute) => {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
};

/** True when the path exists and is a file (following links). */
const isFile = (absolute) => {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
};

/** True when `rel` is a folder below the project that has its own config: a project of its own. */
const isNestedProject = (root, rel) => rel !== '.' && existsSync(path.join(root, rel, CONFIG_FILE));

/** Tracks ``` / ~~~ fences; returns true while the line is a fence or inside one. */
const fenceTracker = () => {
  let fence = null;
  return (text) => {
    const match = text.match(FENCE);
    if (match) {
      if (fence === null) fence = match[1];
      else if (match[1] === fence) fence = null;
      return true;
    }
    return fence !== null;
  };
};

/** The rules ([{ line, text }]) and the number of marked rules sections in a markdown document. */
const parseRulebook = (markdown) => {
  const rules = [];
  let sections = 0;
  const inFence = fenceTracker();
  let sectionLevel = null;
  let headingLevel = null; // the last heading, while the marker may still follow it
  let current = null;
  const close = () => {
    if (current) rules.push(current);
    current = null;
  };

  markdown.split('\n').forEach((text, index) => {
    if (inFence(text)) {
      close();
      headingLevel = null;
      return;
    }
    const heading = text.match(HEADING);
    if (heading) {
      close();
      const level = heading[1].length;
      if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
      headingLevel = level;
      return;
    }
    if (text.trim() === '') {
      close();
      return;
    }
    if (text.trim() === RULES_MARKER) {
      if (headingLevel !== null && sectionLevel === null) {
        sectionLevel = headingLevel;
        sections += 1;
      }
      headingLevel = null;
      return;
    }
    headingLevel = null;
    if (sectionLevel === null) return;

    const item = text.match(LIST_ITEM);
    if (item) {
      close();
      current = { line: index + 1, text: item[1].trim() };
    } else if (current && /^\s/.test(text)) {
      current.text += ` ${text.trim()}`;
    } else {
      close();
    }
  });
  close();
  return { rules, sections };
};

/** Every rule in the marked rules sections of a markdown document: [{ line, text }]. */
export const extractRules = (markdown) => parseRulebook(markdown).rules;

/** The rule's one tag ({ tag: { kind, value } }) or why it has none ({ error }). */
export function parseTag(ruleText) {
  const text = ruleText.replace(INLINE_CODE, (span) => ' '.repeat(span.length)).trimEnd();
  const tags = [...text.matchAll(TAG)];
  if (tags.length === 0) {
    return { error: `no enforcement tag; end the rule with one of ${TAG_KINDS.map((k) => `[${k}:…]`).join(' ')}` };
  }
  if (tags.length > 1) return { error: `${tags.length} enforcement tags; a rule names exactly one` };
  const [match] = tags;
  if (match.index + match[0].length !== text.length) return { error: `the tag ${match[0]} must end the rule` };
  if (!/^\S+$/.test(match[2])) return { error: `malformed tag ${match[0]}` };
  return { tag: { kind: match[1], value: match[2] } };
}

/** The slugs of a review checklist: list items of the form - `slug`: what to check, outside code fences. */
export function reviewSlugs(markdown) {
  const slugs = new Set();
  const inFence = fenceTracker();
  for (const text of markdown.split('\n')) {
    if (inFence(text)) continue;
    const item = text.match(CHECKLIST_ITEM);
    if (item) slugs.add(item[1]);
  }
  return slugs;
}

/** The explicit targets of a Makefile; variables, recipes, special targets and pattern rules are not targets. */
export const makeTargets = (text) => new Set(makeRules(text).rules.keys());

/** Resolves [hook:<id>]: an id the guard reports, in a pack the config turns on. */
function hookResolver(config) {
  const ids = new Set(ruleIds(config));
  const custom = new Set(config.guard.blockCommands.map((command) => command.id));
  const packOf = new Map(RULES.map((rule) => [rule.id, rule.pack]));
  return (id) => {
    if (!ids.has(id)) return `is not a rule id the guard reports; use a built-in id or add a guard.blockCommands entry to ${CONFIG_FILE}`;
    const pack = packOf.get(id);
    if (!custom.has(id) && PACKS.includes(pack) && !config.guard.packs.includes(pack)) {
      return `belongs to the "${pack}" pack, which guard.packs turns off`;
    }
    return null;
  };
}

/** The scripts in package.json (name -> command) and the rules of the Makefile make would read; { error } when package.json is broken. */
function checkSources(root) {
  const scripts = new Map();
  const pkg = path.join(root, 'package.json');
  if (isFile(pkg)) {
    try {
      const declared = JSON.parse(readFileSync(pkg, 'utf8')).scripts;
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
        for (const [name, command] of Object.entries(declared)) scripts.set(name, typeof command === 'string' ? command : '');
      }
    } catch (error) {
      return { error: `cannot resolve: package.json is not valid JSON (${error.message})` };
    }
  }
  const makefile = MAKEFILES.map((name) => path.join(root, name)).find(isFile);
  const make = makefile ? makeRules(readFileSync(makefile, 'utf8')) : { rules: new Map(), goal: null };
  return { scripts, make };
}

/** Resolves [check:<name>]: a package.json script or a Makefile target that a CI workflow or a git hook runs. */
function checkResolver(root) {
  let sources;
  let ran;
  return (name) => {
    sources ??= checkSources(root);
    if (sources.error) return sources.error;
    const what = sources.scripts.has(name) ? 'a script in package.json' : sources.make.rules.has(name) ? 'a target in the Makefile' : null;
    if (what === null) return 'is not a script in package.json or a target in the Makefile';
    ran ??= ranChecks(root, sources);
    if (ran.has(name)) return null;
    const hooks = HOOK_DIRS.map((dir) => `${dir}/`).join(' or ');
    return `is ${what}, but no CI workflow or git hook runs it; run it from a step in ${WORKFLOWS_DIR}/ or a git hook in ${hooks}`;
  };
}

/** Resolves [test:<path>]: a file inside the project. */
const testResolver = (root) => (file) => {
  const absolute = path.resolve(root, file);
  const rel = path.relative(root, absolute);
  if (path.isAbsolute(file) || rel === '..' || rel.startsWith(`..${path.sep}`)) return 'is outside the project; name a file relative to the project folder';
  if (isDirectory(absolute)) return 'is a folder; name the test file';
  return isFile(absolute) ? null : 'does not exist';
};

/** Resolves [review:<slug>]: a slug in the checklist file the config names. */
function reviewResolver(root, checklist) {
  let slugs;
  return (slug) => {
    if (slugs === undefined) {
      const file = path.join(root, checklist);
      slugs = isFile(file) ? reviewSlugs(readFileSync(file, 'utf8')) : null;
    }
    if (slugs === null) return `cannot resolve: ${checklist} does not exist`;
    return slugs.has(slug) ? null : `is not a slug in ${checklist}`;
  };
}

/** Folders below the project root ('.' for the root itself) that hold their own eslint.config.*. */
function eslintWorkspaces(root) {
  const found = [];
  const walk = (rel) => {
    const entries = readdirSync(path.join(root, rel), { withFileTypes: true }).sort(byName);
    if (entries.some((entry) => entry.isFile() && ESLINT_CONFIG.test(entry.name))) found.push(rel);
    for (const entry of entries) {
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && !isNestedProject(root, child)) walk(child);
    }
  };
  walk('.');
  return found;
}

/** [{ workspace, dir }] a lint tag in `file` is checked against. */
function lintScopes(root, workspaces, file) {
  const dir = path.posix.dirname(file);
  const sourceDir = (ws) => (isDirectory(path.join(root, ws, 'src')) ? path.posix.join(ws, 'src') : ws);
  if (dir === '.') return workspaces.map((ws) => ({ workspace: ws, dir: sourceDir(ws) }));
  const depth = (ws) => (ws === '.' ? 0 : ws.split('/').length);
  const covering = workspaces.filter((ws) => ws === '.' || dir === ws || dir.startsWith(`${ws}/`));
  if (covering.length === 0) return [];
  const nearest = covering.reduce((a, b) => (depth(b) > depth(a) ? b : a));
  return [{ workspace: nearest, dir: dir === nearest ? sourceDir(nearest) : dir }];
}

/** Source files under `dir` in sorted order; tests, build output, configs and other workspaces are left out. */
function* sourceFiles(root, dir, workspaces) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true }).sort(byName)) {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      const skip = entry.name.startsWith('.') || NOT_SOURCE_DIRS.has(entry.name) || workspaces.includes(rel) || isNestedProject(root, rel);
      if (!skip) yield* sourceFiles(root, rel, workspaces);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !NOT_SOURCE_FILE.test(entry.name) && !ESLINT_CONFIG.test(entry.name)) {
      yield rel;
    }
  }
}

/** The ESLint class the project installs, resolved from the workspace and then the project root. */
async function loadESLint(root, workspace) {
  const origins = [...new Set([path.join(root, workspace, 'package.json'), path.join(root, 'package.json')])];
  for (const origin of origins) {
    let resolved;
    try {
      resolved = createRequire(origin).resolve('eslint');
    } catch {
      continue;
    }
    const module = await import(pathToFileURL(resolved).href);
    const ESLint = module.ESLint ?? module.default?.ESLint;
    if (ESLint) return ESLint;
  }
  const from = workspace === '.' ? 'the project folder' : workspace;
  throw new Error(`ESLint is not installed in the project (looked from ${from}); install it, or name another enforcer`);
}

/** The first lintable source file under the scope and ESLint's config for it, or null when there is none. */
async function findProbe(root, { workspace, dir }, workspaces) {
  const ESLint = await loadESLint(root, workspace);
  const eslint = new ESLint({ cwd: path.join(root, workspace) });
  for (const rel of sourceFiles(root, dir, workspaces)) {
    const absolute = path.join(root, rel);
    if (!(await eslint.isPathIgnored(absolute))) return { file: rel, config: await eslint.calculateConfigForFile(absolute) };
  }
  return null;
}

const severityName = (entry) => {
  const level = Array.isArray(entry) ? entry[0] : entry;
  return SEVERITY_NAMES[level] ?? level ?? 'off';
};

/** Resolves [lint:<rule>]; the workspaces, ESLint and the probe files are found once per scope. */
function lintResolver(root) {
  let workspaces;
  const probes = new Map();
  return async (rule, { file }) => {
    workspaces ??= eslintWorkspaces(root);
    const scopes = lintScopes(root, workspaces, file);
    if (scopes.length === 0) return `cannot resolve: no eslint.config.* covers ${file}; a lint tag needs the project's own ESLint`;
    for (const scope of scopes) {
      const key = `${scope.workspace}\0${scope.dir}`;
      if (!probes.has(key)) probes.set(key, findProbe(root, scope, workspaces));
      let probe;
      try {
        probe = await probes.get(key);
      } catch (error) {
        return `cannot resolve: ${error.message}`;
      }
      if (!probe) return `cannot resolve: no lintable source file under ${scope.dir}`;
      const severity = severityName(probe.config?.rules?.[rule]);
      if (severity !== 'error') return `is "${severity}" for ${probe.file}; it must be "error"`;
    }
    return null;
  };
}

/**
 * Checks the rules in `files` (project-relative) against a resolved config.
 * Returns the problems ([{ file, line, rule, message }]), the resolved tags per
 * kind and the rule count.
 */
export async function checkRules({ root, config, files }) {
  const resolve = {
    lint: lintResolver(root),
    hook: hookResolver(config),
    check: checkResolver(root),
    test: testResolver(root),
    review: reviewResolver(root, config.review.checklist),
  };
  const problems = [];
  const counts = Object.fromEntries(TAG_KINDS.map((kind) => [kind, 0]));
  let total = 0;
  for (const file of files) {
    const { rules, sections } = parseRulebook(readFileSync(path.join(root, file), 'utf8'));
    if (sections === 0) {
      problems.push({ file, line: 1, rule: '', message: `no rules section; mark one with a heading followed by ${RULES_MARKER}` });
    }
    for (const rule of rules) {
      total += 1;
      const fail = (message) => problems.push({ file, line: rule.line, rule: rule.text, message });
      const { tag, error } = parseTag(rule.text);
      if (error) {
        fail(error);
        continue;
      }
      const unresolved = await resolve[tag.kind](tag.value, { file });
      if (unresolved) fail(`[${tag.kind}:${tag.value}] ${unresolved}`);
      else counts[tag.kind] += 1;
    }
  }
  return { problems, counts, total };
}

/** Every file below `dir` on disk, skipping node_modules and dot folders. */
function walkFiles(root, dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name.startsWith('.') || entry.name === 'node_modules' ? [] : walkFiles(root, rel);
    return entry.isFile() ? [rel] : [];
  });
}

/** The project's files: what git tracks or would track, or every file on disk outside a repository. */
function projectFiles(root) {
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') return walkFiles(root, '.');
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_LIST_MAX_BYTES,
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  return [...new Set(listed.stdout.split('\0').filter(Boolean))];
}

/** The outermost folder above `file` that is a project of its own, or null. */
function nestedProjectOf(root, file) {
  const segments = path.posix.dirname(file).split('/').filter((s) => s !== '.');
  for (let i = 1; i <= segments.length; i += 1) {
    const dir = segments.slice(0, i).join('/');
    if (isNestedProject(root, dir)) return dir;
  }
  return null;
}

/** The rulebooks that match `globs`, sorted, and the nested projects whose rulebooks were left out. */
export function listRulebooks(root, globs) {
  const nested = new Set();
  const files = projectFiles(root)
    .filter((file) => globs.some((glob) => matches(glob, file)) && isFile(path.join(root, file)))
    .filter((file) => {
      const owner = nestedProjectOf(root, file);
      if (owner) nested.add(owner);
      return owner === null;
    })
    .sort();
  return { files, nested: [...nested].sort() };
}

const usage = (problem) => {
  process.stderr.write(`${problem ? `${problem}\n` : ''}${USAGE}\n`);
  return 2;
};

/** Runs the check for the command-line arguments and returns the exit code. */
async function main(argv) {
  if (argv.some((arg) => arg.startsWith('-'))) return usage();
  const root = path.resolve(argv[0] ?? '.');
  if (!isDirectory(root)) return usage(`not a folder: ${argv[0]}`);
  const loaded = loadConfig(root);
  // Only a file that breaks the schema stops the check; a planning problem, such as a sensitive path no domain owns, leaves the rules intact.
  if (loaded.fallback) {
    process.stderr.write(`${CONFIG_FILE} is invalid; fix it, then run the check again:\n${loaded.problems.map((p) => `- ${p}`).join('\n')}\n`);
    return 2;
  }
  const { config } = loaded;

  let files = [];
  let nested = [];
  if (argv.length > 1) {
    for (const arg of argv.slice(1)) {
      const absolute = path.resolve(root, arg);
      const rel = toPosix(path.relative(root, absolute));
      if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || !isFile(absolute)) {
        return usage(`no such file in the project: ${arg}`);
      }
      files.push(rel);
    }
  } else {
    ({ files, nested } = listRulebooks(root, config.rules.files));
  }
  const skipped = nested.map((dir) => `  skipped ${dir}: it has its own ${CONFIG_FILE}; check it with that folder as projectDir.\n`).join('');

  if (files.length === 0) {
    process.stderr.write(
      `✗ check-rules: no rulebook matches rules.files (${config.rules.files.join(', ')}).` +
        ` Add a rules section to AGENTS.md, or point rules.files in ${CONFIG_FILE} at your rulebooks.\n`,
    );
    process.stdout.write(skipped);
    return 1;
  }

  const { problems, counts, total } = await checkRules({ root, config, files });
  if (problems.length === 0) {
    const ratio = TAG_KINDS.map((kind) => `${kind} ${counts[kind]}`).join(' · ');
    process.stdout.write(`✓ check-rules: ${plural(total, 'rule')} in ${plural(files.length, 'file')} resolve (${ratio}).\n${skipped}`);
    return 0;
  }
  const lines = problems.map((p) => `  ${p.file}:${p.line}  ${p.message}${p.rule ? `\n      ${truncate(p.rule)}` : ''}`);
  process.stderr.write(
    `✗ check-rules: ${plural(problems.length, 'problem')} in ${plural(files.length, 'file')} (${plural(total, 'rule')} checked):\n\n` +
      `${lines.join('\n')}\n\n` +
      'End each rule with the one tag that enforces it: [hook:<guard rule id>] [check:<script or make target that CI or a git hook runs>]' +
      ` [test:<file>] [review:<slug in ${config.review.checklist}>] [lint:<ESLint rule at error>].\n`,
  );
  process.stdout.write(skipped);
  return 1;
}

/** True when this file is the script node was asked to run, also through a linked plugin folder. */
const isEntryPoint = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (isEntryPoint()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-rules could not run: ${error.message}\n`);
    process.exitCode = 2;
  }
}
