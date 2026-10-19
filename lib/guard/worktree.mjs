// Where a path lives in git: the worktree that holds it, the repository that
// worktree belongs to, and where a write really lands once symlinks resolve.
// The role fences judge allow-lists with these, so an allowed folder is
// allowed in every worktree of the project's repository and nowhere else.
//
// Tests: node --test test/guard/fence.test.mjs
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** The root of the git worktree that holds `target`: the nearest folder at or above it with a .git file or folder. */
export function worktreeRoot(target) {
  for (let current = target; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

/**
 * The git folder every worktree of one repository shares. A main checkout's
 * .git is that folder; a linked worktree's .git file names its own git folder,
 * whose commondir file points back to the shared one.
 */
export function sharedGitDir(root) {
  const dotGit = path.join(root, '.git');
  if (statSync(dotGit).isDirectory()) return realpathSync(dotGit);
  const gitDir = path.resolve(root, /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1].trim() ?? dotGit);
  const commonDir = path.join(gitDir, 'commondir');
  return realpathSync(existsSync(commonDir) ? path.resolve(gitDir, readFileSync(commonDir, 'utf8').trim()) : gitDir);
}

const exists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where `file` really is: symlinks resolved in the file itself and in its
 * nearest existing folder. A broken symlink cannot be resolved and throws.
 */
export function realTarget(file) {
  for (let existing = file; ; existing = path.dirname(existing)) {
    if (exists(existing)) return path.join(realpathSync(existing), path.relative(existing, file));
    if (path.dirname(existing) === existing) return file;
  }
}

/** True when `child` is `parent` or inside it (both absolute). */
export function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
