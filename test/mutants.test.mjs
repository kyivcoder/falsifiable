// scripts/mutants.mjs on a tiny project: one mutant its test kills, one that
// survives, one whose code moved away, and a broken control run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts/mutants.mjs');
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const ADD = 'export const add = (a, b) => a + b;\n';
const ADD_TEST = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../lib/add.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n";

function project(mutants, { addTest = ADD_TEST } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'falsifiable-mutants-'));
  temps.push(root);
  mkdirSync(path.join(root, 'lib'));
  mkdirSync(path.join(root, 'test/mutants'), { recursive: true });
  writeFileSync(path.join(root, 'lib/add.mjs'), ADD);
  writeFileSync(path.join(root, 'test/add.test.mjs'), addTest);
  writeFileSync(path.join(root, 'test/mutants/demo.json'), JSON.stringify(mutants));
  return root;
}

const run = (root) => spawnSync(process.execPath, [RUNNER, '--root', root], { encoding: 'utf8' });
const mutant = (name, find, replace) => ({ name, file: 'lib/add.mjs', find, replace, tests: ['test/add.test.mjs'] });

describe('scripts/mutants.mjs', () => {
  test('a mutant the tests catch is killed, and the run passes', () => {
    const result = run(project([mutant('adds becomes subtracts', 'a + b', 'a - b')]));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /killed\s+adds becomes subtracts/);
    assert.match(result.stdout, /1 of 1 mutants killed/);
  });

  test('a mutant the tests miss survives, and the run fails', () => {
    const weakTest = "import { test } from 'node:test';\nimport { add } from '../lib/add.mjs';\ntest('runs', () => { add(1, 1); });\n";
    const result = run(project([mutant('adds becomes subtracts', 'a + b', 'a - b')], { addTest: weakTest }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SURVIVED\s+adds becomes subtracts/);
  });

  test('a mutant whose code is not found exactly once is stale, and the run fails', () => {
    const result = run(project([mutant('the code moved', 'a * b', 'a / b')]));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STALE\s+the code moved: found 0 times/);
  });

  test('a control run that fails stops everything, since a red suite kills every mutant', () => {
    const red = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red', () => assert.fail('red'));\n";
    const result = run(project([mutant('adds becomes subtracts', 'a + b', 'a - b')], { addTest: red }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /control run failed/);
  });

  test('the original files are never changed', async () => {
    const root = project([mutant('adds becomes subtracts', 'a + b', 'a - b')]);
    run(root);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(path.join(root, 'lib/add.mjs'), 'utf8'), ADD);
  });
});
