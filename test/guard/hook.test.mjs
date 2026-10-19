// End-to-end tests for the PreToolUse hook (scripts/hook.mjs): spawn it, send
// a Claude Code payload on stdin, check the exit code and stderr. Also checks
// that hooks/hooks.json registers it the way the tests run it.
//
//   node --test test/guard/hook.test.mjs
import './git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILE } from '../../lib/config.mjs';
import { ALLOWED, BLOCKED, CONFIG_CASES } from './cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'scripts/hook.mjs');
const INVALID = /\(The falsifiable config is invalid, so the defaults apply: .+\.\)\n$/;

const tempDirs = [];
const tempDir = (prefix) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A git repository on `branch`, with `config` written as its falsifiable config when given. */
function project(branch, config) {
  const dir = tempDir('falsifiable-hook-');
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  if (config !== undefined) {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, CONFIG_FILE), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

/** The session environment the hook sees: nothing from this test run that could unlock or redirect it. */
function sessionEnv(extra = {}) {
  const env = { ...process.env };
  const SESSION_KEYS = ['FALSIFIABLE_UNLOCK', 'MY_UNLOCK', 'CLAUDE_PROJECT_DIR', 'PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSWORD', 'DATABASE_URL', 'DIRECT_URL'];
  for (const key of SESSION_KEYS) delete env[key];
  return { ...env, ...extra };
}

/** Spawn the hook with `stdin` and resolve {code, stdout, stderr}. */
const runHook = (stdin, { env = {}, cwd } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: sessionEnv(env), cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** A case-table request as the payload Claude Code sends; edits rotate through the four file tools. */
function toPayload(request, index, cwd, extra = {}) {
  const common = { session_id: 's', hook_event_name: 'PreToolUse', cwd, tool_use_id: `t${index}`, ...extra };
  if (request.kind === 'bash') return { ...common, tool_name: 'Bash', tool_input: { command: request.command, description: 'x' } };
  if (request.kind === 'mcp') return { ...common, tool_name: request.tool, tool_input: request.input ?? {} };
  const tool = EDIT_TOOLS[index % EDIT_TOOLS.length];
  const { path: filePath, content } = request;
  const inputs = {
    Write: { file_path: filePath, content },
    Edit: { file_path: filePath, old_string: 'a', new_string: content, replace_all: false },
    MultiEdit: { file_path: filePath, edits: [{ old_string: 'a', new_string: 'ok' }, { old_string: 'b', new_string: content }] },
    NotebookEdit: { notebook_path: filePath, new_source: content, cell_id: 'c1' },
  };
  return { ...common, tool_name: tool, tool_input: inputs[tool] };
}

let featureRepo;
let mainRepo;
before(() => {
  featureRepo = project('feat/e2e');
  mainRepo = project('main');
});

const run = (payload, { env = {}, projectDir = featureRepo } = {}) =>
  runHook(JSON.stringify(payload), { env: { CLAUDE_PROJECT_DIR: projectDir, ...env }, cwd: payload.cwd ?? projectDir });

describe('the hook blocks (exit 2, rule id on stderr)', { concurrency: 8 }, () => {
  BLOCKED.filter(([, request]) => request.branch === undefined).forEach(([name, request, rule], index) => {
    test(`${name} -> ${rule}`, async () => {
      const { code, stderr, stdout } = await run(toPayload(request, index, featureRepo), { env: request.env });
      assert.equal(code, 2, `expected exit 2, got ${code}; stderr: ${stderr}`);
      assert.ok(stderr.startsWith(`falsifiable guard blocked: ${rule}: `), stderr);
      assert.equal(stdout, '');
    });
  });
});

describe('the hook allows (exit 0, silent)', { concurrency: 8 }, () => {
  ALLOWED.filter(([, request]) => request.branch === undefined).forEach(([name, request], index) => {
    test(name, async () => {
      const { code, stderr, stdout } = await run(toPayload(request, index, featureRepo), { env: request.env });
      assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr}`);
      assert.equal(stderr, '');
      assert.equal(stdout, '');
    });
  });
});

describe('the hook reads the project config', { concurrency: 8 }, () => {
  CONFIG_CASES.filter(([, , request]) => request.branch === undefined).forEach(([name, raw, request, rule], index) => {
    test(`${name} -> ${rule ?? 'allowed'}`, async () => {
      const dir = project('feat/e2e', raw);
      const { code, stderr } = await run(toPayload(request, index, dir), { env: request.env, projectDir: dir });
      if (rule === null) assert.equal(code, 0, stderr);
      else {
        assert.equal(code, 2, stderr);
        assert.ok(stderr.startsWith(`falsifiable guard blocked: ${rule}: `), stderr);
      }
    });
  });

  test('falls back to the payload cwd when CLAUDE_PROJECT_DIR is not set', async () => {
    const dir = project('feat/e2e', { guard: { packs: ['github'] } });
    const payload = { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
    const { code, stderr } = await runHook(JSON.stringify(payload), { cwd: dir });
    assert.equal(code, 0, stderr);
  });
});

describe('the hook resolves the current branch for a bare git push', () => {
  test('blocks git push while on main', async () => {
    const { code, stderr } = await run({ cwd: mainRepo, tool_name: 'Bash', tool_input: { command: 'git push' } }, { projectDir: mainRepo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: git-push-protected: /);
  });

  test('allows git push on a feature branch', async () => {
    const { code, stderr } = await run({ cwd: featureRepo, tool_name: 'Bash', tool_input: { command: 'git push' } });
    assert.equal(code, 0, stderr);
  });

  test('blocks a bare push after cd into a repository on main', async () => {
    const { code, stderr } = await run({ cwd: featureRepo, tool_name: 'Bash', tool_input: { command: `cd ${mainRepo} && git push` } });
    assert.equal(code, 2, stderr);
    assert.match(stderr, /^falsifiable guard blocked: git-push-protected: /);
  });

  test('blocks pushing HEAD with git -C into a repository on main', async () => {
    const { code, stderr } = await run({ cwd: featureRepo, tool_name: 'Bash', tool_input: { command: `git -C ${mainRepo} push origin HEAD` } });
    assert.equal(code, 2, stderr);
    assert.match(stderr, /^falsifiable guard blocked: git-push-protected: /);
  });

  test('allows a bare push with git -C into a feature repository, from main', async () => {
    const { code, stderr } = await run({ cwd: mainRepo, tool_name: 'Bash', tool_input: { command: `git -C ${featureRepo} push` } }, { projectDir: mainRepo });
    assert.equal(code, 0, stderr);
  });

  test('allows a bare push after cd into a feature repository, from main', async () => {
    const { code, stderr } = await run({ cwd: mainRepo, tool_name: 'Bash', tool_input: { command: `cd ${featureRepo} && git push` } }, { projectDir: mainRepo });
    assert.equal(code, 0, stderr);
  });

  test('blocks git push while on a custom protected branch', async () => {
    const dir = project('trunk', { guard: { protectedBranches: ['trunk'] } });
    const { code, stderr } = await run({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push' } }, { projectDir: dir });
    assert.equal(code, 2, stderr);
  });
});

describe('protected paths unlock only from the session environment', () => {
  const payload = { tool_name: 'Edit', tool_input: { file_path: '/repo/.claude/settings.json', old_string: 'a', new_string: 'b' } };

  test('blocks without the unlock variable and says how a person unlocks it', async () => {
    const { code, stderr } = await run(payload);
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: protected-path: /);
    assert.match(stderr, /FALSIFIABLE_UNLOCK=1/);
  });

  test('allows with the unlock variable', async () => {
    const { code, stderr } = await run(payload, { env: { FALSIFIABLE_UNLOCK: '1' } });
    assert.equal(code, 0, stderr);
  });

  test('an unlock set inside the command does not count', async () => {
    const { code } = await run({ tool_name: 'Bash', tool_input: { command: 'FALSIFIABLE_UNLOCK=1 rm .claude/settings.json' } });
    assert.equal(code, 2);
  });
});

describe('an invalid config falls back to the defaults and says so', () => {
  test('a config that breaks the schema', async () => {
    const dir = project('feat/e2e', { guard: { packs: [], protectedBranches: [] } });
    const { code, stderr } = await run({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, { projectDir: dir });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: git-push-protected: /);
    assert.match(stderr, INVALID);
    assert.match(stderr, /protectedBranches/);
  });

  test('a config that is not JSON', async () => {
    const dir = project('feat/e2e', '{ not json');
    const { code, stderr } = await run({ cwd: dir, tool_name: 'Write', tool_input: { file_path: `${dir}/.mcp.json`, content: '{}' } }, { projectDir: dir });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: protected-path: /);
    assert.match(stderr, INVALID);
  });

  test('an allowed call stays silent', async () => {
    const dir = project('feat/e2e', '{ not json');
    const { code, stderr } = await run({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'git status' } }, { projectDir: dir });
    assert.equal(code, 0);
    assert.equal(stderr, '');
  });

  test('a valid config with only a planning problem blocks without the note', async () => {
    const raw = { delivery: { domains: { api: { owns: ['api/**'], proof: 'x', gate: 'npm test' } }, sensitivePaths: { billing: ['web/**'] } } };
    const dir = project('main', raw);
    const { code, stderr } = await run({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, { projectDir: dir });
    assert.equal(code, 2, stderr);
    assert.match(stderr, /^falsifiable guard blocked: git-push-protected: /);
    assert.doesNotMatch(stderr, INVALID);
  });
});

describe('the hook fences role agents', () => {
  let repo;
  before(() => {
    repo = project('feat/e2e');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
  });
  const as = (agentType, tool, input) => ({ cwd: repo, agent_type: agentType, agent_id: 'a1', tool_name: tool, tool_input: input });

  test('the verifier may not read product source', async () => {
    const { code, stderr } = await run(as('falsifiable:verifier', 'Read', { file_path: `${repo}/src/app.ts` }), { projectDir: repo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: fence-read: /);
  });

  test('the verifier may not see the diff', async () => {
    const { code, stderr } = await run(as('falsifiable:verifier', 'Bash', { command: 'git diff' }), { projectDir: repo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: fence-diff: /);
  });

  test('the verifier may not run a program off its allow-list', async () => {
    const { code, stderr } = await run(as('falsifiable:verifier', 'Bash', { command: 'node scripts/run.mjs' }), { projectDir: repo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: fence-tool: /);
  });

  test('the verifier may curl the local app', async () => {
    const { code, stderr } = await run(as('falsifiable:verifier', 'Bash', { command: 'curl -s http://localhost:3000/api/notes' }), { projectDir: repo });
    assert.equal(code, 0, stderr);
  });

  test('the verifier may not reach the web', async () => {
    const { code, stderr } = await run(as('falsifiable:verifier', 'WebFetch', { url: 'https://example.com' }), { projectDir: repo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: fence-tool: /);
  });

  test('the verifier may not use a non-browser MCP server', async () => {
    const { code, stderr } = await run(as('falsifiable:verifier', 'mcp__supabase__execute_sql', { query: 'select 1' }), { projectDir: repo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: fence-tool: /);
  });

  test('the reviewer may only use read-shaped MCP tools', async () => {
    const ok = await run(as('falsifiable:reviewer', 'mcp__github__get_pull_request', {}), { projectDir: repo });
    assert.equal(ok.code, 0, ok.stderr);
    const bad = await run(as('falsifiable:reviewer', 'mcp__github__create_issue', {}), { projectDir: repo });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /^falsifiable guard blocked: fence-tool: /);
  });

  test('the reviewer may not write a file', async () => {
    const { code, stderr } = await run(as('falsifiable:reviewer', 'Write', { file_path: `${repo}/notes.md`, content: 'x' }), { projectDir: repo });
    assert.equal(code, 2);
    assert.match(stderr, /^falsifiable guard blocked: fence-write: /);
  });

  test('the reviewer may write its scratchpad from the shell', async () => {
    const scratch = tempDir('falsifiable-scratch-');
    const payload = { ...as('falsifiable:reviewer', 'Bash', { command: `git status > ${scratch}/s.txt` }), scratchpad_dir: scratch };
    const { code, stderr } = await run(payload, { projectDir: repo });
    assert.equal(code, 0, stderr);
  });

  test('the builder writes freely, and the guard still applies to it', async () => {
    const write = await run(as('falsifiable:builder', 'Write', { file_path: `${repo}/src/app.ts`, content: 'x' }), { projectDir: repo });
    assert.equal(write.code, 0, write.stderr);
    const push = await run(as('falsifiable:builder', 'Bash', { command: 'git push origin main' }), { projectDir: repo });
    assert.equal(push.code, 2);
    assert.match(push.stderr, /^falsifiable guard blocked: git-push-protected: /);
  });

  test('the main session reads anything', async () => {
    const { code, stderr } = await run({ cwd: repo, tool_name: 'Read', tool_input: { file_path: `${repo}/src/app.ts` } }, { projectDir: repo });
    assert.equal(code, 0, stderr);
  });
});

describe('the hook fails closed on malformed input', () => {
  const cases = [
    ['not JSON', 'not json'],
    ['empty stdin', ''],
    ['JSON array', '[]'],
    ['no tool_name', '{}'],
    ['Bash without a command', JSON.stringify({ tool_name: 'Bash', tool_input: {} })],
    ['Write without a file_path', JSON.stringify({ tool_name: 'Write', tool_input: { content: 'x' } })],
    ['tool_input is a string', JSON.stringify({ tool_name: 'Bash', tool_input: 'rm -rf /' })],
    ['an MCP tool_input that is not an object', JSON.stringify({ tool_name: 'mcp__supabase__execute_sql', tool_input: null })],
    ['a fenced Read without a file_path', JSON.stringify({ tool_name: 'Read', agent_type: 'falsifiable:verifier', tool_input: {} })],
  ];
  for (const [name, stdin] of cases) {
    test(name, async () => {
      const { code, stderr, stdout } = await runHook(stdin, { env: { CLAUDE_PROJECT_DIR: featureRepo }, cwd: featureRepo });
      assert.equal(code, 2, stderr);
      assert.match(stderr, /^falsifiable guard blocked: malformed-input: .+\. .+\.\n$/);
      assert.equal(stdout, '');
    });
  }

  test('tolerates a UTF-8 byte order mark', async () => {
    const { code, stderr } = await runHook('﻿' + JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }), { env: { CLAUDE_PROJECT_DIR: featureRepo } });
    assert.equal(code, 0, stderr);
  });
});

describe('hooks/hooks.json', () => {
  const file = JSON.parse(readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const entries = file.hooks.PreToolUse;
  const covers = (tool) => entries.some((entry) => new RegExp(`^(?:${entry.matcher})$`).test(tool));

  test('has a description and only PreToolUse hooks', () => {
    assert.equal(typeof file.description, 'string');
    assert.deepEqual(Object.keys(file.hooks), ['PreToolUse']);
  });

  test('covers every tool the hook checks, including the web tools so the fence sees them', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__supabase__execute_sql']) assert.ok(covers(tool), tool);
  });

  test('runs this script in exec form, blocks on failure, within 10 seconds', () => {
    for (const entry of entries) {
      assert.deepEqual(entry.hooks, [
        { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs'], timeout: 10, onFailure: 'block' },
      ]);
    }
    assert.ok(existsSync(HOOK));
  });
});
