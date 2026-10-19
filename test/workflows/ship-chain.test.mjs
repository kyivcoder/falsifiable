// ship-stage end to end: each run is fed exactly the previous brief's next.args
// plus the config, as the ship skill does, and the user's answer where a brief
// asks for one. Run: node --test test/workflows/ship-chain.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONFIG, GOOD_REPORTS, PLAN, PRODUCT, cleanFindings, lane, load, planWith, report, runBrief } from './fixtures.mjs';

const SHIP = load('ship-stage');
const PLAN_WITH_BILLING = planWith({ lanes: [...PLAN.lanes, lane('billing', ['api/src/billing/**'])] });
const BUILDERS = { ...GOOD_REPORTS, 'builder:billing': report('billing', ['api/src/billing/plan.mjs']) };
const STILL_FAILING = {
  overall: 'FAIL',
  scenarios: [{ scenario: PRODUCT, result: 'FAIL', evidence: ['.verify/demo/export.png'], expected: 'a CSV download', actual: 'a 404 page', steps: ['press Export'] }],
  regressions: [],
};
const VERIFY_AGENTS = { verifier: STILL_FAILING, reviewer: cleanFindings() };

describe('ship-stage, stage by stage', () => {
  test('decisions and the fix round survive every hand-off, and the round after the last one asks the user', async () => {
    const run = async (args, agents = {}) => (await runBrief(SHIP, { args: { ...args, config: CONFIG }, agents })).brief;

    const planned = await run({ id: 'demo', stage: 'plan', base: 'change/demo' }, { planner: PLAN_WITH_BILLING });
    assert.equal(planned.status, 'needs-decision');
    assert.equal(planned.next.stage, 'build');
    const approval = [{ about: planned.decision.about, answer: 'Build as planned' }];

    const built = await run({ ...planned.next.args, decisions: approval }, BUILDERS);
    assert.equal(built.status, 'built');
    assert.deepEqual([built.next.stage, built.next.args.round, built.next.args.decisions], ['verify', 1, approval]);

    let verified = await run(built.next.args, VERIFY_AGENTS);
    for (const round of [1, 2]) {
      assert.equal(verified.status, 'needs-fix');
      assert.deepEqual([verified.next.stage, verified.next.args.round, verified.next.args.decisions], ['fix', round, approval]);
      const fixed = await run(verified.next.args, { 'builder:web': GOOD_REPORTS['builder:web'] });
      assert.equal(fixed.status, 'built', `fix round ${round} stopped: ${fixed.headline}`);
      assert.deepEqual([fixed.next.stage, fixed.next.args.round, fixed.next.args.decisions], ['verify', round + 1, approval]);
      verified = await run(fixed.next.args, VERIFY_AGENTS);
    }

    assert.equal(verified.next.args.round, 3);
    const third = await runBrief(SHIP, { args: { ...verified.next.args, config: CONFIG }, agents: {} });
    assert.equal(third.calls.length, 0);
    assert.equal(third.brief.status, 'needs-decision');
    assert.equal(third.brief.decision.about, 'fix-rounds');
  });

  test('no brief carries the config back: the head adds it to every run', async () => {
    const planned = (await runBrief(SHIP, { args: { id: 'demo', stage: 'plan', base: 'change/demo', config: CONFIG }, agents: { planner: PLAN } })).brief;
    assert.equal(planned.next.args.config, undefined);
    const withoutConfig = await runBrief(SHIP, { args: planned.next.args, agents: GOOD_REPORTS });
    assert.equal(withoutConfig.calls.length, 0);
    assert.equal(withoutConfig.brief.status, 'blocked');
  });
});
