// Tests for scripts/merge-lanes.mjs against throwaway git repositories.
// Run: node --test test/merge-lanes.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/merge-lanes.mjs');
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Git sets GIT_DIR, GIT_INDEX_FILE and friends inside its own hooks. A throwaway repository must never
// inherit them, or its commands reach the repository the tests run from.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const isAncestor = (root, branch) => spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: root, env: GIT_ENV }).status === 0;

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A repository on the change branch `change/x` with one base commit. */
function makeRepo() {
  const root = tempDir('falsifiable-merge-lanes-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(path.join(root, 'shared.txt'), 'line one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'switch', '-q', '-c', 'change/x');
  return root;
}

/** Commits `files` on a new lane branch `lane/x/<lane>` cut from the change branch. */
function makeLane(root, lane, files) {
  git(root, 'switch', '-q', '-c', `lane/x/${lane}`, 'change/x');
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(root, file), content);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', `lane ${lane}`);
  git(root, 'switch', '-q', 'change/x');
}

const run = (root, ...argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env: GIT_ENV, encoding: 'utf8' });

describe('merge-lanes', () => {
  test('merges lane branches in the given order with merge commits and removes their worktrees', () => {
    const root = makeRepo();
    makeLane(root, 'api', { 'api.txt': 'api\n' });
    makeLane(root, 'web', { 'web.txt': 'web\n' });
    const worktree = path.join(tempDir('falsifiable-lane-wt-'), 'api');
    git(root, 'worktree', 'add', '-q', worktree, 'lane/x/api');

    const result = run(root, 'x', 'api', 'web');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(root, 'rev-parse', 'HEAD^2'), git(root, 'rev-parse', 'lane/x/web'), 'the last merge is the last lane');
    assert.equal(git(root, 'rev-parse', 'HEAD^1^2'), git(root, 'rev-parse', 'lane/x/api'), 'the merge before it is the first lane');
    assert.equal(git(root, 'log', '-1', '--format=%s'), 'Merge lane web of x');
    assert.equal(git(root, 'branch', '--show-current'), 'change/x');
    assert.equal(existsSync(worktree), false);
    assert.ok(git(root, 'branch', '--list', 'lane/x/api'), 'a merged lane keeps its branch for the next fix round');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^api: merged [0-9a-f]{7,} \(1 file\), worktree removed$/);
    assert.match(lines[1], /^web: merged [0-9a-f]{7,} \(1 file\), no worktree$/);
  });

  test('a merged lane whose worktree cannot be removed fails, names the path and merges no later lane', () => {
    const root = makeRepo();
    makeLane(root, 'api', { 'api.txt': 'api\n' });
    makeLane(root, 'web', { 'web.txt': 'web\n' });
    const worktree = path.join(tempDir('falsifiable-lane-wt-'), 'api');
    git(root, 'worktree', 'add', '-q', worktree, 'lane/x/api');
    writeFileSync(path.join(worktree, 'left-behind.txt'), 'uncommitted work\n');

    const result = run(root, 'x', 'api', 'web');

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`api: merged, but its worktree at ${realpathSync(worktree)} could not be removed`), result.stderr);
    assert.match(result.stderr, /remove it, or tell the user why it must stay/);
    assert.ok(isAncestor(root, 'lane/x/api'), 'the merge itself stands');
    assert.ok(!isAncestor(root, 'lane/x/web'));
    assert.ok(existsSync(path.join(worktree, 'left-behind.txt')), 'the uncommitted work is kept as it was');

    const again = run(root, 'x', 'api', 'web');
    assert.equal(again.status, 1, 'an already merged lane with a surviving worktree still fails');
    assert.match(again.stderr, /api: already merged, but its worktree at .* could not be removed/);
  });

  test('the order given is the order merged', () => {
    const root = makeRepo();
    makeLane(root, 'api', { 'api.txt': 'api\n' });
    makeLane(root, 'web', { 'web.txt': 'web\n' });
    assert.equal(run(root, 'x', 'web', 'api').status, 0);
    assert.equal(git(root, 'rev-parse', 'HEAD^2'), git(root, 'rev-parse', 'lane/x/api'));
    assert.equal(git(root, 'rev-parse', 'HEAD^1^2'), git(root, 'rev-parse', 'lane/x/web'));
  });

  test('stops at the first conflict, aborts that merge and names the lane and the files', () => {
    const root = makeRepo();
    makeLane(root, 'one', { 'shared.txt': 'one\n' });
    makeLane(root, 'two', { 'shared.txt': 'two\n' });
    makeLane(root, 'three', { 'three.txt': 'three\n' });

    const result = run(root, 'x', 'one', 'two', 'three');

    assert.equal(result.status, 1);
    assert.match(result.stdout, /^one: merged/m);
    assert.match(result.stderr, /two: conflict in shared\.txt; merge aborted/);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(existsSync(path.join(root, '.git', 'MERGE_HEAD')), false);
    assert.ok(isAncestor(root, 'lane/x/one'));
    assert.ok(!isAncestor(root, 'lane/x/two'));
    assert.ok(!isAncestor(root, 'lane/x/three'), 'a lane after the conflict is not merged');
  });

  test('fails for a lane whose branch does not exist', () => {
    const root = makeRepo();
    const result = run(root, 'x', 'ghost');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ghost: no branch lane\/x\/ghost/);
  });

  test('reports a lane that is already merged and moves on', () => {
    const root = makeRepo();
    makeLane(root, 'api', { 'api.txt': 'api\n' });
    assert.equal(run(root, 'x', 'api').status, 0);
    const head = git(root, 'rev-parse', 'HEAD');
    const again = run(root, 'x', 'api');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^api: already merged/m);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'no new merge commit');
  });

  test('refuses to start with uncommitted changes to tracked files, and merges nothing', () => {
    const root = makeRepo();
    makeLane(root, 'api', { 'api.txt': 'api\n' });
    writeFileSync(path.join(root, 'shared.txt'), 'dirty\n');
    const result = run(root, 'x', 'api');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uncommitted changes/);
    assert.ok(!isAncestor(root, 'lane/x/api'));
    assert.equal(git(root, 'status', '--porcelain'), 'M shared.txt', 'the uncommitted change is kept as it was');
  });

  test('an untracked file does not count as a dirty tree', () => {
    const root = makeRepo();
    makeLane(root, 'api', { 'api.txt': 'api\n' });
    writeFileSync(path.join(root, 'notes.txt'), 'scratch\n');
    assert.equal(run(root, 'x', 'api').status, 0);
  });

  test('prints usage without lanes, and for an id or lane that cannot name a branch', () => {
    const root = makeRepo();
    for (const argv of [['x'], [], ['--force', 'api'], ['x', '-q'], ['X', 'api'], ['x', 'a b']]) {
      const result = run(root, ...argv);
      assert.equal(result.status, 2, JSON.stringify(argv));
      assert.match(result.stderr, /usage: node scripts\/merge-lanes\.mjs <id> <lane>\.\.\./);
    }
  });
});
