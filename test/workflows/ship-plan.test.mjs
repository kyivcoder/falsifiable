// ship-stage, plan: the planner's plan is checked before any builder can start.
// Run: node --test test/workflows/ship-plan.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { matches } from '../../lib/glob.mjs';
import { CONFIG, PLAN, RAW_CONFIG, configFrom, configWith, lane, load, planWith, runBrief } from './fixtures.mjs';
import { runWorkflow } from './runtime.mjs';

const SHIP = load('ship-stage');
const ARGS = { id: 'demo', stage: 'plan', base: 'change/demo', config: CONFIG };
const plan = (planner, extra = {}) => runBrief(SHIP, { args: { ...ARGS, ...extra }, agents: { planner, ...extra.agents } });
const evidence = (brief) => brief.evidence.join('\n');
const [UNIT, PRODUCT] = PLAN.scenarios.map((s) => s.name);

/** A file inside each guard-protected glob: `.claude/hooks/**` gives `.claude/hooks/example.mjs`. */
const protectedSamples = (config) =>
  config.guard.protectedPaths.map((glob) => {
    const sample = glob.replace(/\*\*$/, 'example.mjs');
    assert.ok(matches(glob, sample), `${sample} is not inside ${glob}`);
    return sample;
  });

describe('ship-stage plan', () => {
  test('returns a planned brief whose next step is build with the same plan, and leaves the config for the head to add', async () => {
    const { brief, calls } = await plan(PLAN);
    assert.equal(brief.status, 'planned');
    assert.equal(brief.decision, undefined);
    assert.deepEqual(calls.map((c) => [c.label, c.opts.agentType]), [['planner', 'falsifiable:planner']]);
    assert.equal(brief.next.stage, 'build');
    assert.deepEqual(brief.next.args, { id: 'demo', stage: 'build', base: 'change/demo', kind: 'feature', plan: PLAN });
    assert.equal(brief.cost.agents, 1);
  });

  test('tells the planner where the change lives, what limits apply and how each config domain is proven', async () => {
    const { calls } = await plan(PLAN);
    const prompt = calls[0].prompt;
    for (const part of ['openspec/changes/demo/', 'openspec/changes/demo/tasks.md', '1 to 4 lanes']) assert.ok(prompt.includes(part), `the planner prompt lacks "${part}"`);
    for (const [name, domain] of Object.entries(CONFIG.delivery.domains)) {
      for (const part of [name, ...domain.owns, domain.proof, domain.gate]) assert.ok(prompt.includes(part), `the planner prompt lacks "${part}" of domain ${name}`);
    }
  });

  test('lists every sensitive area for the planner, the guard-protected paths among them', async () => {
    const { calls } = await plan(PLAN);
    const prompt = calls[0].prompt;
    assert.match(prompt, /- billing: api\/src\/billing\/\*\*/);
    assert.match(prompt, /- authentication: api\/src\/auth\/\*\*, web\/src\/sign-in\*/);
    for (const glob of CONFIG.guard.protectedPaths) assert.ok(prompt.includes(glob), `the planner is not told that ${glob} is sensitive`);
    assert.match(prompt, /agent guardrails/);
  });

  test('the change folder follows delivery.specsDir', async () => {
    const { brief, calls } = await plan(PLAN, { config: configWith({ delivery: { specsDir: 'docs/specs' } }) });
    assert.match(calls[0].prompt, /docs\/specs\/changes\/demo\/tasks\.md/);
    assert.doesNotMatch(calls[0].prompt, /openspec/);
    assert.match(brief.headline, /docs\/specs\/changes\/demo\/tasks\.md/);
  });

  test("the plan contract offers exactly the config's domains", async () => {
    const { calls } = await plan(PLAN);
    assert.deepEqual(calls[0].opts.schema.properties.lanes.items.properties.domain.enum, ['api', 'web', 'repo']);
    const docs = planWith({ lanes: [...PLAN.lanes, lane('guide', ['docs/guide.md'], { domain: 'docs' })] });
    await assert.rejects(runWorkflow(SHIP, { args: ARGS, agents: { planner: docs } }), /domain: must be one of "api", "web", "repo"/);
    const withDocs = configWith({ delivery: { domains: { docs: { owns: ['docs/**'], proof: 'a reader checks the page', gate: 'npm run docs' } } } });
    const { brief } = await plan(docs, { config: withDocs });
    assert.equal(brief.status, 'planned', evidence(brief));
  });

  test('rejects two lanes that own the same path, naming the path and both lanes, before any build', async () => {
    const overlapping = planWith({
      lanes: [lane('one', ['api/src/routes/foo.mjs'], { scenarios: [UNIT] }), lane('two', ['api/src/routes/foo.mjs'], { scenarios: [PRODUCT] })],
      contracts: [],
    });
    const { brief, calls } = await plan(overlapping);
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /api\/src\/routes\/foo\.mjs is owned by lanes one and two/);
    assert.equal(calls.length, 1);
    assert.equal(brief.next.stage, undefined);
  });

  test('treats a folder glob and a file inside it as overlapping', async () => {
    const overlapping = planWith({ lanes: [lane('one', ['api/**'], { scenarios: [UNIT] }), lane('two', ['api/src/x.mjs'], { scenarios: [PRODUCT] })], contracts: [] });
    const { brief } = await plan(overlapping);
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /api\/\*\* and api\/src\/x\.mjs are owned by lanes one and two/);
  });

  test('treats two wildcards that can name one file as overlapping', async () => {
    const overlapping = planWith({ lanes: [lane('one', ['api/src/*.mjs'], { scenarios: [UNIT] }), lane('two', ['api/src/export*'], { scenarios: [PRODUCT] })], contracts: [] });
    assert.match(evidence((await plan(overlapping)).brief), /api\/src\/\*\.mjs and api\/src\/export\* are owned by lanes one and two/);
  });

  test('a lane that owns a path outside its domain is blocked', async () => {
    const stray = planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], owns: ['api/src/button.mjs'] }], contracts: [] });
    const { brief } = await plan(stray);
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /lane web owns api\/src\/button\.mjs, which is not inside the web domain \(web\/\*\*\)/);
  });

  test('a glob that only partly lies in its domain is blocked too: owned paths must be contained, not just overlap', async () => {
    for (const owned of ['**', '*/src/**', 'api/**']) {
      const stray = planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], owns: [owned] }], contracts: [] });
      const { brief } = await plan(stray);
      assert.equal(brief.status, 'blocked', owned);
      assert.ok(brief.evidence.includes(`lane web owns ${owned}, which is not inside the web domain (web/**)`), brief.evidence.join('\n'));
    }
  });

  test('an owned path must be relative, inside the repository and written with forward slashes', async () => {
    for (const owned of ['web/../api/**', '../web/x.jsx', '/web/x.jsx', 'web\\x.jsx', 'web/./x.jsx', 'C:/web/x.jsx']) {
      const stray = planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], owns: [owned] }], contracts: [] });
      const { brief, calls } = await plan(stray);
      assert.equal(brief.status, 'blocked', owned);
      assert.equal(calls.length, 1);
      assert.ok(brief.evidence.includes(`lane web owns ${owned}, which is not a relative path inside the repository`), brief.evidence.join('\n'));
    }
  });

  test('a configured folder glob at any depth asks for a decision only from a lane whose own path names that folder', async () => {
    const config = configWith({ delivery: { sensitivePaths: { billing: ['**/billing/**'] } } });
    const lanes = [
      lane('bill', ['api/src/billing/**'], { scenarios: [UNIT] }), lane('deep', ['docs/**/billing/rates.md'], { domain: 'repo' }), lane('new', ['api/new/**']),
      lane('export', ['web/src/export/**'], { domain: 'web', scenarios: [PRODUCT] }),
    ];
    const { brief } = await plan(planWith({ lanes, contracts: [] }), { config });
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'lane:bill:billing');
    assert.match(evidence(brief), /Lane deep changes billing \(docs\/\*\*\/billing\/rates\.md\)/);
    assert.doesNotMatch(evidence(brief), /Lane new|Lane export/, 'a folder that could hold a billing folder is checked in its report, not asked about');
  });

  test('a configured glob anchored at the root asks for a decision from every lane that can contain a path in it', async () => {
    const { brief } = await plan(planWith({ lanes: [lane('api', ['api/**'], { scenarios: [UNIT, PRODUCT] })], contracts: [] }));
    assert.equal(brief.decision.about, 'lane:api:authentication+billing');
  });

  test('a file-name glob at any depth is sensitive when a lane names such a file, not when it owns a folder', async () => {
    const config = configWith({ delivery: { sensitivePaths: { migrations: ['**/*.sql'] } } });
    const folder = await plan(planWith({ lanes: [...PLAN.lanes, lane('db', ['db/**'], { domain: 'repo' })] }), { config });
    assert.equal(folder.brief.status, 'planned', evidence(folder.brief));
    const named = await plan(planWith({ lanes: [...PLAN.lanes, lane('db', ['db/001-tags.sql'], { domain: 'repo' })] }), { config });
    assert.equal(named.brief.decision.about, 'lane:db:migrations');
  });

  test('a lane in a config sensitive area waits for a decision that names the lane and the area', async () => {
    const billing = planWith({ lanes: [...PLAN.lanes, lane('billing', ['api/src/billing/plan-change.mjs'])] });
    const { brief } = await plan(billing);
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'lane:billing:billing');
    assert.match(brief.decision.question, /Lane billing changes billing \(api\/src\/billing\/plan-change\.mjs\)/);
    assert.deepEqual(brief.decision.options, ['Build as planned', 'Send the plan back']);
    assert.equal(brief.next.stage, 'build');
  });

  test('an area the config names is sensitive, and one it does not name is not', async () => {
    const pay = planWith({ lanes: [...PLAN.lanes, lane('pay', ['api/src/pay/charge.mjs'])] });
    assert.equal((await plan(pay)).brief.status, 'planned');
    const { brief } = await plan(pay, { config: configWith({ delivery: { sensitivePaths: { payments: ['api/src/pay/**'] } } }) });
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'lane:pay:payments');
  });

  test('an ordinary lane needs no decision', async () => {
    const ordinary = ['api/src/billing-report.mjs', 'api/src/authors/**', 'api/src/util/date.mjs', 'api/src/export/**'];
    const { brief } = await plan(planWith({ lanes: [lane('api', ordinary, { scenarios: [UNIT, PRODUCT] })], contracts: [] }));
    assert.equal(brief.status, 'planned', evidence(brief));
  });

  for (const sample of protectedSamples(CONFIG)) {
    test(`the guard-protected ${sample} is in the agent guardrails area, even with no sensitive paths configured`, async () => {
      const bare = configFrom({ delivery: { domains: RAW_CONFIG.delivery.domains } });
      const { brief } = await plan(planWith({ lanes: [...PLAN.lanes, lane('guard', [sample], { domain: 'repo' })] }), { config: bare });
      assert.equal(brief.status, 'needs-decision', `${sample} is not sensitive`);
      assert.equal(brief.decision.about, 'lane:guard:agent guardrails');
      assert.match(brief.decision.why, /FALSIFIABLE_UNLOCK=1/);
    });
  }

  test('a path the config adds to the guard is in the agent guardrails area', async () => {
    const config = configWith({ guard: { protectedPaths: ['infra/**'] } });
    const { brief } = await plan(planWith({ lanes: [...PLAN.lanes, lane('infra', ['infra/main.tf'], { domain: 'repo' })] }), { config });
    assert.equal(brief.decision.about, 'lane:infra:agent guardrails');
  });

  test('a guarded file is sensitive at any folder depth when a lane names it, not when a lane owns a folder that could hold one', async () => {
    const folder = await plan(planWith({ lanes: [...PLAN.lanes, lane('tools', ['web/tools/**'], { domain: 'web' })] }));
    assert.equal(folder.brief.status, 'planned', evidence(folder.brief));
    const named = await plan(planWith({ lanes: [...PLAN.lanes, lane('mcp', ['web/tools/.mcp.json'], { domain: 'web' })] }));
    assert.equal(named.brief.decision.about, 'lane:mcp:agent guardrails');
  });

  test('a lane that owns everything touches every area, in one decision that names them all', async () => {
    const { brief } = await plan(planWith({ lanes: [lane('all', ['**'], { domain: 'repo', scenarios: [UNIT, PRODUCT] })], contracts: [] }));
    assert.equal(brief.decision.about, 'lane:all:agent guardrails+authentication+billing');
    assert.match(brief.decision.question, /Lane all changes agent guardrails and authentication and billing/);
  });

  test('a run with two open questions carries the more important one and lists the other under next', async () => {
    const question = (id, priority) => ({ id, question: `Question ${id}?`, options: ['Yes', 'No'], recommendation: 'Yes', why: 'because', priority });
    const { brief } = await plan(planWith({ openQuestions: [question('later', 2), question('first', 1)] }));
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'question:first');
    assert.match(brief.next.note, /Question later\?/);
  });

  test('a scenario that no lane serves blocks the plan', async () => {
    const { brief } = await plan(planWith({ lanes: [PLAN.lanes[0]], contracts: [] }));
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /scenario "The export button downloads a file" is proven by product, but no lane serves it/);
  });

  test('a lane that serves a scenario the plan does not list blocks the plan', async () => {
    const extra = planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], scenarios: [PRODUCT, 'Something else'] }] });
    assert.match(evidence((await plan(extra)).brief), /lane web serves "Something else", which the plan's scenario map does not list/);
  });

  test('a contract owned by no lane blocks the plan', async () => {
    const orphan = planWith({ contracts: [{ name: 'GET /export', owner: 'nobody', detail: 'x' }] });
    assert.match(evidence((await plan(orphan)).brief), /contract GET \/export is owned by nobody, which is not a lane/);
  });

  const fiveLanes = ['a', 'b', 'c', 'd', 'e'].map((id, i) => lane(id, [`api/src/${id}.mjs`], { scenarios: i < 2 ? [[UNIT, PRODUCT][i]] : [] }));

  test('a plan with more lanes than delivery.limits.maxLanes is blocked', async () => {
    const { brief } = await plan(planWith({ lanes: fiveLanes, contracts: [] }));
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /1 to 4 lanes; this one has 5/);
    const two = await plan(planWith({ lanes: fiveLanes.slice(0, 3), contracts: [] }), { config: configWith({ delivery: { limits: { maxLanes: 2 } } }) });
    assert.match(evidence(two.brief), /1 to 2 lanes; this one has 3/);
  });

  test('the agent budget caps the lanes too, because a build starts one builder per lane', async () => {
    const config = configWith({ delivery: { limits: { maxLanes: 8, maxAgentsPerRun: 3 } } });
    const { brief, calls } = await plan(planWith({ lanes: fiveLanes.slice(0, 4), contracts: [] }), { config });
    assert.match(calls[0].prompt, /1 to 3 lanes/);
    assert.match(evidence(brief), /1 to 3 lanes; this one has 4/);
  });

  test('a lane id that cannot name a branch is blocked', async () => {
    const { brief } = await plan(planWith({ lanes: [PLAN.lanes[0], { ...PLAN.lanes[1], id: 'Web UI' }], contracts: [] }));
    assert.equal(brief.status, 'blocked');
    assert.match(evidence(brief), /cannot name a branch/);
  });

  test('kind fix: the first lane must start from a failing reproduction', async () => {
    const noRepro = await plan(PLAN, { kind: 'fix' });
    assert.equal(noRepro.brief.status, 'blocked');
    assert.match(evidence(noRepro.brief), /failing reproduction/);
    assert.match(noRepro.calls[0].prompt, /failing reproduction/);

    const withRepro = planWith({ lanes: [{ ...PLAN.lanes[0], reproduction: 'node --test api/src/export/export.test.mjs fails with 404' }, PLAN.lanes[1]] });
    const { brief } = await plan(withRepro, { kind: 'fix' });
    assert.equal(brief.status, 'planned');
    assert.equal(brief.next.args.kind, 'fix');
  });

  const facts = { answer: 'it lives in routes', facts: [{ claim: 'the export route exists', evidence: 'api/src/routes/index.mjs:12' }], gaps: [] };
  const questions = ['Where are routes registered?', { question: 'How is CSV built?', paths: ['api/src/csv'] }, 'A third question'];

  test('runs at most delivery.limits.maxScouts scouts before the planner and gives the planner their facts', async () => {
    const run = await plan(PLAN, { scoutQuestions: questions, agents: { 'scout:1': facts, 'scout:2': facts } });
    assert.deepEqual(run.calls.map((c) => [c.label, c.opts.agentType]), [['scout:1', 'falsifiable:scout'], ['scout:2', 'falsifiable:scout'], ['planner', 'falsifiable:planner']]);
    assert.match(run.calls[1].prompt, /api\/src\/csv/);
    assert.match(run.calls[2].prompt, /api\/src\/routes\/index\.mjs:12/);
    assert.match(run.logs.join('\n'), /A third question/);
    assert.equal(run.brief.cost.agents, 3);
  });

  test('the scout limit follows the config and leaves the planner a place in the agent budget', async () => {
    const one = await plan(PLAN, { scoutQuestions: questions, agents: { 'scout:1': facts }, config: configWith({ delivery: { limits: { maxScouts: 1 } } }) });
    assert.deepEqual(one.calls.map((c) => c.label), ['scout:1', 'planner']);
    const tight = await plan(PLAN, { scoutQuestions: questions, agents: { 'scout:1': facts }, config: configWith({ delivery: { limits: { maxAgentsPerRun: 2 } } }) });
    assert.deepEqual(tight.calls.map((c) => c.label), ['scout:1', 'planner']);
  });

  test('a planner that returns nothing blocks the run', async () => {
    const { brief } = await plan(null);
    assert.equal(brief.status, 'blocked');
  });

  test('accepts args as a JSON string and refuses a missing id, an unknown stage or an unknown kind', async () => {
    const asString = await runBrief(SHIP, { args: JSON.stringify(ARGS), agents: { planner: PLAN } });
    assert.equal(asString.brief.status, 'planned');
    const noId = await runBrief(SHIP, { args: { ...ARGS, id: undefined } });
    assert.equal(noId.brief.status, 'blocked');
    assert.equal(noId.calls.length, 0);
    const badStage = await runBrief(SHIP, { args: { ...ARGS, stage: 'deploy' } });
    assert.equal(badStage.brief.status, 'blocked');
    assert.match(badStage.brief.headline, /stage/);
    const badKind = await runBrief(SHIP, { args: { ...ARGS, kind: 'chore' } });
    assert.equal(badKind.brief.status, 'blocked');
    assert.match(badKind.brief.headline, /kind/);
  });

  test('the planner result is checked against the plan contract', async () => {
    const broken = { ...PLAN, lanes: [{ ...PLAN.lanes[0], owns: 'api' }] };
    await assert.rejects(runWorkflow(SHIP, { args: ARGS, agents: { planner: broken } }), /owns: expected array/);
  });
});
