// ship-stage takes everything about the project from args.config, and refuses
// to run without it. Run: node --test test/workflows/ship-config.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONFIG, PLAN, load, runBrief } from './fixtures.mjs';

const SHIP = load('ship-stage');
const ARGS = { id: 'demo', stage: 'plan', base: 'change/demo', config: CONFIG };
const run = (args) => runBrief(SHIP, { args, agents: { planner: PLAN } });

/** A copy of the fixture config with the value at the dotted `key` replaced, or removed when `value` is undefined. */
function configWithout(key, value) {
  const config = structuredClone(CONFIG);
  const parts = key.split('.');
  const parent = parts.slice(0, -1).reduce((node, part) => node[part], config);
  if (value === undefined) delete parent[parts.at(-1)];
  else parent[parts.at(-1)] = value;
  return config;
}

describe('ship-stage config', () => {
  test('without args.config it starts no agent and tells the head to run the ship skill', async () => {
    const { brief, calls } = await run({ ...ARGS, config: undefined });
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'blocked');
    assert.match(brief.headline, /config/);
    assert.match(brief.next.note, /\/falsifiable:ship/);
    assert.match(brief.next.note, /scripts\/config\.mjs/);
  });

  for (const key of [
    'delivery.specsDir', 'delivery.baseBranch', 'delivery.domains', 'delivery.sensitivePaths', 'delivery.limits.maxLanes',
    'delivery.limits.maxParallelBuilders', 'delivery.limits.maxFixRounds', 'delivery.limits.maxAgentsPerRun', 'delivery.limits.maxScouts',
    'guard.protectedPaths', 'guard.protectedBranches', 'guard.unlockEnv', 'verify.baseUrl', 'verify.health', 'verify.credentialEnv',
    'verify.instruments', 'verify.sweep', 'verify.readPaths', 'verify.commands', 'verify.mcpServers', 'review.checklist', 'review.secondOpinion',
  ]) {
    test(`a config without ${key} is refused, naming the key`, async () => {
      const { brief, calls } = await run({ ...ARGS, config: configWithout(key) });
      assert.equal(calls.length, 0);
      assert.equal(brief.status, 'blocked');
      assert.ok(brief.evidence.some((line) => line.startsWith(`${key}:`)), brief.evidence.join('\n'));
    });
  }

  test('a key of the wrong type is refused', async () => {
    const { brief } = await run({ ...ARGS, config: configWithout('delivery.limits.maxLanes', '4') });
    assert.deepEqual(brief.evidence, ['delivery.limits.maxLanes: expected an integer']);
  });

  test('a domain without owns, proof or gate is refused', async () => {
    const config = configWithout('delivery.domains.web', { owns: ['web/**'], proof: 'component tests' });
    const { brief } = await run({ ...ARGS, config });
    assert.deepEqual(brief.evidence, ['delivery.domains.web: needs owns (a list of globs), proof and gate']);
  });

  test('an empty domain set and a sensitive area that is not a list are refused', async () => {
    assert.deepEqual((await run({ ...ARGS, config: configWithout('delivery.domains', {}) })).brief.evidence, ['delivery.domains: needs at least one domain']);
    const area = configWithout('delivery.sensitivePaths.billing', 'api/src/billing/**');
    assert.deepEqual((await run({ ...ARGS, config: area })).brief.evidence, ['delivery.sensitivePaths.billing: expected a list of globs']);
  });

  for (const key of ['maxLanes', 'maxParallelBuilders']) {
    test(`delivery.limits.${key} of 0 is refused, because no lane could build`, async () => {
      const { brief, calls } = await run({ ...ARGS, config: configWithout(`delivery.limits.${key}`, 0) });
      assert.equal(calls.length, 0);
      assert.deepEqual(brief.evidence, [`delivery.limits.${key}: must be at least 1`]);
    });
  }

  test('an agent budget below two is refused, because verify starts the verifier and the reviewer together', async () => {
    const { brief } = await run({ ...ARGS, config: configWithout('delivery.limits.maxAgentsPerRun', 1) });
    assert.match(brief.evidence.join('\n'), /maxAgentsPerRun: ship needs at least 2/);
  });

  test('accepts the config as a JSON string, as the head may paste the script output', async () => {
    const { brief } = await run({ ...ARGS, config: JSON.stringify(CONFIG) });
    assert.equal(brief.status, 'planned');
  });

  test('a config that is not JSON is refused', async () => {
    const { brief, calls } = await run({ ...ARGS, config: '{not json' });
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'blocked');
  });

  for (const base of ['main', 'master']) {
    test(`refuses ${base} as the change branch, because merging lanes there would change a protected branch`, async () => {
      const { brief, calls } = await run({ ...ARGS, stage: 'build', base, plan: PLAN });
      assert.equal(calls.length, 0);
      assert.equal(brief.status, 'blocked');
      assert.match(brief.headline, /change branch/);
    });
  }

  test('the base branch of the config is never a change branch either', async () => {
    const config = configWithout('delivery.baseBranch', 'trunk');
    const { brief } = await run({ ...ARGS, stage: 'build', base: 'trunk', plan: PLAN, config });
    assert.match(brief.headline, /change branch/);
  });

  test('a protected branch written as a glob protects every branch it matches, in any letter case', async () => {
    const config = configWithout('guard.protectedBranches', ['main', 'release/*']);
    for (const base of ['release/1.0', 'Release/2.0', 'MAIN']) {
      const { brief, calls } = await run({ ...ARGS, stage: 'build', base, plan: PLAN, config });
      assert.equal(calls.length, 0, base);
      assert.ok(brief.headline.startsWith(`base ${base} is a protected branch`), brief.headline);
    }
    const change = await run({ ...ARGS, base: 'release-notes/x', config });
    assert.equal(change.brief.status, 'planned', 'release/* matches one folder level, not a prefix');
  });

  for (const [key, value] of [['verify.readPaths', 'e2e/**'], ['verify.commands', ['npx playwright test']], ['verify.mcpServers', 'chrome']]) {
    test(`${key} of the wrong shape is refused`, async () => {
      const { brief, calls } = await run({ ...ARGS, config: configWithout(key, value) });
      assert.equal(calls.length, 0);
      assert.ok(brief.evidence.some((line) => line.startsWith(`${key}:`)), brief.evidence.join('\n'));
    });
  }
});
