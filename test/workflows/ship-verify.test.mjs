// ship-stage, verify and fix: diff-blind verification, typed defects and
// bounded fix rounds. Run: node --test test/workflows/ship-verify.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONFIG, GOOD_REPORTS, PLAN, PRODUCT, UNIT, cleanFindings, configWith, finding, lane, load, passVerdict, planWith, report, runBrief } from './fixtures.mjs';

const SHIP = load('ship-stage');
const REPORTS = Object.values(GOOD_REPORTS);
const VERIFY = { id: 'demo', stage: 'verify', base: 'change/demo', plan: PLAN, reports: REPORTS, round: 1, config: CONFIG };
const verify = (agents, args = {}) => runBrief(SHIP, { args: { ...VERIFY, ...args }, agents });
const failVerdict = {
  overall: 'FAIL',
  scenarios: [{ scenario: PRODUCT, result: 'FAIL', evidence: ['.verify/demo/export.png'], expected: 'a CSV download', actual: 'a 404 page', steps: ['open Reports', 'press Export'] }],
  regressions: [],
};

const defect = (laneId, severity = 'FAIL') => ({ source: 'verify', lane: laneId, severity, where: PRODUCT, rule: '', problem: 'expected a CSV download, got a 404 page', evidence: '.verify/demo/export.png', fix: '' });
const FIX = { id: 'demo', stage: 'fix', base: 'change/demo', plan: PLAN, reports: REPORTS, round: 1, defects: [defect('web')], config: CONFIG };
const fix = (agents, args = {}) => runBrief(SHIP, { args: { ...FIX, ...args }, agents });

/** The fixture config with verify settings replaced as they arrive, skipping the schema: the workflow must check them itself. */
const verifyConfig = (changes) => ({ ...structuredClone(CONFIG), verify: { ...CONFIG.verify, ...changes } });

describe('ship-stage verify', () => {
  test('the verifier prompt carries the change id, product scenarios and the config verify settings, and nothing about the build', async () => {
    const { calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() });
    const verifier = calls.find((c) => c.label === 'verifier');
    assert.equal(verifier.opts.agentType, 'falsifiable:verifier');
    const parts = ['demo', PRODUCT, 'openspec/changes/demo/specs/', 'http://localhost:3000', 'http://localhost:3001/health', 'TEST_USER_EMAIL', 'TEST_USER_PASSWORD',
      CONFIG.verify.instruments, '/settings'];
    for (const part of parts) assert.ok(verifier.prompt.includes(part), `the verifier prompt lacks "${part}"`);
    const leaks = [UNIT, 'git diff', 'Diff range', 'design.md', 'tasks.md', 'proposal.md', 'lane/demo/', '0123456789abcdef', 'change/demo', 'Build api', 'api/src', 'web/src', 'GET /export',
      'npm test', CONFIG.delivery.domains.web.proof, 'sourcePaths'];
    for (const leak of leaks) assert.ok(!verifier.prompt.includes(leak), `the verifier prompt leaks "${leak}":\n${verifier.prompt}`);
  });

  test('the verifier prompt says what the fence allows it: the read paths, the commands and the MCP servers of the config', async () => {
    const { calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() });
    const prompt = calls.find((c) => c.label === 'verifier').prompt;
    assert.ok(prompt.includes("Readable besides the change's specs and .verify/: e2e/pages/**"), prompt);
    assert.ok(prompt.includes('Commands besides curl to the base URL and housekeeping under .verify/: npx playwright test'), prompt);
    assert.ok(prompt.includes('MCP servers: chrome, playwright'), prompt);
    assert.match(prompt, /fence-read, fence-tool, fence-write or fence-diff/);
    const bare = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: configWith({ verify: { readPaths: [], commands: [], mcpServers: [] } }) });
    const none = bare.calls.find((c) => c.label === 'verifier').prompt;
    assert.ok(none.includes("Readable besides the change's specs and .verify/: nothing"), none);
    assert.ok(none.includes('Commands besides curl to the base URL and housekeeping under .verify/: none'), none);
    assert.ok(none.includes('MCP servers: none'), none);
  });

  test('the reviewer is told which changes no lane reports, so they are not mismatches', async () => {
    const { calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() });
    const prompt = calls.find((c) => c.label === 'reviewer').prompt;
    assert.ok(prompt.includes('Expected without a lane report: the change folder openspec/changes/demo/** and the merge commits of the lanes.'), prompt);
    assert.doesNotMatch(prompt, /changes\/archive/, 'before the hand-over there is no archive');
  });

  test('without credential variables or a sweep, the verifier is told so', async () => {
    const config = configWith({ verify: { credentialEnv: [], sweep: [], health: [] } });
    const { calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config });
    const prompt = calls.find((c) => c.label === 'verifier').prompt;
    assert.match(prompt, /no credential variables are configured/);
    assert.match(prompt, /Regression sweep: none configured; return an empty regressions list/);
  });

  test('the reviewer gets the diff range from the base branch, the change, the checklist and the lane reports, alongside the verifier', async () => {
    const run = await verify({ verifier: passVerdict(), reviewer: cleanFindings() });
    const reviewer = run.calls.find((c) => c.label === 'reviewer');
    assert.equal(reviewer.opts.agentType, 'falsifiable:reviewer');
    assert.match(reviewer.prompt, /Diff range: origin\/main\.\.\.change\/demo/);
    assert.match(reviewer.prompt, /openspec\/changes\/demo\//);
    assert.match(reviewer.prompt, /Checklist: \.claude\/review-checklist\.md/);
    assert.match(reviewer.prompt, /Second opinion: none configured/);
    assert.match(reviewer.prompt, /lane\/demo\/web/);
    assert.equal(run.maxConcurrent, 2);
    const trunk = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: configWith({ delivery: { baseBranch: 'trunk' } }) });
    assert.match(trunk.calls.find((c) => c.label === 'reviewer').prompt, /origin\/trunk\.\.\.change\/demo/);
  });

  test('the reviewer runs the configured second opinion read-only and checks its findings', async () => {
    const config = configWith({ review: { secondOpinion: 'second-model review --read-only' } });
    const { calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config });
    const prompt = calls.find((c) => c.label === 'reviewer').prompt;
    assert.match(prompt, /Second opinion: run `second-model review --read-only` read-only/);
    assert.match(prompt, /only after you confirm it in the code/);
  });

  test('every product scenario passing and no P0/P1 means verified, and the hand-over archives the change', async () => {
    const { brief, calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings([finding('P2', 'api/src/export/export.routes.mjs')]) });
    assert.equal(brief.status, 'verified');
    assert.deepEqual(calls.map((c) => c.label).sort(), ['reviewer', 'verifier']);
    assert.match(brief.evidence.join('\n'), /P2 api\/src\/export\/export\.routes\.mjs:12/);
    assert.equal(brief.next.stage, undefined);
    assert.match(brief.next.note, /openspec archive demo --yes/);
    assert.equal(brief.cost.agents, 2);
  });

  test('a failed scenario becomes a typed defect for the lane that serves it', async () => {
    const { brief, calls } = await verify({ verifier: failVerdict, reviewer: cleanFindings() });
    assert.equal(brief.status, 'needs-fix');
    assert.equal(brief.next.stage, 'fix');
    assert.equal(brief.next.args.round, 1);
    const [only] = brief.next.args.defects;
    assert.deepEqual(only, { source: 'verify', lane: 'web', severity: 'FAIL', where: PRODUCT, rule: '', problem: 'expected a CSV download, got a 404 page', evidence: '.verify/demo/export.png; steps: open Reports > press Export', fix: '' });
    assert.equal(calls.length, 2, 'verify starts the verifier and the reviewer, nothing else');
  });

  test('a P1 finding goes to the lane that owns its file; P2 and P3 only inform', async () => {
    const findings = cleanFindings([finding('P1', 'api/src/export/export.routes.mjs'), finding('P3', 'web/src/export/a.jsx')]);
    const { brief } = await verify({ verifier: passVerdict(), reviewer: findings });
    assert.equal(brief.status, 'needs-fix');
    assert.deepEqual(brief.next.args.defects.map((d) => [d.lane, d.severity, d.rule]), [['api', 'P1', 'review:access-scope']]);
    assert.match(brief.evidence.join('\n'), /P3 web\/src\/export\/a\.jsx:12/);
  });

  test('a diff that does not match the lane reports is a P0 that no lane owns', async () => {
    const mismatch = { diffMatchesReports: { ok: false, detail: 'api/src/app.mjs changed but no report lists it' }, findings: [] };
    const { brief } = await verify({ verifier: passVerdict(), reviewer: mismatch });
    assert.equal(brief.status, 'needs-fix');
    assert.deepEqual(brief.next.args.defects.map((d) => [d.lane, d.severity, d.rule]), [[null, 'P0', 'review:diff-matches-reports']]);
  });

  test('a scenario the verifier could not run, or did not judge, blocks the stage', async () => {
    const blocked = { overall: 'BLOCKED', scenarios: [{ scenario: PRODUCT, result: 'BLOCKED', evidence: ['the app is not running'] }], regressions: [] };
    const one = await verify({ verifier: blocked, reviewer: cleanFindings() });
    assert.equal(one.brief.status, 'blocked');
    assert.match(one.brief.evidence.join('\n'), /the app is not running/);
    const two = await verify({ verifier: { overall: 'PASS', scenarios: [], regressions: [] }, reviewer: cleanFindings() });
    assert.equal(two.brief.status, 'blocked');
    assert.match(two.brief.evidence.join('\n'), /the verifier did not judge it/);
  });

  test('a change with no product scenarios starts no verifier', async () => {
    const unitOnly = planWith({ scenarios: [PLAN.scenarios[0], { ...PLAN.scenarios[1], proof: 'review' }] });
    const { brief, calls } = await verify({ reviewer: cleanFindings() }, { plan: unitOnly });
    assert.equal(brief.status, 'verified');
    assert.deepEqual(calls.map((c) => c.label), ['reviewer']);
  });

  test('a verifier or reviewer that returns nothing blocks the stage', async () => {
    const reviewer = await verify({ verifier: passVerdict(), reviewer: null });
    assert.equal(reviewer.brief.status, 'blocked');
    assert.match(reviewer.brief.evidence.join('\n'), /the reviewer returned nothing/);
    const verifier = await verify({ verifier: null, reviewer: cleanFindings() });
    assert.match(verifier.brief.evidence.join('\n'), /the verifier returned nothing/);
  });

  test('a regression from the sweep stops the hand-over as a lane-less defect, which the fix stage takes to the user', async () => {
    const swept = { ...passVerdict(), regressions: ['/settings: GET /api/settings returned 500'] };
    const { brief } = await verify({ verifier: swept, reviewer: cleanFindings() });
    assert.equal(brief.status, 'needs-fix');
    assert.doesNotMatch(brief.next.note, /archive/);
    assert.deepEqual(brief.next.args.defects, [{
      source: 'verify', lane: null, severity: 'FAIL', where: 'regression sweep', rule: 'verify:regression',
      problem: '/settings: GET /api/settings returned 500', evidence: 'the verifier saw it in the regression sweep of /, /settings', fix: '',
    }]);
    const next = await fix({}, { ...brief.next.args, config: CONFIG });
    assert.equal(next.calls.length, 0);
    assert.equal(next.brief.decision.about, 'orphan-defects');
  });

  for (const baseUrl of ['https://example.com', 'http://localhost.evil.example:3000', 'http://localhost@evil.example', 'http://10.0.0.5:3000', 'ftp://localhost', 'localhost:3000']) {
    test(`refuses the base URL ${baseUrl} before any agent`, async () => {
      const { brief, calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: verifyConfig({ baseUrl }) });
      assert.equal(calls.length, 0);
      assert.equal(brief.status, 'blocked');
      assert.match(brief.headline, /localhost, 127\.0\.0\.1 or \[::1\]/);
    });
  }

  test('accepts localhost, 127.0.0.1 and [::1] with a port and a path', async () => {
    for (const baseUrl of ['http://localhost:3000', 'http://127.0.0.1:3000/en', 'https://localhost', 'http://[::1]:8080/']) {
      const { brief } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: verifyConfig({ baseUrl }) });
      assert.equal(brief.status, 'verified', baseUrl);
    }
  });

  test('a health check or sweep item that is not on the local app is refused too; a sweep path on the app is fine', async () => {
    const remote = [
      { health: ['https://example.com/health'] }, { health: ['example.com/health'] },
      { sweep: ['/', 'https://example.com/settings'] }, { sweep: ['example.com/settings'] }, { sweep: ['//example.com/settings'] },
    ];
    for (const changes of remote) {
      const { brief, calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: verifyConfig(changes) });
      const [bad] = (changes.health ?? changes.sweep).filter((item) => item !== '/');
      assert.equal(calls.length, 0, JSON.stringify(changes));
      assert.match(brief.headline, /not on the local app/);
      assert.deepEqual(brief.evidence, [bad]);
    }
    const local = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, {
      config: verifyConfig({ health: ['/health', 'http://localhost:3001/health'], sweep: ['/', 'http://127.0.0.1:3001/api/status'] }),
    });
    assert.equal(local.brief.status, 'verified');
  });

  // Items a browser resolves to another host: a backslash reads as a slash, and tabs, newlines and leading spaces are dropped.
  const TRICKS = [
    '/\\prod.example.com/health', '\\\\prod.example.com/health', '/\t/prod.example.com/health', '/\n/prod.example.com', ' //prod.example.com',
    'http://localhost:3000\\@prod.example.com/', 'http://localhost:3000/ok\\..\\x', 'HTTP://prod.example.com/', 'javascript:alert(1)',
    'http://127.0.0.1.prod.example.com/', 'settings', '?page=2', '#top', '',
  ];
  const SAFE = ['/', '/settings', '/api/notes?page=2', '/a%5Cb', '/%2F%2Fprod.example.com', 'http://localhost:3001/health', 'http://[::1]:3000/x', 'https://127.0.0.1/'];
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

  test('the tricks a browser would resolve to another host are refused, in the health checks, the sweep and the base URL', async () => {
    for (const item of TRICKS) {
      for (const changes of [{ health: [item] }, { sweep: [item] }]) {
        const { brief, calls } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: verifyConfig(changes) });
        assert.equal(calls.length, 0, JSON.stringify(changes));
        assert.deepEqual(brief.evidence, [item], JSON.stringify(changes));
      }
    }
    const base = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: verifyConfig({ baseUrl: 'http://localhost:3000/\\x' }) });
    assert.equal(base.calls.length, 0);
  });

  test('every item the workflow accepts resolves, with URL semantics, to a local host', async () => {
    for (const item of SAFE) {
      const { brief } = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { config: verifyConfig({ health: [item], sweep: [item] }) });
      assert.equal(brief.status, 'verified', item);
      assert.ok(LOCAL_HOSTS.has(new URL(item, CONFIG.verify.baseUrl).hostname), `${item} resolves to ${new URL(item, CONFIG.verify.baseUrl).hostname}`);
    }
  });

  test('the table of tricks is real: under URL semantics the first five reach another host', () => {
    for (const item of TRICKS.slice(0, 5)) assert.equal(new URL(item, CONFIG.verify.baseUrl).hostname, 'prod.example.com', JSON.stringify(item));
  });
});

describe('ship-stage fix', () => {
  test('a round past delivery.limits.maxFixRounds starts no builder and asks the user, naming the open defects and their evidence', async () => {
    const { brief, calls } = await fix({}, { round: 3 });
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'fix-rounds');
    assert.match(brief.evidence.join('\n'), /FAIL web .*The export button downloads a file.*\.verify\/demo\/export\.png/);
  });

  test('the last allowed round still runs, and the cap follows the config', async () => {
    const two = await fix({ 'builder:web': GOOD_REPORTS['builder:web'] }, { round: 2 });
    assert.equal(two.brief.status, 'built');
    assert.equal(two.brief.next.args.round, 3);
    const capped = await fix({}, { round: 2, config: configWith({ delivery: { limits: { maxFixRounds: 1 } } }) });
    assert.equal(capped.calls.length, 0);
    assert.equal(capped.brief.decision.about, 'fix-rounds');
    assert.match(capped.brief.decision.question, /1 fix round\(s\) did not clear/);
  });

  test('sends each affected lane its typed defects and hands back to verify', async () => {
    const { brief, calls } = await fix({ 'builder:web': GOOD_REPORTS['builder:web'] });
    assert.deepEqual(calls.map((c) => [c.label, c.opts.agentType, c.opts.isolation]), [['builder:web', 'falsifiable:builder', 'worktree']]);
    assert.match(calls[0].prompt, /Defects to fix \(fix round 1\)/);
    assert.match(calls[0].prompt, /expected a CSV download, got a 404 page/);
    assert.equal(brief.status, 'built');
    assert.equal(brief.next.stage, 'verify');
    assert.equal(brief.next.args.round, 2);
    assert.match(brief.next.note, /merge-lanes\.mjs demo api web/);
  });

  test('keeps every accepted report across build and fix rounds, and the next reviewer gets all of them', async () => {
    const fixReport = report('web', ['web/src/export/ExportButton.jsx'], { headSha: 'fedcba9876543210', newTests: [], summary: 'web fixed' });
    const fixed = await fix({ 'builder:web': fixReport });
    assert.equal(fixed.brief.status, 'built');
    const reports = fixed.brief.next.args.reports;
    assert.deepEqual(reports.map((r) => [r.lane, r.headSha]), [['api', '0123456789abcdef'], ['web', '0123456789abcdef'], ['web', 'fedcba9876543210']]);
    const next = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { ...fixed.brief.next.args, config: CONFIG });
    const prompt = next.calls.find((c) => c.label === 'reviewer').prompt;
    assert.ok(prompt.includes('fedcba9876543210') && prompt.includes('ExportButton.jsx'), 'the fix report reaches the reviewer');
    assert.ok(prompt.includes('api/src/export/export.test.mjs'), 'the build report, with its test, reaches the reviewer too');
    assert.match(prompt, /every accepted report, from the build and each fix round/);
  });

  test('the same report passed twice is kept once', async () => {
    const fixed = await fix({ 'builder:web': GOOD_REPORTS['builder:web'] });
    assert.deepEqual(fixed.brief.next.args.reports.map((r) => [r.lane, r.headSha]), [['api', '0123456789abcdef'], ['web', '0123456789abcdef']]);
  });

  const threeLanes = ['a', 'b', 'c'].map((id, i) => lane(id, [`api/src/${id}/**`], { scenarios: i < 2 ? [PLAN.scenarios[i].name] : [] }));
  const threeReports = Object.fromEntries(threeLanes.map((l) => [`builder:${l.id}`, report(l.id, [`api/src/${l.id}/x.mjs`])]));

  test('fixes at most delivery.limits.maxParallelBuilders lanes per round, the most severe first', async () => {
    const defects = [defect('a', 'P1'), defect('b', 'FAIL'), defect('c', 'P0')];
    const run = await fix(threeReports, { plan: planWith({ lanes: threeLanes, contracts: [] }), defects });
    assert.deepEqual(run.calls.map((c) => c.label).sort(), ['builder:b', 'builder:c']);
    assert.match(run.logs.join('\n'), /a waits for the next round/);
    const one = await fix(threeReports, { plan: planWith({ lanes: threeLanes, contracts: [] }), defects, config: configWith({ delivery: { limits: { maxParallelBuilders: 1 } } }) });
    assert.deepEqual(one.calls.map((c) => c.label), ['builder:c']);
  });

  test('lanes deferred past the per-round limit go into the brief with their defects, and the next verify keeps them open', async () => {
    const plan = planWith({ lanes: threeLanes, contracts: [] });
    const deferred = { source: 'review', lane: 'a', severity: 'P1', where: 'api/src/a/x.mjs:12', rule: 'review:access-scope',
      problem: 'the query is not scoped to the signed-in account', evidence: 'api/src/a/x.mjs:12', fix: 'filter by the account id' };
    const fixed = await fix(threeReports, { plan, defects: [deferred, defect('b', 'FAIL'), defect('c', 'P0')] });
    assert.equal(fixed.brief.status, 'built');
    assert.match(fixed.brief.evidence.join('\n'), /deferred to the next fix round: P1 a api\/src\/a\/x\.mjs:12/);
    assert.deepEqual(fixed.brief.next.args.defects, [deferred]);

    const clean = await verify({ verifier: passVerdict(), reviewer: cleanFindings() }, { ...fixed.brief.next.args, config: CONFIG });
    assert.equal(clean.brief.status, 'needs-fix');
    assert.deepEqual(clean.brief.next.args.defects, [deferred]);

    const refound = await verify({ verifier: passVerdict(), reviewer: cleanFindings([finding('P1', 'api/src/a/x.mjs')]) }, { ...fixed.brief.next.args, config: CONFIG });
    assert.deepEqual(refound.brief.next.args.defects, [deferred], 'the same defect found again is listed once');
  });

  test('a defect that no lane owns goes to the user and starts no builder', async () => {
    const { brief, calls } = await fix({}, { defects: [{ ...defect(null, 'P0'), source: 'review', where: 'api/src/app.mjs:1' }] });
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'needs-decision');
    assert.equal(brief.decision.about, 'orphan-defects');
    assert.match(brief.evidence.join('\n'), /api\/src\/app\.mjs:1/);
  });

  test('a sensitive lane the user did not approve gets no fix round', async () => {
    const billing = planWith({ lanes: [...PLAN.lanes, lane('billing', ['api/src/billing/**'])] });
    const sentBack = await fix({}, { plan: billing, defects: [defect('billing', 'P1')], decisions: [{ about: 'lane:billing:billing', answer: 'Send the plan back' }] });
    assert.equal(sentBack.calls.length, 0);
    assert.equal(sentBack.brief.next.stage, 'plan');
    const approved = await fix({ 'builder:billing': report('billing', ['api/src/billing/plan.mjs']) }, {
      plan: billing, defects: [defect('billing', 'P1')], decisions: [{ about: 'lane:billing:billing', answer: 'Build as planned' }],
    });
    assert.deepEqual(approved.calls.map((c) => c.label), ['builder:billing']);
  });

  test('a fixed lane that writes outside its paths still fails', async () => {
    const stray = report('web', ['web/src/app/layout.jsx']);
    const { brief } = await fix({ 'builder:web': stray });
    assert.equal(brief.status, 'blocked');
    assert.match(brief.evidence.join('\n'), /changed web\/src\/app\/layout\.jsx/);
  });

  test('needs a round and the defects', async () => {
    assert.equal((await fix({}, { round: undefined })).brief.status, 'blocked');
    assert.equal((await fix({}, { defects: [] })).brief.status, 'blocked');
  });
});
