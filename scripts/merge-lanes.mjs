#!/usr/bin/env node
//
// Merges the lane branches of a change into the current branch.
//
//   node scripts/merge-lanes.mjs <id> <lane>...
//
// The head runs this on the change branch after a ship build or fix stage.
// Each lane `lane/<id>/<lane>` is merged with --no-ff, in the order given (the
// plan's lane order), so every lane stays one reviewable merge commit. It stops
// at the first conflict: that merge is aborted, the lane and its conflicting
// files are named, and later lanes are left unmerged. A merged lane's worktree
// is removed; its branch is kept, because a fix round reuses it. A worktree that
// git will not remove (it holds uncommitted work) stops the run too: the next
// builder of that lane could not check its branch out.
//
// Prints one line per lane. Exit codes: 0 all merged, 1 a lane failed or the
// tree was dirty, 2 bad usage. Zero dependencies.
import { spawnSync } from 'node:child_process';

const USAGE = 'usage: node scripts/merge-lanes.mjs <id> <lane>...';
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/; // the same rule the ship workflow applies to change and lane ids

/** Runs git and returns whether it succeeded, with its trimmed output. */
function git(...argv) {
  const result = spawnSync('git', argv, { encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

/** Path of the worktree that has `branch` checked out, if any. */
function worktreeOf(branch) {
  const entries = git('worktree', 'list', '--porcelain').out.split('\n\n');
  const entry = entries.find((block) => block.split('\n').includes(`branch refs/heads/${branch}`));
  return entry?.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
}

/** Removes the worktree of a merged lane: {ok, note}, where ok is false when the worktree survives. */
function removeWorktree(branch) {
  const where = worktreeOf(branch);
  if (!where) return { ok: true, note: 'no worktree' };
  const removed = git('worktree', 'remove', where);
  if (removed.ok) return { ok: true, note: 'worktree removed' };
  return { ok: false, note: `its worktree at ${where} could not be removed (${removed.err.split('\n')[0]}); remove it, or tell the user why it must stay` };
}

/** Merges one lane branch; ok is false when it is missing, conflicts, or leaves its worktree behind. */
function mergeLane(id, lane) {
  const branch = `lane/${id}/${lane}`;
  if (!git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok) {
    return { ok: false, line: `${lane}: no branch ${branch}` };
  }
  if (git('merge-base', '--is-ancestor', branch, 'HEAD').ok) {
    const worktree = removeWorktree(branch);
    return { ok: worktree.ok, line: worktree.ok ? `${lane}: already merged, ${worktree.note}` : `${lane}: already merged, but ${worktree.note}` };
  }
  const files = git('diff', '--name-only', `HEAD...${branch}`).out.split('\n').filter(Boolean).length;
  const merged = git('merge', '--no-ff', '--no-edit', '-m', `Merge lane ${lane} of ${id}`, branch);
  if (!merged.ok) {
    const conflicts = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    git('merge', '--abort');
    const where = conflicts.length ? `conflict in ${conflicts.join(', ')}` : `merge failed (${merged.err.split('\n')[0]})`;
    return { ok: false, line: `${lane}: ${where}; merge aborted` };
  }
  const sha = git('rev-parse', '--short', 'HEAD').out;
  const worktree = removeWorktree(branch);
  if (!worktree.ok) return { ok: false, line: `${lane}: merged, but ${worktree.note}` };
  return { ok: true, line: `${lane}: merged ${sha} (${files} file${files === 1 ? '' : 's'}), ${worktree.note}` };
}

function main([id, ...lanes]) {
  if (!id || lanes.length === 0 || ![id, ...lanes].every((name) => SAFE_NAME.test(name))) {
    console.error(USAGE);
    return 2;
  }
  if (git('status', '--porcelain', '--untracked-files=no').out !== '') {
    console.error('merge-lanes: the current branch has uncommitted changes; commit them or set them aside first');
    return 1;
  }
  for (const lane of lanes) {
    const result = mergeLane(id, lane);
    if (!result.ok) {
      console.error(result.line);
      return 1;
    }
    console.log(result.line);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
