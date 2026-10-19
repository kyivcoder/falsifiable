#!/usr/bin/env node
//
// Proves the tests can fail: for each planted mutant, copy the repository to
// a temporary folder, break one invariant there, and run the tests that guard
// it. A mutant the tests do not catch survives, and the run fails.
//
//   node scripts/mutants.mjs [--root <dir>] [manifest.json...]
//
// Manifests default to test/mutants/*.json under the root. Each holds a list
// of {name, file, find, replace, tests}: `find` must occur exactly once in
// `file` (otherwise the mutant is stale, and the run fails), and `tests` are
// the test files to run against the broken copy. A control run of every named
// test file on an unbroken copy must pass first. The original files are never
// touched. Exit codes: 0 every mutant killed, 1 a survivor, a stale mutant or
// a red control run, 2 bad usage.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['.git', 'node_modules', '.verify', 'results']);
const USAGE = 'usage: node scripts/mutants.mjs [--root <dir>] [manifest.json...]';

function parseArgs(argv) {
  const args = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), manifests: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) args.root = path.resolve(argv[(i += 1)]);
    else if (argv[i].startsWith('-')) return null;
    else args.manifests.push(argv[i]);
  }
  return args;
}

/** Every mutant in the manifests, each tagged with the manifest it came from. */
function loadMutants(root, manifests) {
  const dir = path.join(root, 'test/mutants');
  const files = manifests.length ? manifests.map((m) => path.resolve(root, m))
    : existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f)) : [];
  return files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).map((m) => ({ ...m, manifest: path.relative(root, file) })));
}

/** A fresh copy of the repository without git, dependencies or run output. */
function copyOf(root) {
  const dir = mkdtempSync(path.join(tmpdir(), 'falsifiable-mutant-'));
  cpSync(root, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  return dir;
}

/** A test run in `dir`. NODE_TEST_CONTEXT is removed: inherited from a parent test run, it makes the child report to that parent and exit 0. */
function runTests(dir, tests) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8', env });
}

const countOf = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const mutants = loadMutants(args.root, args.manifests);
  if (mutants.length === 0) {
    process.stdout.write('no mutants found\n');
    return 1;
  }
  const allTests = [...new Set(mutants.flatMap((m) => m.tests))];
  const control = copyOf(args.root);
  try {
    const result = runTests(control, allTests);
    if (result.status !== 0) {
      process.stdout.write(`control run failed: the unbroken tests are red, so no mutant result would mean anything\n${result.stdout.slice(-2000)}\n`);
      return 1;
    }
  } finally {
    rmSync(control, { recursive: true, force: true });
  }

  let killed = 0;
  for (const m of mutants) {
    const dir = copyOf(args.root);
    try {
      const file = path.join(dir, m.file);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const count = countOf(text, m.find);
      if (count !== 1) {
        process.stdout.write(`STALE     ${m.name}: found ${count} times in ${m.file} (${m.manifest})\n`);
        continue;
      }
      writeFileSync(file, text.replace(m.find, () => m.replace));
      const result = runTests(dir, m.tests);
      if (result.status === 0) process.stdout.write(`SURVIVED  ${m.name} (${m.manifest})\n`);
      else {
        killed += 1;
        process.stdout.write(`killed    ${m.name}\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${killed} of ${mutants.length} mutants killed\n`);
  return killed === mutants.length ? 0 : 1;
}

process.exitCode = main();
