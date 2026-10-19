// The project config, .claude/falsifiable.json: loading, validation, defaults.
//
// Every key is optional. Objects merge with their defaults; arrays replace
// theirs. The guard's built-in protected paths are always added, so no config
// can unprotect the guard's own policy. The file is itself protected: agents
// can read the policy, and only a session a person started with the unlock
// variable can change it.
//
// A file that breaks the schema can only add protection: the defaults apply,
// plus every protective list from the file that is valid on its own
// (protected branches and paths, blocked commands). Lists that grant access
// (local hosts, the verifier's read paths, commands and MCP servers) are
// ignored until the file is fixed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { overlaps } from './glob.mjs';
import { CONFIG_KEYWORDS, checkSchema, validate } from './schema.mjs';

export const CONFIG_FILE = '.claude/falsifiable.json';
export const PLUGIN = 'falsifiable';
export const ROLES = ['planner', 'builder', 'reviewer', 'verifier', 'scout'];
/** The agent type of a role as Claude Code names a plugin agent: falsifiable:verifier. */
export const agentType = (role) => `${PLUGIN}:${role}`;

export const PACKS = ['git', 'github', 'database', 'deploy', 'paths', 'secrets'];

/**
 * Paths no config can unprotect: the policy, the harness settings, hooks and
 * installed plugins (this guard among them), the MCP servers, and git's own
 * hooks and config, where a hook can be disabled without any git command.
 */
export const BUILT_IN_PROTECTED = Object.freeze([
  '.claude/settings.json',
  '.claude/settings.local.json',
  CONFIG_FILE,
  '.claude/hooks/**',
  '.claude/plugins/**',
  '.mcp.json',
  '.git/config',
  '.git/config.worktree',
  '.git/worktrees/*/config',
  '.git/worktrees/*/config.worktree',
  '.git/hooks/**',
]);

export const DEFAULTS = Object.freeze({
  guard: {
    packs: [...PACKS],
    protectedBranches: ['main', 'master'],
    localHosts: ['localhost', '127.0.0.1', '::1'],
    protectedPaths: ['.github/workflows/**', '.githooks/**', '.husky/**'],
    unlockEnv: 'FALSIFIABLE_UNLOCK',
    blockCommands: [],
  },
  delivery: {
    specsDir: 'openspec',
    baseBranch: 'main',
    domains: {
      code: {
        owns: ['**'],
        proof: 'tests written first and seen failing, then passing',
        gate: 'npm test',
        escalate: 'a new dependency, or anything the approved spec does not cover',
      },
    },
    sensitivePaths: {},
    limits: { maxLanes: 4, maxParallelBuilders: 2, maxFixRounds: 2, maxAgentsPerRun: 5, maxScouts: 2 },
  },
  verify: {
    baseUrl: 'http://localhost:3000',
    health: [],
    credentialEnv: [],
    instruments: 'HTTP calls with curl for APIs; a browser tool for pages',
    readPaths: [],
    commands: [],
    mcpServers: ['chrome', 'playwright'],
    sweep: [],
  },
  review: {
    checklist: '.claude/review-checklist.md',
    secondOpinion: '',
  },
  rules: {
    files: ['**/AGENTS.md'],
  },
});

const SCHEMA_FILE = fileURLToPath(new URL('../schema/config.schema.json', import.meta.url));
export const CONFIG_SCHEMA = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace. */
function merge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) out[key] = key in out ? merge(out[key], value) : structuredClone(value);
  return out;
}

/** Domains are a set the project defines: a config that names any replaces the default one. */
function withDomains(merged, raw) {
  if (isPlainObject(raw?.delivery?.domains)) merged.delivery.domains = structuredClone(raw.delivery.domains);
  return merged;
}

/**
 * The resolved config for a raw value (the parsed file, or undefined when there
 * is none). Problems are "<path>: <problem>" lines. `fallback` is true when the
 * file broke the schema, so the defaults (plus its valid protective lists)
 * apply instead of it. A sensitive path no domain owns is a problem for
 * planning only: it never resets the guard.
 */
export function resolveConfig(raw) {
  const schemaProblems = checkSchema(CONFIG_SCHEMA, CONFIG_KEYWORDS);
  if (schemaProblems.length) throw new Error(`schema/config.schema.json is broken: ${schemaProblems.join('; ')}`);
  const problems = raw === undefined ? [] : validate(CONFIG_SCHEMA, raw);
  const domains = raw?.delivery?.domains;
  if (isPlainObject(domains) && Object.keys(domains).length === 0) problems.push('$.delivery.domains: needs at least one domain');
  const fallback = problems.length > 0;
  let config;
  if (raw === undefined) config = structuredClone(DEFAULTS);
  else if (fallback) config = salvage(raw);
  else {
    config = withDomains(merge(DEFAULTS, raw), raw);
    problems.push(...uncoveredSensitivePaths(config.delivery));
  }
  config.guard.protectedPaths = [...new Set([...BUILT_IN_PROTECTED, ...config.guard.protectedPaths])];
  return { config, problems, fallback };
}

/** The value at `keys` in `raw` when it matches its own part of the schema; undefined otherwise. */
function validPart(raw, keys) {
  const value = keys.reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), raw);
  const schema = keys.reduce((node, key) => node?.properties?.[key], CONFIG_SCHEMA);
  return value !== undefined && schema && validate(schema, value).length === 0 ? value : undefined;
}

const union = (a, b = []) => [...new Set([...a, ...b])];

/** The defaults plus the protective lists of a broken file that are valid on their own. Nothing that grants access. */
function salvage(raw) {
  const config = structuredClone(DEFAULTS);
  config.guard.protectedBranches = union(config.guard.protectedBranches, validPart(raw, ['guard', 'protectedBranches']));
  config.guard.protectedPaths = union(config.guard.protectedPaths, validPart(raw, ['guard', 'protectedPaths']));
  const commandSchema = CONFIG_SCHEMA.properties.guard.properties.blockCommands.items;
  const commands = Array.isArray(raw?.guard?.blockCommands) ? raw.guard.blockCommands : [];
  config.guard.blockCommands = commands.filter((command) => validate(commandSchema, command).length === 0);
  return config;
}

/** A sensitive path outside every domain can never be owned by a lane, so its decision would never be asked. */
function uncoveredSensitivePaths({ domains, sensitivePaths }) {
  const owned = Object.values(domains).flatMap((domain) => domain.owns);
  return Object.entries(sensitivePaths).flatMap(([area, globs]) =>
    globs.flatMap((glob, i) =>
      owned.some((path) => overlaps(path, glob)) ? [] : [`$.delivery.sensitivePaths.${area}[${i}]: no domain owns a path that ${glob} covers`],
    ),
  );
}

/** Reads <projectDir>/.claude/falsifiable.json. found is false when the file does not exist. */
export function loadConfig(projectDir) {
  const file = path.join(projectDir, CONFIG_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ...resolveConfig(undefined), found: false, file };
    const problems = [`${CONFIG_FILE}: cannot be read (${error.code ?? error.message})`];
    return { ...resolveConfig(undefined), problems, fallback: true, found: true, file };
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { ...resolveConfig(undefined), problems: [`${CONFIG_FILE}: is not valid JSON (${error.message})`], fallback: true, found: true, file };
  }
  return { ...resolveConfig(raw), found: true, file };
}
