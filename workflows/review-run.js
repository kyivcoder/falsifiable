export const meta = {
  name: 'review-run',
  description: 'Review a pull request or a branch through three lenses, then let one refuter test every P0 and P1 before anything is reported.',
  whenToUse: 'Started by /falsifiable:review, which passes the resolved project config. args: a pull request number ("42" or {pr: 42}) or a git range ("origin/main...change/x" or {range}); for a change also {id, reports}; and config: the JSON that scripts/config.mjs prints, for the checklist, the second opinion and the base branch. Without a target it reviews origin/<base branch>...HEAD.',
  phases: [
    { title: 'Review', detail: 'three reviewer lenses in parallel' },
    { title: 'Refute', detail: 'one refuter judges every P0 and P1 together' },
  ],
}

// The workflow behind /falsifiable:review. It finds problems from three
// angles, then tries to knock down every serious one before it reaches
// the user: a P0 or P1 survives only when a second reader confirms it in the code.
// The checklist, the second model and the base branch come from args.config
// when it is given; otherwise the defaults of lib/config.mjs apply.
//
// Tests: node --test test/workflows/review.test.mjs

// ── shared contracts: identical in ship-stage.js and review-run.js (test/workflows/contracts.test.mjs) ──

// args may arrive as an object, a JSON string or plain text.
const input = (() => {
  if (args && typeof args === 'object') return args
  if (typeof args !== 'string') return args === undefined ? {} : { text: String(args) }
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {}
  return { text: args }
})()

// The resolved project config: an object, or the JSON text scripts/config.mjs prints; null when that text is not JSON.
const config = (() => {
  if (typeof input.config !== 'string') return input.config
  try {
    return JSON.parse(input.config)
  } catch {
    return null
  }
})()

const text = { type: 'string' }
const texts = { type: 'array', items: text }
// Every property is required unless listed as optional; no other properties are allowed.
const record = (properties, optional = []) =>
  ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter((key) => !optional.includes(key)) })

const FINDINGS_SCHEMA = record({
  diffMatchesReports: record({ ok: { type: 'boolean' }, detail: text }),
  findings: { type: 'array', items: record({
    severity: { enum: ['P0', 'P1', 'P2', 'P3'] }, file: text, line: { type: 'integer', minimum: 0 },
    rule: { type: 'string', description: 'the checklist item the finding breaks, written review:<slug>' },
    problem: text, fix: text,
  }) },
})

const BRIEF_SCHEMA = record({
  status: { enum: ['planned', 'built', 'verified', 'needs-fix', 'needs-decision', 'blocked'] },
  headline: text, done: texts,
  decision: record({ about: text, question: text, options: { type: 'array', minItems: 2, items: text }, recommendation: text, why: text }, ['about']),
  evidence: texts,
  cost: record({ agents: { type: 'integer', minimum: 0 }, usd: { type: 'number', minimum: 0 } }, ['usd']),
  next: record({ stage: text, args: { type: 'object', properties: {} }, note: text }, ['stage', 'args']),
}, ['decision'])

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

/** The one brief a run returns to the head: at most one decision; the others wait in next.note. */
function brief({ status, headline, done = [], decisions = [], evidence = [], next = {}, usd }) {
  const [decision, ...later] = decisions
  const note = [next.note, ...later.map((d) => `Then decide: ${d.question}`)].filter(Boolean).join(' ')
  return defined({
    status, headline, done, decision, evidence,
    cost: defined({ agents: agentsStarted, usd }),
    next: defined({ stage: next.stage, args: next.args && defined(next.args), note: note || 'Nothing further.' }),
  })
}

/** The reviewer's lines about the project's checklist and its optional second model. */
function reviewSetup(checklist, secondOpinion) {
  return [
    `Checklist: ${checklist}. Walk the items the diff touches; a finding names its item as review:<slug>.`,
    String(secondOpinion ?? '').trim()
      ? `Second opinion: run \`${secondOpinion}\` read-only from the repository root, with your review prompt as its last argument.`
        + ' Keep a P0 or P1 it reports only after you confirm it in the code, and start its problem with "Second opinion:".'
        + ' If it cannot run, say so in diffMatchesReports.detail.'
      : 'Second opinion: none configured.',
  ]
}

/** What a change's diff holds that no lane reports; after the hand-over, the archive and the living specs it updated too. */
function expectedWithoutReport(specsDir, id, archived) {
  const before = `Expected without a lane report: the change folder ${specsDir}/changes/${id}/** and the merge commits of the lanes`
  return archived
    ? `${before}; after the hand-over also its archived copy ${specsDir}/changes/archive/*-${id}/** and the living specs ${specsDir}/specs/** it updated.`
    : `${before}.`
}
// ── end shared contracts ──

// ── agent budget: identical in ship-stage.js and review-run.js (test/workflows/contracts.test.mjs) ──
// delivery.limits.maxAgentsPerRun, or its default when the caller passed no config.
const MAX_AGENTS_PER_RUN = Number.isInteger(config?.delivery?.limits?.maxAgentsPerRun) ? config.delivery.limits.maxAgentsPerRun : 5
let agentsStarted = 0
/** Starts an agent, or throws once the run has started as many as its budget allows. */
async function startAgent(prompt, opts) {
  if (agentsStarted >= MAX_AGENTS_PER_RUN) {
    throw new Error(`agent budget: a run may start at most ${MAX_AGENTS_PER_RUN} agents`)
  }
  agentsStarted += 1
  return agent(prompt, opts)
}
// ── end agent budget ──

/** A string setting of the config, or its default from lib/config.mjs when the caller passed none. */
function setting(dotted, fallback) {
  const value = dotted.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), config)
  return typeof value === 'string' && value.trim() ? value : fallback
}
const SPECS_DIR = setting('delivery.specsDir', 'openspec')
const BASE_BRANCH = setting('delivery.baseBranch', 'main')
const CHECKLIST = setting('review.checklist', '.claude/review-checklist.md')
const SECOND_OPINION = setting('review.secondOpinion', '')

const RANGE = /^[\w./~^-]+(\.\.\.?[\w./~^-]+)?$/
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/
const SEVERITIES = ['P0', 'P1', 'P2', 'P3']
const LENSES = [
  {
    id: 'correctness',
    focus: 'correctness and safety: wrong behaviour, missing authorization, data that reaches a user or tenant it does not belong to, input used before it is validated, secrets or personal data in code, fixtures or logs',
  },
  {
    id: 'tests',
    focus: 'whether the tests prove behaviour: each new test fails without the change, no mock that always succeeds, no skipped or focused test, an integration test where a contract or a cross-module flow changed',
  },
  {
    id: 'scope',
    focus: "scope: the diff matches the lane reports and the change spec and does nothing beyond them, and it keeps every rule in the project's rule files and checklist",
  },
]
const NEEDED_AGENTS = LENSES.length + 1
const REFUTE_SCHEMA = record({
  judgements: { type: 'array', items: record({ finding: { type: 'integer', minimum: 1 }, verdict: { enum: ['confirmed', 'refuted'] }, reason: text }) },
})

const raw = String(input.text ?? '').trim()
const pr = input.pr ?? (/^#?\d+$/.test(raw) ? Number(raw.replace('#', '')) : undefined)
const range = input.range ?? (pr === undefined && raw ? raw : `origin/${BASE_BRANCH}...HEAD`)
const refusal =
  (input.config !== undefined && (config === null || typeof config !== 'object') && 'args.config is not a JSON object') ||
  (pr !== undefined && !(Number.isInteger(pr) && pr > 0) && `${JSON.stringify(pr)} is not a pull request number`) ||
  (pr === undefined && !RANGE.test(String(range)) && `${JSON.stringify(range)} is neither a pull request number nor a git range`) ||
  (input.id !== undefined && !SAFE_NAME.test(String(input.id)) && `${JSON.stringify(input.id)} is not a change id`) ||
  (MAX_AGENTS_PER_RUN < NEEDED_AGENTS
    && `review starts ${NEEDED_AGENTS} agents (three lenses and a refuter), but delivery.limits.maxAgentsPerRun is ${MAX_AGENTS_PER_RUN}`)
if (refusal) {
  return brief({ status: 'blocked', headline: refusal, next: { note: 'Run /falsifiable:review with a pull request number or a range such as origin/main...HEAD, and a valid config.' } })
}

const target = pr !== undefined ? `pull request #${pr} (read it with gh pr diff ${pr} and gh pr view ${pr})` : `the range ${range} (read it with git diff ${range})`
const reports = Array.isArray(input.reports) ? input.reports : []
const context = [
  ...(input.id
    ? [`Change: ${input.id}; its scenarios are in ${SPECS_DIR}/changes/${input.id}/specs/`, expectedWithoutReport(SPECS_DIR, input.id, true)]
    : []),
  reports.length ? `Lane reports:\n${JSON.stringify(reports, null, 2)}` : 'Lane reports: none. Set diffMatchesReports.ok to true and say there were no reports to compare.',
]
const rank = (f) => SEVERITIES.indexOf(f.severity)
const describeFinding = (f) => `${f.severity} ${f.file}:${f.line} [${f.rule}] ${f.problem}`

phase('Review')
const reviews = await parallel(LENSES.map((lens) => () => startAgent(
  [`Review ${target}.`, `Your lens: ${lens.focus}. Report only what this lens finds; two other reviewers cover the rest.`,
    ...reviewSetup(CHECKLIST, SECOND_OPINION), ...context].join('\n'),
  { label: `review:${lens.id}`, phase: 'Review', agentType: 'falsifiable:reviewer', schema: FINDINGS_SCHEMA },
)))
// A lens that returned nothing leaves its part of the diff unreviewed, so the review cannot pass.
const silentLenses = LENSES.filter((lens, i) => !reviews[i]).map((lens) => lens.id)
const silent = silentLenses.map((id) => `the ${id} lens returned nothing`)
if (silent.length) {
  const found = reviews.filter(Boolean).flatMap((r) => r.findings).map((f) => `found by another lens: ${describeFinding(f)}`)
  return brief({
    status: 'blocked',
    headline: `The ${silentLenses.join(' and ')} lens${silent.length > 1 ? 'es' : ''} returned nothing, so the diff is not fully reviewed`,
    evidence: [...silent, ...found],
    next: { note: 'Run /falsifiable:review again; no finding is final until every lens has reported.' },
  })
}

// One list across the lenses: the same file, line and rule is one finding, at its highest severity.
const mismatches = reviews.filter((r) => !r.diffMatchesReports.ok).map((r) => ({
  severity: 'P0', file: '(lane reports)', line: 0, rule: 'review:diff-matches-reports', problem: r.diffMatchesReports.detail, fix: 'find out which report is wrong',
}))
const unique = new Map()
for (const f of [...mismatches, ...reviews.flatMap((r) => r.findings)]) {
  const key = `${f.file}:${f.line}:${f.rule}`
  if (!unique.has(key) || rank(f) < rank(unique.get(key))) unique.set(key, f)
}
const all = [...unique.values()].sort((a, b) => rank(a) - rank(b))
const serious = all.filter((f) => rank(f) <= 1)

let confirmed = serious
let refuted = []
if (serious.length) {
  phase('Refute')
  const verdict = await startAgent([
    `Three reviewers of ${target} reported the findings below. Test each one against the code it cites.`,
    'Mark a finding refuted only when the code shows it is wrong, and give the line that shows it; otherwise mark it confirmed.',
    ...serious.map((f, i) => `${i + 1}. ${describeFinding(f)} (fix: ${f.fix})`),
  ].join('\n'), { label: 'refuter', phase: 'Refute', agentType: 'falsifiable:reviewer', schema: REFUTE_SCHEMA }).catch(() => null)
  if (!verdict) log('The refuter returned nothing; every P0 and P1 finding stands.')
  const judged = new Map((verdict?.judgements ?? []).map((j) => [j.finding, j]))
  confirmed = serious.filter((f, i) => judged.get(i + 1)?.verdict !== 'refuted')
  refuted = serious.map((f, i) => ({ f, j: judged.get(i + 1) })).filter(({ j }) => j?.verdict === 'refuted')
}

const final = [...confirmed, ...all.filter((f) => rank(f) > 1)]
const done = LENSES.map((lens, i) => `${lens.id}: ${reviews[i].findings.length} finding(s)`)
const evidence = [...final.map(describeFinding), ...refuted.map(({ f, j }) => `refuted: ${describeFinding(f)} (${j.reason})`)]
const refutedNote = refuted.length ? ` (${refuted.length} refuted)` : ''
if (confirmed.length) {
  return brief({
    status: 'needs-fix',
    headline: `${confirmed.length} P0/P1 finding(s) survived the refuter${refutedNote}`,
    done,
    evidence,
    next: { args: { findings: final }, note: 'Fix each P0 and P1 finding, or answer it in the pull request.' },
  })
}
return brief({
  status: 'verified',
  headline: `No P0 or P1 findings${refutedNote}`,
  done,
  evidence,
  next: { args: { findings: final }, note: final.length ? 'The P2 and P3 findings are optional improvements.' : 'Nothing further.' },
})
