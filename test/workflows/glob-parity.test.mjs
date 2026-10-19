// workflows/ship-stage.js carries copies of the lib/glob.mjs functions it
// needs, because a workflow script loads no modules. This test keeps each copy
// equal to the original on every pair of a broad table of patterns.
// Run: node --test test/workflows/glob-parity.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as glob from '../../lib/glob.mjs';
import { markedBlock, workflowSource } from './fixtures.mjs';

const PATTERNS = [
  '**', '*', 'src', 'src/', 'src/**', './src/**', 'src\\lib\\a.mjs', 'src/lib/a.mjs', 'src/a.mjs', 'src/b.mjs', 'src/*.mjs', 'src/*',
  'src/*/x', 'src/a*/x', 'src/**/x.mjs', 'src/?.mjs', 'src/a?c.mjs', 'src/**/**/z', 'lib/**', 'lib/a.mjs', 'AGENTS.md', '**/AGENTS.md',
  'docs/**', 'docs/AGENTS.md', '**/*.test.mjs', 'test/**/*.test.mjs', 'test/a.test.mjs', '.github/workflows/**', '.github/**',
  '.claude/settings.json', '.claude/*.json', '.mcp.json', '**/.mcp.json', 'web/tools/.mcp.json', 'a/b/c/d', 'a/**/d', 'a/*/*/d',
  'file.with.dots.mjs', 'file(x).mjs', 'name+plus.mjs', '$money/x', '[x]/y', '{a,b}/c', 'a|b/c', 'x^y/z', 'release/*', 'release/1.0',
  'main', 'Main', '**/billing/**', 'api/src/billing/**', 'api/new/**', '**/*.sql', 'db/001.sql',
];

const FUNCTIONS = ['segmentsOf', 'matches', 'matchesAtAnyDepth', 'contains', 'overlaps'];
const copy = new Function(`${markedBlock(workflowSource('ship-stage'), 'paths')}\nreturn { ${FUNCTIONS.join(', ')} }`)();

describe('the glob copies in ship-stage.js', () => {
  test('are one marked block in the workflow', () => {
    for (const name of FUNCTIONS) assert.equal(typeof copy[name], 'function', name);
  });

  test(`split every one of ${PATTERNS.length} patterns into the same segments as lib/glob.mjs`, () => {
    for (const pattern of PATTERNS) assert.deepEqual(copy.segmentsOf(pattern), glob.segmentsOf(pattern), pattern);
  });

  for (const name of FUNCTIONS.slice(1)) {
    test(`${name}() agrees with lib/glob.mjs on all ${PATTERNS.length ** 2} ordered pairs, and the table gives both answers`, () => {
      const disagreements = PATTERNS.flatMap((a) => PATTERNS.filter((b) => copy[name](a, b) !== glob[name](a, b)).map((b) => `${a} vs ${b}`));
      assert.deepEqual(disagreements, []);
      const answers = new Set(PATTERNS.flatMap((a) => PATTERNS.map((b) => glob[name](a, b))));
      assert.deepEqual([...answers].sort(), [false, true], `${name}: agreement on one answer only would be vacuous`);
    });
  }
});
