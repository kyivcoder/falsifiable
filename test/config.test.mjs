import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUILT_IN_PROTECTED, CONFIG_FILE, DEFAULTS, loadConfig, resolveConfig } from '../lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'falsifiable-config-'));
  dirs.push(dir);
  if (content !== undefined) {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, CONFIG_FILE), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('resolveConfig', () => {
  test('no file gives the defaults plus the built-in protected paths', () => {
    const { config, problems } = resolveConfig(undefined);
    assert.deepEqual(problems, []);
    assert.deepEqual(config.guard.packs, DEFAULTS.guard.packs);
    for (const p of BUILT_IN_PROTECTED) assert.ok(config.guard.protectedPaths.includes(p), `${p} is protected`);
  });

  test('objects merge and arrays replace', () => {
    const { config, problems } = resolveConfig({ guard: { protectedBranches: ['trunk'] }, delivery: { limits: { maxLanes: 2 } } });
    assert.deepEqual(problems, []);
    assert.deepEqual(config.guard.protectedBranches, ['trunk']);
    assert.equal(config.delivery.limits.maxLanes, 2);
    assert.equal(config.delivery.limits.maxFixRounds, DEFAULTS.delivery.limits.maxFixRounds);
    assert.equal(config.guard.unlockEnv, DEFAULTS.guard.unlockEnv);
  });

  test('a config cannot unprotect the built-in paths', () => {
    const { config } = resolveConfig({ guard: { protectedPaths: [] } });
    assert.deepEqual(config.guard.protectedPaths, [...BUILT_IN_PROTECTED]);
  });

  test('named domains replace the default domain instead of merging with it', () => {
    const api = { owns: ['api/**'], proof: 'unit tests', gate: 'npm test' };
    const { config } = resolveConfig({ delivery: { domains: { api } } });
    assert.deepEqual(Object.keys(config.delivery.domains), ['api']);
  });

  test('an invalid config reports every problem and falls back to the defaults', () => {
    const { config, problems, fallback } = resolveConfig({ guard: { packs: ['git', 'nope'], unlockEnv: 'lower' }, extra: 1 });
    assert.equal(fallback, true);
    assert.ok(problems.some((p) => p.startsWith('$.guard.packs[1]')), problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith('$.guard.unlockEnv')), problems.join('\n'));
    assert.ok(problems.some((p) => p === '$.extra: not allowed'), problems.join('\n'));
    assert.deepEqual(config.guard.packs, DEFAULTS.guard.packs);
  });

  test('an invalid config keeps its own valid protective lists, so a broken file only adds protection', () => {
    const publish = { id: 'npm-publish', argv: ['npm', 'publish'], why: 'private', instead: 'ask the user' };
    const { config, fallback } = resolveConfig({
      guard: { protectedBranches: ['release/*'], protectedPaths: ['infra/**'], blockCommands: [publish, { id: 'Bad Id' }], localHosts: ['db.prod.example.com'] },
      verify: { readPaths: ['src/**'], mcpServers: ['filesystem'], commands: [['node']], baseUrl: 'https://example.com' },
    });
    assert.equal(fallback, true);
    assert.deepEqual(config.guard.protectedBranches, ['main', 'master', 'release/*']);
    assert.ok(config.guard.protectedPaths.includes('infra/**'));
    assert.deepEqual(config.guard.blockCommands, [publish], 'a valid blocked command is kept, an invalid one dropped');
    assert.deepEqual(config.guard.localHosts, DEFAULTS.guard.localHosts, 'a list that grants access is ignored');
    assert.deepEqual(config.verify.readPaths, [], 'the verifier gets no extra read paths');
    assert.deepEqual(config.verify.mcpServers, DEFAULTS.verify.mcpServers);
    assert.deepEqual(config.verify.commands, []);
  });

  test('git hooks and config, installed plugins and the policy are always protected', () => {
    for (const p of ['.git/config', '.git/worktrees/*/config.worktree', '.git/hooks/**', '.claude/plugins/**', CONFIG_FILE]) {
      assert.ok(resolveConfig({ guard: { protectedPaths: [] } }).config.guard.protectedPaths.includes(p), p);
    }
  });

  test('a sensitive path that no domain covers is a problem, because no lane could ever own it', () => {
    const api = { owns: ['server.mjs', 'test/**'], proof: 'unit tests', gate: 'npm test' };
    const uncovered = resolveConfig({ guard: { protectedBranches: ['trunk'] }, delivery: { domains: { api }, sensitivePaths: { auth: ['auth/**'] } } });
    assert.deepEqual(uncovered.problems, ['$.delivery.sensitivePaths.auth[0]: no domain owns a path that auth/** covers']);
    assert.equal(uncovered.fallback, false, 'a planning problem never resets the guard');
    assert.deepEqual(uncovered.config.guard.protectedBranches, ['trunk']);
    const covered = { ...api, owns: [...api.owns, 'auth/**'] };
    assert.deepEqual(resolveConfig({ delivery: { domains: { api: covered }, sensitivePaths: { auth: ['auth/**'] } } }).problems, []);
  });

  test('an empty domain set is a problem', () => {
    assert.deepEqual(resolveConfig({ delivery: { domains: {} } }).problems, ['$.delivery.domains: needs at least one domain']);
  });

  test('the verifier base URL must be local', () => {
    assert.deepEqual(resolveConfig({ verify: { baseUrl: 'http://localhost:5173/app' } }).problems, []);
    assert.equal(resolveConfig({ verify: { baseUrl: 'https://example.com' } }).problems.length, 1);
  });
});

describe('loadConfig', () => {
  test('a missing file is not a problem', () => {
    const { found, problems } = loadConfig(project());
    assert.equal(found, false);
    assert.deepEqual(problems, []);
  });

  test('broken JSON is a problem, and the defaults apply', () => {
    const { found, problems, config } = loadConfig(project('{ not json'));
    assert.equal(found, true);
    assert.match(problems[0], /is not valid JSON/);
    assert.deepEqual(config.guard.packs, DEFAULTS.guard.packs);
  });

  test('reads a valid file', () => {
    const { problems, config } = loadConfig(project({ guard: { packs: ['git'] } }));
    assert.deepEqual(problems, []);
    assert.deepEqual(config.guard.packs, ['git']);
  });
});

describe('scripts/config.mjs', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/config.mjs'), ...args], { encoding: 'utf8' });

  test('prints the resolved config', () => {
    const result = run(project({ delivery: { baseBranch: 'trunk' } }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).delivery.baseBranch, 'trunk');
  });

  test('--check exits 1 and lists the problems of an invalid file', () => {
    const result = run('--check', project({ guard: { packs: 'git' } }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\$\.guard\.packs: expected array/);
  });

  test('bad usage exits 2', () => assert.equal(run('--nope').status, 2));
});
