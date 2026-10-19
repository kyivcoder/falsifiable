// ship-stage, build: one builder per lane, and every lane report is checked.
// Run: node --test test/workflows/ship-build.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONFIG, GOOD_REPORTS, PLAN, configWith, gateRun, lane, load, planWith, redGreenTest, report, runBrief } from './fixtures.mjs';

const SHIP = load('ship-stage');
const ARGS = { id: 'demo', stage: 'build', base: 'change/demo', plan: PLAN, config: CONFIG };
const build = (agents = GOOD_REPORTS, args = {}) => runBrief(SHIP, { args: { ...ARGS, ...args }, agents });
const evidence = (brief) => brief.evidence.join('\n');
const BILLING = planWith({ lanes: [...PLAN.lanes, lane('billing', ['api/src/billing/**'])] });
const MERGE_NOTE = 'On change/demo, merge the lanes in plan order with the merge-lanes script of the plugin: merge-lanes.mjs demo api web. Then run the verify stage with these args.';

describe('ship-stage build', () => {
  test('runs one isolated builder per lane and hands the reports to verify', async () => {
    const { brief, calls } = await build();
    assert.equal(brief.status, 'built');
    assert.deepEqual(
      calls.map((c) => [c.label, c.opts.agentType, c.opts.isolation]),
      [['builder:api', 'falsifiable:builder', 'worktree'], ['builder:web', 'falsifiable:builder', 'worktree']],
    );
    assert.equal(brief.next.stage, 'verify');
    assert.deepEqual(brief.next.args.reports.map((r) => r.lane), ['api', 'web']);
    assert.equal(brief.next.args.round, 1);
    assert.equal(brief.next.args.config, undefined, 'the head adds the config to every run');
  });

  test("gives each builder its lane, branch, owned paths, scenarios and its config domain's proof, gate and escalation", async () => {
    const { calls } = await build();
    const prompt = calls[0].prompt;
    const parts = ['Lane: api', 'Base branch: change/demo', 'Lane branch: lane/demo/api', 'api/src/export/**', 'Export returns CSV [unit]', 'GET /export (owner api)',
      'Change folder (read it; never write it): openspec/changes/demo/', CONFIG.delivery.domains.api.proof, CONFIG.delivery.domains.api.gate, CONFIG.delivery.domains.api.escalate];
    for (const part of parts) assert.ok(prompt.includes(part), `the builder prompt lacks "${part}":\n${prompt}`);
    assert.ok(!prompt.includes('web/src/export'), 'a builder sees only its own lane');
  });

  test('a domain without an escalation rule gives its builder no escalation line', async () => {
    const plan = planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], domain: 'repo' }] });
    const { calls } = await build(GOOD_REPORTS, { plan });
    assert.match(calls[1].prompt, /Proof in the repo domain: the check suites/);
    assert.doesNotMatch(calls[1].prompt, /Ask the user first/);
  });

  test('a lane that writes outside its paths fails and the file is named', async () => {
    const stray = report('api', ['api/src/export/export.routes.mjs', 'api/src/app.mjs']);
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': stray });
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /api: changed api\/src\/app\.mjs, which the lane does not own/);
    assert.doesNotMatch(evidence(brief), /web:/);
    assert.deepEqual(brief.next.args.lanes, ['api']);
  });

  test('a new test whose red run exited 0 fails the lane and the test is named', async () => {
    const neverRed = report('api', ['api/src/export/x.mjs'], { newTests: [redGreenTest({ file: 'api/src/export/x.mjs', redExitCode: 0 })] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': neverRed });
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /new test returns csv \(api\/src\/export\/x\.mjs\) has no red run/);
  });

  test('a new test with an empty failure excerpt fails the lane', async () => {
    const noExcerpt = report('api', ['api/src/export/x.mjs'], { newTests: [redGreenTest({ file: 'api/src/export/x.mjs', redExcerpt: '  ' })] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': noExcerpt });
    assert.match(evidence(brief), /has no red run/);
  });

  test('a new test with an empty red command fails the lane', async () => {
    for (const redCommand of ['', ' \n ']) {
      const noCommand = report('api', ['api/src/export/x.mjs'], { newTests: [redGreenTest({ file: 'api/src/export/x.mjs', redCommand })] });
      const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': noCommand });
      assert.equal(brief.status, 'blocked');
      assert.match(evidence(brief), /api: new test returns csv .* has no red run/);
    }
  });

  test('a test that never turned green, or a failing check, fails the lane', async () => {
    const stillRed = report('api', ['api/src/export/x.mjs'], { newTests: [redGreenTest({ file: 'api/src/export/x.mjs', greenExitCode: 1 })] });
    const badCheck = report('web', ['web/src/export/a.jsx'], { checks: [{ command: 'npm run lint', exitCode: 2, expect: 'pass' }] });
    const { brief } = await build({ 'builder:api': stillRed, 'builder:web': badCheck });
    assert.match(evidence(brief), /api: new test returns csv .* does not pass: exit code 1/);
    assert.match(evidence(brief), /web: check `npm run lint` exited 2/);
  });

  test('a red run and a caught mutant, both expected to fail, do not fail the lane', async () => {
    const testFirst = report('api', ['api/src/export/x.mjs'], { checks: [
      { command: 'node --test api/src/export/x.test.mjs (red, before code)', exitCode: 1, expect: 'fail' },
      { command: 'MUTANT csv header dropped: node --test api/src/export/x.test.mjs', exitCode: 1, expect: 'fail' },
      gateRun('api'),
    ] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': testFirst });
    assert.equal(brief.status, 'built');
    assert.deepEqual(brief.next.args.reports.map((r) => r.lane), ['api', 'web']);
  });

  test('a check expected to fail that exits 0, a surviving mutant, fails the lane', async () => {
    const survivor = report('api', ['api/src/export/x.mjs'], { checks: [
      { command: 'MUTANT csv header dropped: node --test api/src/export/x.test.mjs', exitCode: 0, expect: 'fail' },
      gateRun('api'),
    ] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': survivor });
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /api: check `MUTANT csv header dropped: node --test api\/src\/export\/x\.test\.mjs` was expected to fail but exited 0/);
  });

  test('a done lane without a passing run of its domain gate fails, whatever its summary says', async () => {
    const gate = CONFIG.delivery.domains.api.gate;
    const cases = {
      'no checks at all': { checks: [], summary: 'Not run: the gate because the tool is missing' },
      'another check only': { checks: [{ command: 'node --test api/src/export/x.test.mjs', exitCode: 0, expect: 'pass' }] },
      'the gate failing': { checks: [gateRun('api', { exitCode: 1 })] },
      'the gate as a red run': { checks: [gateRun('api', { exitCode: 1, expect: 'fail' })] },
    };
    for (const [what, extra] of Object.entries(cases)) {
      const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': report('api', ['api/src/export/x.mjs'], extra) });
      assert.equal(brief.status, 'blocked', what);
      assert.ok(brief.evidence.includes(`api: no passing run of the gate ${gate}`), `${what}:\n${evidence(brief)}`);
    }
  });

  test('the gate run may carry extra arguments and spacing, as long as it runs the gate', async () => {
    const gate = CONFIG.delivery.domains.api.gate;
    const run = gateRun('api', { command: `  ${gate.replace(/ /g, '  ')} -- --test-name-pattern export ` });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': report('api', ['api/src/export/x.mjs'], { checks: [run] }) });
    assert.equal(brief.status, 'built', evidence(brief));
  });

  test('the gate is matched on whole words, so another command that ends in the same letters is not a run of it', async () => {
    const gate = CONFIG.delivery.domains.api.gate;
    const lookalike = gateRun('api', { command: `p${gate}` });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': report('api', ['api/src/export/x.mjs'], { checks: [lookalike] }) });
    assert.ok(brief.evidence.includes(`api: no passing run of the gate ${gate}`), evidence(brief));
  });

  const gate = CONFIG.delivery.domains.api.gate;
  const gateIs = async (command) => {
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': report('api', ['api/src/export/x.mjs'], { checks: [gateRun('api', { command })] }) });
    return !brief.evidence.includes(`api: no passing run of the gate ${gate}`);
  };

  for (const command of [`cd api && ${gate}`, `CI=1 FORCE_COLOR=0 ${gate} -- --grep csv`, `cd api && CI=1 ${gate}`, `npm run build && ${gate}`, `${gate} 2>&1 | tail -5`, `${gate}; echo done`]) {
    test(`the gate starts a simple command of ${JSON.stringify(command)}, so it is a run of it`, async () => {
      assert.equal(await gateIs(command), true);
    });
  }

  for (const command of [`echo ${gate}`, `echo '${gate}'`, `git commit -m "${gate}"`, `echo 'x; ${gate}'`, `npx ${gate}`, `time ${gate}`, `CI=1`]) {
    test(`the gate words inside ${JSON.stringify(command)} start no simple command, so it is not a run of it`, async () => {
      assert.equal(await gateIs(command), false);
    });
  }

  test('the builder is told to run the gate and list that run in its checks', async () => {
    const { calls } = await build();
    assert.ok(calls[0].prompt.includes(`Gate (run it, and list that run in checks; a lane without a passing gate run fails): ${CONFIG.delivery.domains.api.gate}`), calls[0].prompt);
  });

  test('a lane that writes a file in a sensitive area its decision did not cover fails, naming the area', async () => {
    const config = configWith({ delivery: { sensitivePaths: { migrations: ['**/*.sql'] } } });
    const plan = planWith({ lanes: [...PLAN.lanes, lane('db', ['db/**'], { domain: 'repo' })] });
    const sneaky = report('db', ['db/notes.mjs', 'db/001-tags.sql'], { checks: [{ command: 'npm run check', exitCode: 0, expect: 'pass' }] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:db': sneaky }, { plan, config });
    assert.equal(brief.status, 'blocked');
    assert.ok(brief.evidence.includes('db: changed db/001-tags.sql, which is in the sensitive area migrations that its decision did not cover'), evidence(brief));
    const guarded = report('db', ['db/.mcp.json'], { checks: [{ command: 'npm run check', exitCode: 0, expect: 'pass' }] });
    const again = await build({ ...GOOD_REPORTS, 'builder:db': guarded }, { plan, config });
    assert.match(evidence(again.brief), /db: changed db\/\.mcp\.json, which is in the sensitive area agent guardrails that its decision did not cover/);
  });

  test('a folder lane that was not asked about a sensitive folder at any depth fails when it writes inside one', async () => {
    const config = configWith({ delivery: { sensitivePaths: { billing: ['**/billing/**'] } } });
    const plan = planWith({ lanes: [...PLAN.lanes, lane('new', ['api/new/**'])] });
    const inside = report('new', ['api/new/billing/charge.mjs', 'api/new/notes.mjs']);
    const { brief, calls } = await build({ ...GOOD_REPORTS, 'builder:new': inside }, { plan, config });
    assert.ok(calls.some((c) => c.label === 'builder:new'), 'no decision was needed before the build');
    assert.equal(brief.status, 'blocked');
    assert.ok(brief.evidence.includes('new: changed api/new/billing/charge.mjs, which is in the sensitive area billing that its decision did not cover'), evidence(brief));
    const outside = await build({ ...GOOD_REPORTS, 'builder:new': report('new', ['api/new/notes.mjs']) }, { plan, config });
    assert.equal(outside.brief.status, 'built', evidence(outside.brief));
  });

  test('a changed file is matched as a path, never as a glob', async () => {
    const starry = report('api', ['api/src/export/x.mjs', '*/x.mjs']);
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': starry });
    assert.match(evidence(brief), /api: changed \*\/x\.mjs, which the lane does not own/);
  });

  test('a lane that serves a unit scenario must report a new test', async () => {
    const noTests = report('api', ['api/src/export/x.mjs'], { newTests: [] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': noTests });
    assert.match(evidence(brief), /api: it serves a unit scenario but reports no new test/);
  });

  test('a lane whose diff lists no file fails', async () => {
    const empty = report('web', [], { newTests: [] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:web': empty });
    assert.match(evidence(brief), /web: its diff output lists no changed files/);
  });

  test('a builder that is blocked, returns nothing or reports the wrong branch fails its lane', async () => {
    const blocked = report('api', [], { status: 'blocked', blockedReason: 'the lane needs a schema change' });
    const wrongBranch = report('web', ['web/src/export/a.jsx'], { branch: 'main' });
    const one = await build({ 'builder:api': blocked, 'builder:web': wrongBranch });
    assert.match(evidence(one.brief), /api: the builder is blocked: the lane needs a schema change/);
    assert.match(evidence(one.brief), /web: it reports branch main, not lane\/demo\/web/);
    const two = await build({ ...GOOD_REPORTS, 'builder:api': null });
    assert.match(evidence(two.brief), /api: the builder returned no report/);
  });

  test('a sensitive lane without a decision starts no builder', async () => {
    const { brief, calls } = await build(GOOD_REPORTS, { plan: BILLING });
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'lane:billing:billing');
    assert.equal(calls.length, 0);
  });

  test('the approving answer builds the sensitive lane, whatever its case and spacing, and its builder sees it', async () => {
    const agents = { ...GOOD_REPORTS, 'builder:billing': report('billing', ['api/src/billing/plan.mjs']) };
    for (const answer of ['Build as planned', '  build AS planned \n']) {
      const { brief, calls } = await build(agents, { plan: BILLING, decisions: [{ about: 'lane:billing:billing', answer }] });
      assert.equal(brief.status, 'built');
      assert.match(calls.find((c) => c.label === 'builder:billing').prompt, /Decision from the user: build as planned/i);
    }
  });

  test('any other answer sends the plan back to the planner and starts no builder', async () => {
    for (const answer of ['Send the plan back', 'Approved; keep the payment calls out of transactions', 'no']) {
      const { brief, calls } = await build(GOOD_REPORTS, { plan: BILLING, decisions: [{ about: 'lane:billing:billing', answer }] });
      assert.equal(calls.length, 0, `"${answer}" started a builder`);
      assert.equal(brief.status, 'blocked');
      assert.match(brief.headline, /billing/);
      assert.match(`${brief.headline} ${brief.next.note}`, /the plan goes back to the planner/);
      assert.ok(brief.evidence.some((line) => line.includes(answer.trim())), 'the brief quotes the answer');
      assert.equal(brief.next.stage, 'plan');
      assert.deepEqual(brief.next.args, { id: 'demo', base: 'change/demo', kind: 'feature', stage: 'plan' });
    }
  });

  test('an answered open question reaches every builder', async () => {
    const plan = planWith({ openQuestions: [{ id: 'format', question: 'CSV or TSV?', options: ['CSV', 'TSV'], recommendation: 'CSV', why: 'spreadsheets', priority: 1 }] });
    const { calls } = await build(GOOD_REPORTS, { plan, decisions: [{ about: 'question:format', answer: 'CSV' }] });
    for (const call of calls) assert.match(call.prompt, /Answer from the user to "CSV or TSV\?": CSV/);
  });

  test('re-checks the plan it is given and builds nothing from an altered one', async () => {
    const altered = planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], domain: 'api', owns: ['api/src/export/export.routes.mjs'] }] });
    const { brief, calls } = await build(GOOD_REPORTS, { plan: altered });
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /owned by lanes api and web/);
    assert.equal(calls.length, 0);
  });

  test('re-checks scenario proofs and domains in the plan it is given', async () => {
    const proof = await build(GOOD_REPORTS, { plan: planWith({ scenarios: [PLAN.scenarios[0], { ...PLAN.scenarios[1], proof: 'manual' }] }) });
    assert.equal(proof.brief.status, 'blocked');
    assert.match(evidence(proof.brief), /has no proof \(product, unit or review\)/);
    assert.equal(proof.calls.length, 0);
    const domain = await build(GOOD_REPORTS, { plan: planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], domain: 'docs' }] }) });
    assert.match(evidence(domain.brief), /lane web has an unknown domain "docs"/);
  });

  const fourLanes = ['a', 'b', 'c', 'd'].map((id, i) => lane(id, [`api/src/${id}/**`], { scenarios: i < 2 ? [PLAN.scenarios[i].name] : [] }));
  const fourReports = Object.fromEntries(fourLanes.map((l) => [`builder:${l.id}`, report(l.id, [`api/src/${l.id}/x.mjs`])]));

  test('runs at most delivery.limits.maxParallelBuilders builders at a time', async () => {
    const run = await build(fourReports, { plan: planWith({ lanes: fourLanes, contracts: [] }) });
    assert.equal(run.brief.status, 'built');
    assert.equal(run.calls.length, 4);
    assert.equal(run.maxConcurrent, 2);
    assert.equal(run.brief.cost.agents, 4);
    const one = await build(fourReports, { plan: planWith({ lanes: fourLanes, contracts: [] }), config: configWith({ delivery: { limits: { maxParallelBuilders: 1 } } }) });
    assert.equal(one.maxConcurrent, 1);
  });

  test('re-runs only the named lanes and keeps the earlier reports', async () => {
    const { brief, calls } = await build(GOOD_REPORTS, { lanes: ['api'], reports: [GOOD_REPORTS['builder:web']] });
    assert.deepEqual(calls.map((c) => c.label), ['builder:api']);
    assert.deepEqual(brief.next.args.reports.map((r) => r.lane), ['api', 'web']);
  });

  test('the merge instruction names every lane of the plan in plan order, for a full build and for a re-run of one lane', async () => {
    assert.equal((await build()).brief.next.note, MERGE_NOTE);
    const rerun = await build(GOOD_REPORTS, { lanes: ['web'], reports: [GOOD_REPORTS['builder:api']] });
    assert.deepEqual(rerun.calls.map((c) => c.label), ['builder:web']);
    assert.equal(rerun.brief.next.note, MERGE_NOTE);
  });

  test('the builder lists its changed files with rename detection off, so a moved file shows its old path', async () => {
    const { calls } = await build();
    assert.match(calls[0].prompt, /git diff --name-only --no-renames change\/demo\.\.\.HEAD/);
  });

  test('a lane whose diff shows a file moved out of a sensitive path fails on the old path', async () => {
    const moved = report('api', ['api/src/billing/plan.mjs', 'api/src/export/plan.mjs', 'api/src/export/export.test.mjs']);
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': moved });
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /api: changed api\/src\/billing\/plan\.mjs, which the lane does not own/);
  });

  test('a new test in a file the lane did not change fails the lane', async () => {
    const elsewhere = report('api', ['api/src/export/export.routes.mjs'], { newTests: [redGreenTest({ file: 'api/src/export/export.test.mjs' })] });
    const { brief } = await build({ ...GOOD_REPORTS, 'builder:api': elsewhere });
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /api: new test returns csv is in api\/src\/export\/export\.test\.mjs, which the lane's diff does not list/);
  });

  test('a lane in several sensitive areas needs one decision that names them all', async () => {
    const mixed = planWith({ lanes: [...PLAN.lanes, lane('core', ['api/src/billing/plan.mjs', 'api/src/auth/session.mjs'])] });
    const { brief, calls } = await build(GOOD_REPORTS, { plan: mixed });
    assert.equal(calls.length, 0);
    assert.equal(brief.decision.about, 'lane:core:authentication+billing');
    assert.match(brief.decision.question, /Lane core changes authentication and billing/);
  });

  test('an approval given before a re-plan added a sensitive area to the lane no longer counts', async () => {
    const replanned = planWith({ lanes: [...PLAN.lanes, lane('billing', ['api/src/billing/**', 'api/src/auth/session.mjs'])] });
    const { brief, calls } = await build(GOOD_REPORTS, { plan: replanned, decisions: [{ about: 'lane:billing:billing', answer: 'Build as planned' }] });
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'lane:billing:authentication+billing');
  });

  test('needs the base branch the lanes start from', async () => {
    const { brief, calls } = await build(GOOD_REPORTS, { base: undefined });
    assert.equal(brief.status, 'blocked');
    assert.match(brief.headline, /base/);
    assert.equal(calls.length, 0);
  });
});
