// Shared fixtures for the workflow tests: paths, the shared blocks of the
// workflows, the brief contract, a resolved project config and a small valid
// change with two lanes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../../lib/config.mjs';
import { validate } from '../../lib/schema.mjs';
import { loadWorkflow, parseWorkflow, runWorkflow } from './runtime.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WORKFLOWS = ['ship-stage', 'review-run'];
export const workflowFile = (name) => path.join(ROOT, 'workflows', `${name}.js`);
export const workflowSource = (name) => readFileSync(workflowFile(name), 'utf8');
export const load = (name) => loadWorkflow(workflowFile(name));

/** The text of a marked block, from its opening marker line to its closing one. */
export function markedBlock(source, title) {
  const start = source.indexOf(`// ── ${title}`);
  const endMarker = `// ── end ${title} ──`;
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1) return null;
  return source.slice(start, end + endMarker.length);
}

const META = "export const meta = { name: 'probe', description: 'probe' }\n";
export const SHARED_BLOCKS = ['shared contracts', 'agent budget'];

/** A probe workflow made of the shared blocks of `name` plus `body`. */
export function probeWith(name, body) {
  const source = workflowSource(name);
  const blocks = SHARED_BLOCKS.map((title) => markedBlock(source, title));
  return parseWorkflow(`${META}${blocks.join('\n')}\n${body}`, `${name}-probe.js`);
}

export const SCHEMAS = (await runWorkflow(probeWith('ship-stage', 'return { FINDINGS_SCHEMA, BRIEF_SCHEMA }'))).result;

/** Runs a workflow and returns its brief after checking it against BRIEF_SCHEMA. */
export async function runBrief(workflow, options) {
  const run = await runWorkflow(workflow, options);
  assert.equal(run.error, null, run.error?.stack);
  assert.deepEqual(validate(SCHEMAS.BRIEF_SCHEMA, run.result), [], JSON.stringify(run.result, null, 2));
  return { ...run, brief: run.result };
}

// ── a project config ────────────────────────────────────────────────────────

export const RAW_CONFIG = {
  delivery: {
    domains: {
      api: { owns: ['api/**'], proof: 'unit tests and an HTTP contract test', gate: 'npm test --workspace api', escalate: 'a new dependency' },
      web: { owns: ['web/**'], proof: 'component tests and the verifier in the browser', gate: 'npm test --workspace web', escalate: 'any new visible control' },
      repo: { owns: ['**'], proof: 'the check suites', gate: 'npm run check' },
    },
    sensitivePaths: {
      billing: ['api/src/billing/**'],
      authentication: ['api/src/auth/**', 'web/src/sign-in*'],
    },
  },
  verify: {
    health: ['http://localhost:3001/health'],
    credentialEnv: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD'],
    sweep: ['/', '/settings'],
    readPaths: ['e2e/pages/**'],
    commands: [['npx', 'playwright', 'test']],
  },
};

/** The resolved config for a raw one; the raw config must be valid. */
export function configFrom(raw) {
  const { config, problems } = resolveConfig(raw);
  assert.deepEqual(problems, [], 'the test config is invalid');
  return config;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) =>
  isPlainObject(base) && isPlainObject(over)
    ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, k in over ? merge(base[k], over[k]) : base[k]]))
    : structuredClone(over);

export const CONFIG = configFrom(RAW_CONFIG);

/** The resolved fixture config with `changes` merged in: objects merge, arrays replace. */
export const configWith = (changes) => configFrom(merge(RAW_CONFIG, changes));

// ── a small two-lane change ─────────────────────────────────────────────────

export const UNIT = 'Export returns CSV';
export const PRODUCT = 'The export button downloads a file';

export const lane = (id, owns, extra = {}) => ({ id, domain: 'api', goal: `Build ${id}`, owns, reads: [], scenarios: [], ...extra });

export const PLAN = {
  id: 'demo',
  lanes: [
    lane('api', ['api/src/export/**'], { reads: ['api/src/csv/**'], scenarios: [UNIT] }),
    lane('web', ['web/src/export/**'], { domain: 'web', scenarios: [PRODUCT] }),
  ],
  contracts: [{ name: 'GET /export', owner: 'api', detail: 'returns text/csv' }],
  scenarios: [
    { name: UNIT, proof: 'unit', detail: 'a route test' },
    { name: PRODUCT, proof: 'product', detail: 'seen in the browser' },
  ],
  openQuestions: [],
};

export const planWith = (changes) => ({ ...structuredClone(PLAN), ...changes });

export const redGreenTest = (extra = {}) => ({
  file: 'api/src/export/export.test.mjs',
  name: 'returns csv',
  redCommand: 'node --test api/src/export/export.test.mjs',
  redExitCode: 1,
  redExcerpt: 'AssertionError: expected 200, got 404',
  greenExitCode: 0,
  ...extra,
});

/** The gate of a fixture lane's domain: the web lane is in web, every other fixture lane in api. */
export const gateOf = (laneId) => CONFIG.delivery.domains[laneId === 'web' ? 'web' : 'api'].gate;

/** A passing run of a lane's gate, as a lane report lists it. */
export const gateRun = (laneId, extra = {}) => ({ command: gateOf(laneId), exitCode: 0, expect: 'pass', ...extra });

/** A lane report; its default new test sits in the first changed test file, or else the first changed file. */
export const report = (laneId, files, extra = {}) => ({
  lane: laneId,
  status: 'done',
  branch: `lane/demo/${laneId}`,
  headSha: '0123456789abcdef',
  base: 'change/demo',
  diffNameOnly: `${files.join('\n')}\n`,
  newTests: [redGreenTest(files.length ? { file: files.find((f) => /\.test\.\w+$/.test(f)) ?? files[0] } : {})],
  checks: [gateRun(laneId)],
  summary: `${laneId} built`,
  ...extra,
});

export const GOOD_REPORTS = {
  'builder:api': report('api', ['api/src/export/export.routes.mjs', 'api/src/export/export.test.mjs']),
  'builder:web': report('web', ['web/src/export/ExportButton.jsx']),
};

export const passVerdict = (scenarios = [PRODUCT]) => ({
  overall: 'PASS',
  scenarios: scenarios.map((scenario) => ({ scenario, result: 'PASS', evidence: ['.verify/demo/export.png'] })),
  regressions: [],
});

export const cleanFindings = (findings = []) => ({ diffMatchesReports: { ok: true, detail: 'every changed file is in a lane report' }, findings });

export const finding = (severity, file, extra = {}) => ({
  severity,
  file,
  line: 12,
  rule: 'review:access-scope',
  problem: 'the query is not scoped to the signed-in account',
  fix: 'filter by the account id',
  ...extra,
});
