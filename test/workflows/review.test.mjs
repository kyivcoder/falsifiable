// review-run, the workflow behind /falsifiable:review: three reviewer lenses,
// then one refuter for every P0 and P1. Run: node --test test/workflows/review.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULTS } from '../../lib/config.mjs';
import { CONFIG, GOOD_REPORTS, cleanFindings, configWith, finding, load, runBrief } from './fixtures.mjs';

const REVIEW = load('review-run');
const LENSES = ['review:correctness', 'review:tests', 'review:scope'];
const review = (args, agents) => runBrief(REVIEW, { args, agents });
const clean = Object.fromEntries(LENSES.map((label) => [label, cleanFindings()]));
const P1 = finding('P1', 'api/src/export/export.routes.mjs');
const P0 = finding('P0', 'api/src/csv/csv.mjs', { line: 3, rule: 'review:secrets', problem: 'logs the API key' });
const judge = (verdicts) => ({ judgements: verdicts.map(([finding, verdict, reason = 'checked the code']) => ({ finding, verdict, reason })) });

describe('review', () => {
  test('without args, three reviewer lenses read origin/<base branch>...HEAD and a clean result needs no refuter', async () => {
    const { brief, calls, maxConcurrent } = await review(undefined, clean);
    assert.deepEqual(calls.map((c) => [c.label, c.opts.agentType]), LENSES.map((label) => [label, 'falsifiable:reviewer']));
    for (const call of calls) assert.match(call.prompt, new RegExp(`git diff origin/${DEFAULTS.delivery.baseBranch}\\.\\.\\.HEAD`));
    assert.equal(new Set(calls.map((c) => c.prompt)).size, 3, 'each lens has its own focus');
    assert.equal(maxConcurrent, 3);
    assert.equal(brief.status, 'verified');
    assert.equal(brief.cost.agents, 3);
  });

  for (const args of ['42', '#42', 42, { pr: 42 }]) {
    test(`reviews pull request 42 given ${JSON.stringify(args)}`, async () => {
      const { calls } = await review(args, clean);
      assert.match(calls[0].prompt, /gh pr diff 42/);
    });
  }

  test('reviews a named range', async () => {
    const { calls } = await review('origin/main...change/demo', clean);
    assert.match(calls[0].prompt, /git diff origin\/main\.\.\.change\/demo/);
  });

  test('refuses a target that is neither a pull request nor a range, before any agent', async () => {
    for (const target of ['main; rm -rf /', { pr: -1 }, { pr: '42; true' }]) {
      const { brief, calls } = await review(target, clean);
      assert.equal(brief.status, 'blocked', JSON.stringify(target));
      assert.equal(calls.length, 0);
    }
  });

  test('without a config, every lens walks the default checklist and is told there is no second opinion', async () => {
    const { calls } = await review(undefined, clean);
    for (const call of calls) {
      assert.ok(call.prompt.includes(`Checklist: ${DEFAULTS.review.checklist}`), call.prompt);
      assert.match(call.prompt, /Second opinion: none configured/);
    }
    const change = await review({ id: 'demo' }, clean);
    assert.ok(change.calls[0].prompt.includes(`${DEFAULTS.delivery.specsDir}/changes/demo/specs/`), change.calls[0].prompt);
  });

  test('a config that is not JSON is refused rather than replaced by the defaults', async () => {
    const { brief, calls } = await review({ config: '{not json' }, clean);
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'blocked');
    assert.match(brief.headline, /config/);
  });

  test('the config names the checklist, the second opinion and the base branch', async () => {
    const config = configWith({ delivery: { baseBranch: 'trunk' }, review: { checklist: 'docs/review.md', secondOpinion: 'second-model review' } });
    const { calls } = await review({ config }, clean);
    for (const call of calls) {
      assert.match(call.prompt, /Checklist: docs\/review\.md/);
      assert.match(call.prompt, /Second opinion: run `second-model review` read-only/);
      assert.match(call.prompt, /git diff origin\/trunk\.\.\.HEAD/);
    }
  });

  test('accepts the config as JSON text, as the head may paste the script output', async () => {
    const config = JSON.stringify(configWith({ review: { checklist: 'docs/review.md' } }));
    const { calls } = await review({ config }, clean);
    assert.match(calls[0].prompt, /Checklist: docs\/review\.md/);
  });

  test('gives the lenses the change spec and the lane reports when it reviews a change', async () => {
    const { calls } = await review({ range: 'origin/main...change/demo', id: 'demo', reports: Object.values(GOOD_REPORTS), config: CONFIG }, clean);
    assert.match(calls[2].prompt, /openspec\/changes\/demo\/specs\//);
    assert.match(calls[2].prompt, /lane\/demo\/api/);
    const elsewhere = await review({ id: 'demo', config: configWith({ delivery: { specsDir: 'docs/specs' } }) }, clean);
    assert.match(elsewhere.calls[0].prompt, /docs\/specs\/changes\/demo\/specs\//);
  });

  test('for a change, the lenses are told which changes no lane reports, the archive and the living specs among them', async () => {
    const { calls } = await review({ id: 'demo', reports: Object.values(GOOD_REPORTS), config: CONFIG }, clean);
    const expected = 'Expected without a lane report: the change folder openspec/changes/demo/** and the merge commits of the lanes;'
      + ' after the hand-over also its archived copy openspec/changes/archive/*-demo/** and the living specs openspec/specs/** it updated.';
    for (const call of calls) assert.ok(call.prompt.includes(expected), call.prompt);
    const plain = await review('origin/main...HEAD', clean);
    assert.doesNotMatch(plain.calls[0].prompt, /Expected without a lane report/, 'without a change there is nothing to expect');
  });

  test('one refuter judges every distinct P0 and P1 together, and only confirmed ones remain', async () => {
    const agents = {
      ...clean,
      'review:correctness': cleanFindings([P1, P0]),
      'review:tests': cleanFindings([P1, finding('P3', 'api/src/a.mjs', { rule: 'review:naming', problem: 'unclear name' })]),
      refuter: judge([[1, 'refuted', 'the logger redacts the key'], [2, 'confirmed']]),
    };
    const { brief, calls } = await review(undefined, agents);
    const refuter = calls.find((c) => c.label === 'refuter');
    assert.equal(refuter.opts.agentType, 'falsifiable:reviewer');
    assert.equal(calls.filter((c) => c.label === 'refuter').length, 1);
    assert.match(refuter.prompt, /^1\. P0 api\/src\/csv\/csv\.mjs:3/m);
    assert.match(refuter.prompt, /^2\. P1 api\/src\/export\/export\.routes\.mjs:12/m);
    assert.doesNotMatch(refuter.prompt, /^3\./m);
    assert.equal(brief.cost.agents, 4);
    assert.equal(brief.status, 'needs-fix');
    assert.deepEqual(brief.next.args.findings.map((f) => [f.severity, f.rule]), [['P1', 'review:access-scope'], ['P3', 'review:naming']]);
    assert.match(brief.evidence.join('\n'), /refuted: P0 .*the logger redacts the key/);
  });

  test('when the refuter refutes every serious finding, the review passes', async () => {
    const agents = { ...clean, 'review:correctness': cleanFindings([P1]), refuter: judge([[1, 'refuted', 'not reachable']]) };
    const { brief } = await review(undefined, agents);
    assert.equal(brief.status, 'verified');
    assert.match(brief.headline, /1 refuted/);
  });

  test('a finding the refuter did not judge, or a refuter that returned nothing, keeps the finding', async () => {
    const unjudged = await review(undefined, { ...clean, 'review:correctness': cleanFindings([P1]), refuter: judge([]) });
    assert.equal(unjudged.brief.status, 'needs-fix');
    const silent = await review(undefined, { ...clean, 'review:correctness': cleanFindings([P1]), refuter: null });
    assert.equal(silent.brief.status, 'needs-fix');
    assert.match(silent.logs.join('\n'), /refuter returned nothing/);
  });

  test('a diff that does not match the lane reports is a P0 for the refuter', async () => {
    const mismatch = { diffMatchesReports: { ok: false, detail: 'api/src/app.mjs is in no report' }, findings: [] };
    const { brief, calls } = await review(undefined, { ...clean, 'review:scope': mismatch, refuter: judge([[1, 'confirmed']]) });
    assert.match(calls.find((c) => c.label === 'refuter').prompt, /review:diff-matches-reports/);
    assert.equal(brief.status, 'needs-fix');
  });

  test('one lens that returns nothing blocks the review and is named, even when the other lenses are clean', async () => {
    const { brief, calls } = await review(undefined, { ...clean, 'review:tests': null });
    assert.equal(brief.status, 'blocked');
    assert.match(brief.headline, /tests/);
    assert.match(brief.evidence.join('\n'), /the tests lens returned nothing/);
    assert.doesNotMatch(brief.headline, /correctness|scope/);
    assert.equal(calls.filter((c) => c.label === 'refuter').length, 0);
  });

  test('a silent lens blocks the review without losing what the other lenses found', async () => {
    const { brief, calls } = await review(undefined, { ...clean, 'review:scope': null, 'review:correctness': cleanFindings([P1]) });
    assert.equal(brief.status, 'blocked');
    assert.match(brief.evidence.join('\n'), /the scope lens returned nothing/);
    assert.match(brief.evidence.join('\n'), /P1 api\/src\/export\/export\.routes\.mjs:12/);
    assert.equal(calls.filter((c) => c.label === 'refuter').length, 0);
    const none = await review(undefined, Object.fromEntries(LENSES.map((label) => [label, null])));
    assert.equal(none.brief.status, 'blocked');
  });

  test('an agent budget too small for three lenses and a refuter refuses before any agent', async () => {
    const { brief, calls } = await review({ config: configWith({ delivery: { limits: { maxAgentsPerRun: 3 } } }) }, clean);
    assert.equal(calls.length, 0);
    assert.equal(brief.status, 'blocked');
    assert.match(brief.headline, /4 agents/);
    assert.match(brief.headline, /maxAgentsPerRun is 3/);
  });
});
