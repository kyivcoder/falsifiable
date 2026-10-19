// Path globs, one meaning everywhere: the guard's protected paths, the role
// fences, lane ownership and sensitive areas.
//
//   *    any characters inside one folder name
//   ?    one character inside one folder name
//   **   any number of folders, including none
//   a/   the whole folder a (the same as a/**)
//
// Paths and globs use forward slashes and are relative; a leading ./ is ignored.
// Workflow scripts cannot import modules, so workflows/ship-stage.js carries
// copies of the functions it needs; test/workflows/glob-parity.test.mjs keeps
// each copy equal to this file.

export const segmentsOf = (pattern) =>
  String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '/**').split('/').filter(Boolean);

const hasWildcard = (segment) => /[*?]/.test(segment);

const segmentRegExp = (segment) =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

function matchFrom(glob, path) {
  if (glob.length === 0) return path.length === 0;
  if (glob[0] === '**') return matchFrom(glob.slice(1), path) || (path.length > 0 && matchFrom(glob, path.slice(1)));
  return path.length > 0 && segmentRegExp(glob[0]).test(path[0]) && matchFrom(glob.slice(1), path.slice(1));
}

/** True when `path` matches `glob`. */
export const matches = (glob, path) => matchFrom(segmentsOf(glob), segmentsOf(path));

/**
 * True when `glob` matches `path` or any tail of it that starts at a folder
 * boundary, so `.mcp.json` also protects `packages/x/.mcp.json`. The guard
 * gives it a path relative to the root of the git worktree that holds the
 * target, or the absolute path for a target outside every worktree.
 */
export function matchesAtAnyDepth(glob, path) {
  const target = segmentsOf(path);
  const pattern = segmentsOf(glob);
  for (let start = 0; start < target.length; start += 1) {
    if (matchFrom(pattern, target.slice(start))) return true;
  }
  return false;
}

function containsFrom(outer, inner) {
  if (inner.length === 0) return outer.every((s) => s === '**');
  if (outer.length === 0) return false;
  if (outer[0] === '**') return containsFrom(outer.slice(1), inner) || containsFrom(outer, inner.slice(1));
  if (inner[0] === '**') return false;
  const fits = hasWildcard(inner[0]) ? outer[0] === '*' || outer[0] === inner[0] : segmentRegExp(outer[0]).test(inner[0]);
  return fits && containsFrom(outer.slice(1), inner.slice(1));
}

/**
 * True when every path `inner` can match also matches `outer`: a lane's owned
 * path inside its domain. Conservative: a wildcard in `inner` is contained
 * only by `*` or the same wildcard.
 */
export const contains = (outer, inner) => containsFrom(segmentsOf(outer), segmentsOf(inner));

function segmentsMeet(a, b) {
  if (!hasWildcard(a) && !hasWildcard(b)) return a === b;
  if (!hasWildcard(a)) return segmentRegExp(b).test(a);
  if (!hasWildcard(b)) return segmentRegExp(a).test(b);
  return true; // two wildcards in one folder name: assume some name matches both
}

function overlapFrom(a, b) {
  if (a.length === 0 && b.length === 0) return true;
  if (a[0] === '**') return overlapFrom(a.slice(1), b) || (b.length > 0 && overlapFrom(a, b.slice(1)));
  if (b[0] === '**') return overlapFrom(a, b.slice(1)) || (a.length > 0 && overlapFrom(a.slice(1), b));
  return a.length > 0 && b.length > 0 && segmentsMeet(a[0], b[0]) && overlapFrom(a.slice(1), b.slice(1));
}

/** True when some file could match both patterns; a plain path matches only itself. */
export const overlaps = (a, b) => overlapFrom(segmentsOf(a), segmentsOf(b));
