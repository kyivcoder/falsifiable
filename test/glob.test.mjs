import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { contains, matches, matchesAtAnyDepth, overlaps } from '../lib/glob.mjs';

describe('matches', () => {
  const cases = [
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/deep/a.ts', true],
    ['src/**', 'src', true],
    ['src/**', 'srcs/a.ts', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false],
    ['src/', 'src/deep/a.ts', true],
    ['./src/a.ts', 'src/a.ts', true],
    ['**/AGENTS.md', 'AGENTS.md', true],
    ['**/AGENTS.md', 'apps/api/AGENTS.md', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['file.ts', 'file.ts', true],
    ['file.ts', 'filexts', false],
  ];
  for (const [glob, path, expected] of cases) {
    test(`${glob} ${expected ? 'matches' : 'does not match'} ${path}`, () => assert.equal(matches(glob, path), expected));
  }
});

describe('matchesAtAnyDepth', () => {
  test('matches a protected file inside an absolute path', () => {
    assert.equal(matchesAtAnyDepth('.mcp.json', '/home/me/project/.mcp.json'), true);
    assert.equal(matchesAtAnyDepth('.github/workflows/**', '/home/me/project/.claude/worktrees/x/.github/workflows/ci.yml'), true);
  });
  test('needs a folder boundary', () => {
    assert.equal(matchesAtAnyDepth('.mcp.json', '/home/me/project/x.mcp.json'), false);
    assert.equal(matchesAtAnyDepth('.claude/settings.json', '/p/not.claude/settings.json'), false);
  });
});

describe('contains', () => {
  const cases = [
    ['apps/api/**', 'apps/api/src/x.ts', true],
    ['apps/api/**', 'apps/api/src/**', true],
    ['apps/api/**', 'apps/*/src/**', false],
    ['apps/api/**', 'apps/web/x.ts', false],
    ['**', 'anything/**', true],
    ['**', '**', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/*.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/*', 'src/?', true],
    ['src/a?', 'src/*', false],
    ['src/**', 'src', true],
    ['src/x.ts', 'src/**', false],
    ['**/AGENTS.md', 'docs/AGENTS.md', true],
    ['**/AGENTS.md', 'docs/**', false],
  ];
  for (const [outer, inner, expected] of cases) {
    test(`${outer} ${expected ? 'contains' : 'does not contain'} ${inner}`, () => assert.equal(contains(outer, inner), expected));
  }
});

describe('overlaps', () => {
  const cases = [
    ['src/**', 'src/a.ts', true],
    ['src/**', 'lib/**', false],
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/x/a.ts', false],
    ['**', 'anything/at/all', true],
    ['src/*/x', 'src/*/y', false],
    ['src/*/x', 'src/a*/x', true],
    ['**/AGENTS.md', 'docs/**', true],
  ];
  for (const [a, b, expected] of cases) {
    test(`${a} and ${b} ${expected ? 'overlap' : 'do not overlap'}`, () => {
      assert.equal(overlaps(a, b), expected);
      assert.equal(overlaps(b, a), expected, 'overlap is symmetric');
    });
  }
});
