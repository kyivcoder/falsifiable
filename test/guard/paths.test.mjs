// Tests for protected-path matching that need a real git worktree on disk:
// paths are judged relative to the worktree root (so a checkout under a folder
// named like a protected glob is fine), and symlinks are resolved.
//
//   node --test test/guard/paths.test.mjs
import './git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { resolveConfig } from '../../lib/config.mjs';
import { evaluate } from '../../lib/guard/engine.mjs';

const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function makeRepo(root) {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  return root;
}
function tempRepo(prefix, sub = '') {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(base);
  return makeRepo(sub ? path.join(base, sub) : base);
}

const configWith = (protectedPaths) => resolveConfig({ guard: { protectedPaths } }).config;
const edit = (filePath, config) => evaluate({ kind: 'edit', path: filePath, content: '{}', env: {} }, config);
const shell = (command, cwd, config) => evaluate({ kind: 'bash', command, cwd, env: {} }, config);
const mcp = (tool, input, config) => evaluate({ kind: 'mcp', tool, input, env: {} }, config);

function assertBlocked(result, rule = 'protected-path') {
  assert.equal(result.allow, false, `expected a block, got ${JSON.stringify(result)}`);
  assert.equal(result.rule, rule, result.message);
}
const assertAllowed = (result) => assert.equal(result.allow, true, result.message);

describe('protected paths are matched relative to the worktree root', () => {
  // A project that itself lives under a folder named like a protected glob.
  const REPO = tempRepo('paths-infra-', path.join('infra', 'proj'));
  const config = configWith(['infra/**', '.github/workflows/**']);

  test('a write outside the protected glob is allowed, even under a folder named infra', () => {
    assertAllowed(edit(path.join(REPO, 'src/app.ts'), config));
    assertAllowed(shell('echo x > src/app.ts', REPO, config));
  });

  test('a write to the protected glob, relative to the worktree, is blocked', () => {
    assertBlocked(edit(path.join(REPO, 'infra/main.tf'), config));
    assertBlocked(shell('echo x > infra/main.tf', REPO, config));
  });

  test('the built-in policy files inside the worktree stay protected', () => {
    assertBlocked(edit(path.join(REPO, '.claude/settings.json'), config));
    assertBlocked(shell('echo x > .github/workflows/ci.yml', REPO, config));
  });

  test('a target outside every worktree is matched by its absolute path', () => {
    assertBlocked(edit('/nowhere/.claude/settings.json', config));
  });
});

describe('symlinks are resolved to their real target', () => {
  const REPO = tempRepo('paths-link-');
  mkdirSync(path.join(REPO, '.claude'), { recursive: true });
  mkdirSync(path.join(REPO, '.github/workflows'), { recursive: true });
  symlinkSync(path.join(REPO, '.claude'), path.join(REPO, 'cfg'));
  const config = resolveConfig(undefined).config;

  test('a file tool write through a symlink into a protected folder is blocked', () => {
    assertBlocked(edit(path.join(REPO, 'cfg/settings.json'), config));
  });

  test('a shell write through a symlink into a protected folder is blocked', () => {
    assertBlocked(shell('echo x > cfg/settings.json', REPO, config));
  });

  test('ln is blocked when its target reaches a protected path', () => {
    assertBlocked(shell('ln -s .claude other', REPO, config));
  });

  test('ln is blocked when its link path is protected', () => {
    assertBlocked(shell('ln -s /tmp/evil .github/workflows/ci.yml', REPO, config));
  });

  test('a command that makes a link and then writes through it is blocked', () => {
    assertBlocked(shell('ln -s /tmp/plain p && echo x > p/ok.txt && echo y > cfg/settings.json', REPO, config));
  });

  test('an ordinary symlink write is allowed', () => {
    symlinkSync(path.join(REPO, 'src'), path.join(REPO, 'srclink'));
    mkdirSync(path.join(REPO, 'src'), { recursive: true });
    assertAllowed(shell('echo x > srclink/app.ts', REPO, config));
  });
});

describe('git apply reads the patch to find what it writes', () => {
  const REPO = tempRepo('paths-apply-');
  const config = resolveConfig(undefined).config;
  const patch = (target) => `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+b\n`;
  writeFileSync(path.join(REPO, 'protected.patch'), patch('.github/workflows/ci.yml'));
  writeFileSync(path.join(REPO, 'ordinary.patch'), patch('src/app.ts'));
  writeFileSync(path.join(REPO, 'rename.patch'), `diff --git a/x b/.githooks/pre-push\nrename from x\nrename to .githooks/pre-push\n`);

  test('git apply of a patch that writes a protected path is blocked', () => {
    assertBlocked(shell('git apply protected.patch', REPO, config));
  });

  test('git apply of a patch that renames onto a protected path is blocked', () => {
    assertBlocked(shell('git apply rename.patch', REPO, config));
  });

  test('git apply of an ordinary patch is allowed', () => {
    assertAllowed(shell('git apply ordinary.patch', REPO, config));
  });
});

describe('an MCP file tool write is judged against the worktree', () => {
  const REPO = tempRepo('paths-mcp-');
  const config = resolveConfig(undefined).config;

  test('a write tool to a protected path is blocked', () => {
    assertBlocked(mcp('mcp__filesystem__write_file', { path: path.join(REPO, '.claude/settings.json'), content: '{}' }, config));
  });

  test('a write tool to an ordinary path is allowed', () => {
    assertAllowed(mcp('mcp__filesystem__write_file', { path: path.join(REPO, 'src/app.ts'), content: 'x' }, config));
  });

  test('a read tool to a protected path is allowed', () => {
    assertAllowed(mcp('mcp__filesystem__read_file', { path: path.join(REPO, '.claude/settings.json') }, config));
  });
});
