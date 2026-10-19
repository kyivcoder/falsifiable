// Tests for the guard engine (lib/guard/engine.mjs) against the shared case
// table, plus the SQL and secret scanners it uses.
//
//   node --test test/guard/engine.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { resolveConfig } from '../../lib/config.mjs';
import { blockMessage, evaluate } from '../../lib/guard/engine.mjs';
import { findSecret } from '../../lib/guard/secrets.mjs';
import { isReadOnlySql } from '../../lib/guard/sql.mjs';
import { ALLOWED, BLOCKED, CONFIG_CASES, SECRETS } from './cases.mjs';

const DEFAULT = resolveConfig(undefined).config;
const withEnv = (request) => ({ env: {}, ...request });

/** The resolved config for a raw one; a case table with an invalid config is a broken test. */
function configOf(raw) {
  const { config, problems } = resolveConfig(raw);
  assert.deepEqual(problems, [], `the case config is invalid: ${problems.join('; ')}`);
  return config;
}

describe('evaluate() blocks', () => {
  for (const [name, request, rule] of BLOCKED) {
    test(`${name} -> ${rule}`, () => {
      const result = evaluate(withEnv(request), DEFAULT);
      assert.equal(result.allow, false, `expected a block for: ${JSON.stringify(request)}`);
      assert.equal(result.rule, rule, result.message);
      assert.match(result.message, new RegExp(`^falsifiable guard blocked: ${rule}: .+\\. .+\\.$`));
    });
  }
});

describe('evaluate() allows', () => {
  for (const [name, request] of ALLOWED) {
    test(name, () => {
      const result = evaluate(withEnv(request), DEFAULT);
      assert.deepEqual(result, { allow: true }, `unexpected block: ${result.message}`);
    });
  }
});

describe('evaluate() follows the config', () => {
  for (const [name, raw, request, rule] of CONFIG_CASES) {
    test(`${name} -> ${rule ?? 'allowed'}`, () => {
      const result = evaluate(withEnv(request), configOf(raw));
      if (rule === null) assert.deepEqual(result, { allow: true }, `unexpected block: ${result.message}`);
      else {
        assert.equal(result.allow, false, `expected a block for: ${JSON.stringify(request)}`);
        assert.equal(result.rule, rule, result.message);
      }
    });
  }

  test('without a config the defaults apply', () => {
    assert.equal(evaluate({ kind: 'bash', command: 'git push origin main', env: {} }).rule, 'git-push-protected');
  });

  test('a blockCommands entry reports its own why and instead', () => {
    const fly = { id: 'fly-deploy', argv: ['fly', 'deploy'], why: 'fly deploy ships to production', instead: 'Ask the user to deploy' };
    const result = evaluate({ kind: 'bash', command: 'fly deploy', env: {} }, configOf({ guard: { blockCommands: [fly] } }));
    assert.equal(result.message, 'falsifiable guard blocked: fly-deploy: fly deploy ships to production. Ask the user to deploy.');
  });

  test('a protected-path block names the configured unlock variable', () => {
    const request = { kind: 'edit', path: '/repo/.mcp.json', content: '{}', env: {} };
    assert.match(evaluate(request, DEFAULT).message, /FALSIFIABLE_UNLOCK=1/);
    assert.match(evaluate(request, configOf({ guard: { unlockEnv: 'MY_UNLOCK' } })).message, /MY_UNLOCK=1/);
  });

  test('a protected-branch block names the branch', () => {
    const result = evaluate({ kind: 'bash', command: 'git push origin trunk', env: {} }, configOf({ guard: { protectedBranches: ['trunk'] } }));
    assert.match(result.message, /trunk/);
  });
});

describe('evaluate() reads the branch where each command runs', () => {
  const BRANCHES = { '/repo': 'feat/x', '/repo/wt': 'main', '/repo/wt/.git': 'main', '/feat': 'feat/y' };
  const branchOf = ({ dir, gitDir }) => BRANCHES[gitDir ?? dir];
  const push = (command, lookup = branchOf) => evaluate({ kind: 'bash', command, cwd: '/repo', branchOf: lookup, env: {} }, DEFAULT);

  test('a bare push in the cwd uses the cwd branch', () => assert.deepEqual(push('git push'), { allow: true }));
  test('a bare push after cd into a worktree on main', () => assert.equal(push('cd wt && git push').rule, 'git-push-protected'));
  test('git -C into a worktree on main, pushing HEAD', () => assert.equal(push('git -C wt push origin HEAD').rule, 'git-push-protected'));
  test('git -C is cumulative', () => assert.equal(push('git -C / -C repo/wt push').rule, 'git-push-protected'));
  test('--git-dir names the repository', () => assert.equal(push('git --git-dir=wt/.git push').rule, 'git-push-protected'));
  test('GIT_DIR names the repository', () => assert.equal(push('GIT_DIR=/repo/wt/.git git push').rule, 'git-push-protected'));
  test('a feature branch in another folder passes', () => assert.deepEqual(push('git -C /feat push'), { allow: true }));
  test('a folder that is not a repository passes, because git refuses the push', () => assert.deepEqual(push('git -C /elsewhere push'), { allow: true }));
  test('a lookup that cannot tell counts as protected', () => assert.equal(push('git push', () => null).rule, 'git-push-protected'));
  test('a checkout in one folder does not move the branch of another', () => {
    assert.deepEqual(push('git -C wt checkout feat/z && git push'), { allow: true });
    assert.deepEqual(push('git -C wt checkout feat/z && git -C wt push'), { allow: true });
  });
  test('looks a branch up only for a push', () => {
    let calls = 0;
    const counting = (location) => {
      calls += 1;
      return branchOf(location);
    };
    push('git status && cd wt && git log --oneline', counting);
    assert.equal(calls, 0);
  });
});

describe('evaluate() reads a GraphQL body from a file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'falsifiable-gql-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'merge.graphql'), 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }');
  writeFileSync(path.join(dir, 'read.graphql'), 'query { viewer { login } }');
  writeFileSync(path.join(dir, 'automerge.json'), JSON.stringify({ query: 'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }' }));
  writeFileSync(path.join(dir, 'ruleset.json'), JSON.stringify({ query: 'mutation { createRepositoryRuleset(input: {}) { clientMutationId } }' }));
  const gh = (command, cwd = dir) => evaluate({ kind: 'bash', command, cwd, env: {} }, DEFAULT);

  test('a query field read from a file with a merge mutation', () => assert.equal(gh('gh api graphql -F query=@merge.graphql').rule, 'gh-merge'));
  test('an --input body with an auto-merge mutation', () => assert.equal(gh('gh api graphql --input automerge.json').rule, 'gh-merge'));
  test('an --input body with an admin mutation', () => assert.equal(gh('gh api graphql --input=ruleset.json').rule, 'gh-admin'));
  test('a body file found after cd', () => assert.equal(gh(`cd ${dir} && gh api graphql -F query=@merge.graphql`, '/').rule, 'gh-merge'));
  test('a read-only query from a file passes', () => assert.deepEqual(gh('gh api graphql -F query=@read.graphql'), { allow: true }));
  test('a relative body file the guard cannot find blocks', () => assert.equal(gh('gh api graphql -F query=@read.graphql', path.join(dir, 'nowhere')).rule, 'gh-merge'));
});

describe('blockMessage()', () => {
  test('joins rule, why and instead into one sentence each', () => {
    assert.equal(blockMessage('gh-merge', 'agents never merge', 'Leave the PR open.'), 'falsifiable guard blocked: gh-merge: agents never merge. Leave the PR open.');
  });
});

describe('evaluate() fails closed on malformed requests', () => {
  const cases = [
    ['no request', undefined],
    ['unknown kind', { kind: 'telepathy', env: {} }],
    ['bash without a command', { kind: 'bash', env: {} }],
    ['edit without a path', { kind: 'edit', content: 'x', env: {} }],
    ['mcp without a tool name', { kind: 'mcp', env: {} }],
  ];
  for (const [name, request] of cases) {
    test(name, () => {
      const result = evaluate(request, DEFAULT);
      assert.equal(result.allow, false);
      assert.equal(result.rule, 'malformed-input');
    });
  }
});

describe('evaluate() never echoes a secret back in its message', () => {
  test('names the secret type, not the value', () => {
    const result = evaluate(withEnv({ kind: 'edit', path: '/repo/a.ts', content: SECRETS.anthropic }), DEFAULT);
    assert.equal(result.allow, false);
    assert.ok(!result.message.includes(SECRETS.anthropic));
    assert.match(result.message, /Anthropic/);
  });
});

describe('evaluate() stays fast on pathological input', () => {
  const PATHOLOGICAL_LIMIT_MS = 1000;
  test('scans 300KB of unterminated Postgres URL fragments well under the hook timeout', () => {
    const started = Date.now();
    const result = evaluate(withEnv({ kind: 'edit', path: '/repo/a.txt', content: 'postgresql://x:'.repeat(20000) }), DEFAULT);
    assert.equal(result.allow, true);
    assert.ok(Date.now() - started < PATHOLOGICAL_LIMIT_MS, `took ${Date.now() - started}ms`);
  });
  test('parses a 2000-command line quickly', () => {
    const started = Date.now();
    const result = evaluate(withEnv({ kind: 'bash', command: Array(2000).fill('echo x').join(' && ') }), DEFAULT);
    assert.equal(result.allow, true);
    assert.ok(Date.now() - started < PATHOLOGICAL_LIMIT_MS, `took ${Date.now() - started}ms`);
  });
});

describe('isReadOnlySql()', () => {
  test('accepts dollar-quoted strings in a SELECT', () => assert.equal(isReadOnlySql('select $tag$ drop table t $tag$ as s'), true));
  test('accepts escaped quotes inside literals', () => assert.equal(isReadOnlySql(`select 'it''s; delete' as s`), true));
  test('accepts a parenthesised union', () => assert.equal(isReadOnlySql('(select 1) union (select 2)'), true));
  test('rejects non-string input', () => {
    assert.equal(isReadOnlySql(undefined), false);
    assert.equal(isReadOnlySql(42), false);
  });
});

describe('findSecret()', () => {
  test('returns null for ordinary code', () => assert.equal(findSecret('export const add = (a, b) => a + b;\n', '/repo/a.ts'), null));
  test('returns a label for a GitHub token', () => assert.match(findSecret(`t=${SECRETS.githubClassic}`, '/repo/x.sh').label, /GitHub/));
  test('treats only the given local hosts as local', () => {
    const url = SECRETS.pgRemoteUrl.replace('prod-db.internal.example.net', 'db.internal');
    assert.ok(findSecret(url, '/repo/a.env'));
    assert.equal(findSecret(url, '/repo/a.env', { localHosts: ['db.internal'] }), null);
  });
});
