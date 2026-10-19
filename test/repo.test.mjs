// Repository hygiene: no dependencies, no imports outside Node's built-ins and
// the repo, and files small enough to read in one sitting.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_DIRS = ['lib', 'scripts', 'workflows', 'test'];
const MAX_LINES = 800;
const SKIP = new Set(['node_modules', 'fixtures', '.git']);

/** Every .mjs and .js file under `dirs` of `root`, relative to `root`. */
function codeFiles(root, dirs = CODE_DIRS) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(mjs|js)$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
}

/** Why the repository at `root` is not dependency-free; empty when it is. */
function dependencyProblems(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const problems = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .filter((key) => Object.keys(pkg[key] ?? {}).length > 0)
    .map((key) => `package.json has ${key}`);
  for (const file of codeFiles(root)) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const [, spec] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      if (!spec.startsWith('node:') && !spec.startsWith('.')) problems.push(`${file} imports ${spec}`);
    }
  }
  return problems;
}

/** Files under the code folders of `root` longer than MAX_LINES. */
function oversizedFiles(root) {
  return codeFiles(root)
    .map((file) => [file, readFileSync(path.join(root, file), 'utf8').split('\n').length])
    .filter(([, lines]) => lines > MAX_LINES)
    .map(([file, lines]) => `${file} has ${lines} lines`);
}

const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fakeRepo({ pkg = {}, files = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), 'falsifiable-repo-'));
  temps.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const dir of CODE_DIRS) mkdirSync(path.join(root, dir), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(root, file), text);
  return root;
}

describe('the repository', () => {
  test('has no dependencies and imports only node: built-ins and its own files', () => {
    assert.deepEqual(dependencyProblems(ROOT), []);
  });

  test(`keeps every code file under ${MAX_LINES} lines`, () => {
    assert.deepEqual(oversizedFiles(ROOT), []);
  });
});

describe('the checks themselves', () => {
  test('a dependency or a package import is reported', () => {
    const root = fakeRepo({ pkg: { devDependencies: { eslint: '9' } }, files: { 'lib/a.mjs': "import x from 'lodash';\nimport y from 'node:fs';\n" } });
    assert.deepEqual(dependencyProblems(root), ['package.json has devDependencies', path.join('lib', 'a.mjs') + ' imports lodash']);
  });

  test('a long file is reported', () => {
    const root = fakeRepo({ files: { 'scripts/long.mjs': 'x\n'.repeat(MAX_LINES + 1) } });
    assert.deepEqual(oversizedFiles(root), [`${path.join('scripts', 'long.mjs')} has ${MAX_LINES + 2} lines`]);
  });
});
