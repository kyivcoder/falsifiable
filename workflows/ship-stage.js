export const meta = {
  name: 'ship-stage',
  description: 'Run one stage of an approved change (plan, build, verify or fix) and return one brief for the user.',
  whenToUse: 'Started by /falsifiable:ship, which passes the resolved project config; not by hand. One stage per run: pass each brief.next.args back with config added. args: {id, stage: "plan" | "build" | "verify" | "fix", base: the change branch, config: the JSON that scripts/config.mjs prints, kind?: "feature" | "fix", plan?, decisions?: [{about, answer}], lanes?, reports?, round?, defects?, scoutQuestions?}',
  phases: [
    { title: 'Plan', detail: 'scouts, then the planner' },
    { title: 'Build', detail: 'one builder per lane, each in its own worktree' },
    { title: 'Verify', detail: 'the verifier, blind to the code, and the reviewer' },
    { title: 'Fix', detail: 'one builder per lane with defects' },
  ],
}

// One stage of /falsifiable:ship per run. Between runs the state is the change
// folder, the lane branches and the args the head passes back from
// brief.next.args. The script checks shape and consistency; the reviewer checks
// truth. Everything about the project (domains, sensitive areas, limits, how to
// reach the app) comes from args.config, because a workflow cannot read files.
//
// Tests: node --test test/workflows/

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

// ── paths: copies of lib/glob.mjs, since a workflow loads no modules (test/workflows/glob-parity.test.mjs) ──
// `*` matches inside one folder name, `**` any number of folders, a trailing / the whole folder.
const segmentsOf = (pattern) =>
  String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '/**').split('/').filter(Boolean)
const hasWildcard = (segment) => /[*?]/.test(segment)
const segmentRegExp = (segment) =>
  new RegExp('^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$')

function matchFrom(glob, path) {
  if (glob.length === 0) return path.length === 0
  if (glob[0] === '**') return matchFrom(glob.slice(1), path) || (path.length > 0 && matchFrom(glob, path.slice(1)))
  return path.length > 0 && segmentRegExp(glob[0]).test(path[0]) && matchFrom(glob.slice(1), path.slice(1))
}

/** True when `path` matches `glob`. */
const matches = (glob, path) => matchFrom(segmentsOf(glob), segmentsOf(path))

/** True when `glob` matches `path` or any tail of it that starts at a folder boundary. */
const matchesAtAnyDepth = (glob, path) => segmentsOf(path).some((_, start, target) => matchFrom(segmentsOf(glob), target.slice(start)))

function containsFrom(outer, inner) {
  if (inner.length === 0) return outer.every((s) => s === '**')
  if (outer.length === 0) return false
  if (outer[0] === '**') return containsFrom(outer.slice(1), inner) || containsFrom(outer, inner.slice(1))
  if (inner[0] === '**') return false
  const fits = hasWildcard(inner[0]) ? outer[0] === '*' || outer[0] === inner[0] : segmentRegExp(outer[0]).test(inner[0])
  return fits && containsFrom(outer.slice(1), inner.slice(1))
}

/** True when every path `inner` can match also matches `outer`. Conservative: a wildcard in `inner` is contained only by `*` or the same wildcard. */
const contains = (outer, inner) => containsFrom(segmentsOf(outer), segmentsOf(inner))

function segmentsMeet(a, b) {
  if (!hasWildcard(a) && !hasWildcard(b)) return a === b
  if (!hasWildcard(a)) return segmentRegExp(b).test(a)
  if (!hasWildcard(b)) return segmentRegExp(a).test(b)
  return true // two wildcards in one folder name: assume some name matches both
}

function overlapFrom(a, b) {
  if (a.length === 0 && b.length === 0) return true
  if (a[0] === '**') return overlapFrom(a.slice(1), b) || (b.length > 0 && overlapFrom(a, b.slice(1)))
  if (b[0] === '**') return overlapFrom(a, b.slice(1)) || (a.length > 0 && overlapFrom(a.slice(1), b))
  return a.length > 0 && b.length > 0 && segmentsMeet(a[0], b[0]) && overlapFrom(a.slice(1), b.slice(1))
}

/** True when some file could match both patterns; a plain path matches only itself. */
const overlaps = (a, b) => overlapFrom(segmentsOf(a), segmentsOf(b))
// ── end paths ──

// ── config: the keys this script reads. The ship skill passes the resolved config, which has all of them ──
const CONFIG_KEYS = {
  'delivery.specsDir': 'string', 'delivery.baseBranch': 'string', 'delivery.domains': 'object', 'delivery.sensitivePaths': 'object',
  'delivery.limits.maxLanes': 'integer', 'delivery.limits.maxParallelBuilders': 'integer', 'delivery.limits.maxFixRounds': 'integer',
  'delivery.limits.maxAgentsPerRun': 'integer', 'delivery.limits.maxScouts': 'integer',
  'guard.protectedPaths': 'array', 'guard.protectedBranches': 'array', 'guard.unlockEnv': 'string',
  'verify.baseUrl': 'string', 'verify.health': 'array', 'verify.credentialEnv': 'array', 'verify.instruments': 'string', 'verify.sweep': 'array',
  'verify.readPaths': 'array', 'verify.commands': 'array', 'verify.mcpServers': 'array',
  'review.checklist': 'string', 'review.secondOpinion': 'string',
}
const KIND_NAMES = { string: 'a string', integer: 'an integer', array: 'a list', object: 'an object' }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const kindOf = (value) => (Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : value === null ? 'null' : typeof value)
const valueAt = (object, dotted) => dotted.split('.').reduce((node, key) => (isObject(node) ? node[key] : undefined), object)
const isWordList = (value) => Array.isArray(value) && value.every((word) => typeof word === 'string' && word !== '')
const isFilledList = (value) => isWordList(value) && value.length > 0

/** What makes the config unusable here, as "<key>: <problem>" lines; empty when the stage can run. */
function configProblems(value) {
  if (value === undefined) return ['args.config: missing']
  if (!isObject(value)) return ['args.config: not a JSON object']
  const problems = Object.entries(CONFIG_KEYS)
    .filter(([key, kind]) => kindOf(valueAt(value, key)) !== kind)
    .map(([key, kind]) => `${key}: expected ${KIND_NAMES[kind]}`)
  if (problems.length) return problems
  const { domains, sensitivePaths, limits } = value.delivery
  if (Object.keys(domains).length === 0) problems.push('delivery.domains: needs at least one domain')
  for (const [name, domain] of Object.entries(domains)) {
    const gate = typeof domain?.gate === 'string' ? domain.gate.trim() : ''
    if (!isObject(domain) || !isFilledList(domain.owns) || typeof domain.proof !== 'string' || !gate) {
      problems.push(`delivery.domains.${name}: needs owns (a list of globs), proof and gate`)
    }
  }
  for (const [area, globs] of Object.entries(sensitivePaths)) if (!isFilledList(globs)) problems.push(`delivery.sensitivePaths.${area}: expected a list of globs`)
  for (const key of ['readPaths', 'mcpServers']) if (!isWordList(value.verify[key])) problems.push(`verify.${key}: expected a list of strings`)
  if (!value.verify.commands.every(isFilledList)) problems.push('verify.commands: expected a list of commands, each a list of words')
  for (const key of ['maxLanes', 'maxParallelBuilders']) if (limits[key] < 1) problems.push(`delivery.limits.${key}: must be at least 1`)
  if (limits.maxAgentsPerRun < 2) problems.push('delivery.limits.maxAgentsPerRun: ship needs at least 2, because verify starts the verifier and the reviewer together')
  return problems
}

const configIssues = configProblems(config)
if (configIssues.length) {
  return brief({ status: 'blocked', headline: 'ship-stage needs the resolved project config in args.config', evidence: configIssues, next: {
    note: 'Run /falsifiable:ship <id>: it resolves .claude/falsifiable.json with scripts/config.mjs and passes the result as config. If that script reports a problem, fix the file first.',
  } })
}
// ── end config ──

const { delivery, guard, verify, review } = config
const LIMITS = delivery.limits
const DOMAINS = delivery.domains
const MAX_LANES = Math.min(LIMITS.maxLanes, MAX_AGENTS_PER_RUN) // a build run starts one builder per lane
const MAX_SCOUTS = Math.min(LIMITS.maxScouts, MAX_AGENTS_PER_RUN - 1) // the planner needs the last place
const MAX_PARALLEL_BUILDERS = LIMITS.maxParallelBuilders // builders, and so test runs, at the same time
const MAX_FIX_LANES = Math.min(LIMITS.maxParallelBuilders, MAX_AGENTS_PER_RUN) // one wave of builders per fix round; the rest wait
const MAX_FIX_ROUNDS = LIMITS.maxFixRounds
const CHANGE_DIR = `${delivery.specsDir}/changes/${input.id}`
// The verifier drives only a local app, never production. A browser reads a backslash as a slash and drops
// tabs, newlines and leading spaces, so "/\host", "/\t/host" and " //host" all reach another host: none of them
// may appear, in a URL or in a path on the app.
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^\\\x00-\x20\x7f]*)?$/
const APP_PATH = /^\/(?![/\\])[^\\\x00-\x20\x7f]*$/
/** True for a local URL, or a path on the app at the base URL ("/settings"). */
const onLocalApp = (item) => LOCAL_URL.test(item) || APP_PATH.test(item)
/** True for a path relative to the repository root, with forward slashes and no `.` or `..` folder: globs compare such paths only. */
const isRepositoryPath = (path) => !/\\|^[A-Za-z]:|^\/|(^|\/)\.\.?(\/|$)/.test(String(path).replace(/^\.\//, ''))
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/ // change and lane ids become branch names
const SAFE_REF = /^[\w./-]+$/
const KINDS = ['feature', 'fix']
const PROOFS = ['product', 'unit', 'review']
const SEVERITY_ORDER = ['P0', 'FAIL', 'P1']

const PLAN_SCHEMA = record({
  id: text,
  lanes: { type: 'array', minItems: 1, items: record({
    id: { type: 'string', description: 'lowercase words joined by hyphens; it names the branch lane/<id>/<lane>' },
    domain: { enum: Object.keys(DOMAINS) },
    goal: text,
    owns: { type: 'array', minItems: 1, items: { type: 'string', description: 'a file, or a folder written as folder/**' } },
    reads: texts,
    scenarios: { type: 'array', items: { type: 'string', description: 'names of the scenarios this lane makes true' } },
    reproduction: { type: 'string', description: 'kind fix, first lane: the failing test or command that shows the bug' },
  }, ['reproduction']) },
  contracts: { type: 'array', items: record({ name: text, owner: { type: 'string', description: 'the one lane that may change it' }, detail: text }) },
  scenarios: { type: 'array', items: record({ name: text, proof: { enum: PROOFS }, detail: text }) },
  openQuestions: { type: 'array', items: record({
    id: text, question: text, options: { type: 'array', minItems: 2, items: text }, recommendation: text, why: text,
    priority: { type: 'integer', minimum: 1, description: '1 is the most important' },
  }) },
})

const LANE_REPORT_SCHEMA = record({
  lane: text, status: { enum: ['done', 'blocked'] }, branch: text, headSha: text, base: text,
  diffNameOnly: { type: 'string', description: 'the literal output of git diff --name-only --no-renames <base>...HEAD' },
  newTests: { type: 'array', items: record({
    file: text, name: text, redCommand: text,
    redExitCode: { type: 'integer', description: 'exit code of the red run, before the code existed' },
    redExcerpt: { type: 'string', description: 'the failure lines of the red run' },
    greenExitCode: { type: 'integer' },
  }) },
  checks: { type: 'array', items: record({
    command: text, exitCode: { type: 'integer' },
    expect: { enum: ['pass', 'fail'], description: "'fail' for a red run before the code or a planted mutant; 'pass' for every other check" },
  }) },
  summary: text, blockedReason: text,
}, ['blockedReason'])

const VERDICT_SCHEMA = record({
  overall: { enum: ['PASS', 'FAIL', 'BLOCKED'] },
  scenarios: { type: 'array', items: record({
    scenario: text, result: { enum: ['PASS', 'FAIL', 'BLOCKED'] },
    evidence: { type: 'array', minItems: 1, items: text },
    expected: text, actual: text, steps: texts,
  }, ['expected', 'actual', 'steps']) },
  regressions: texts,
})

const FACT = record({ claim: text, evidence: { type: 'string', description: 'file:line, or a URL' } })
const SCOUT_SCHEMA = record({ answer: text, facts: { type: 'array', items: FACT }, gaps: texts })

// ── sensitive areas: a lane that owns a path in one waits for the user's decision before any builder starts ──
// The guard's protected paths are always one of them, and the guard matches them at any folder depth.
const GUARDRAILS = 'agent guardrails'
const SENSITIVE_AREAS = {
  ...delivery.sensitivePaths,
  [GUARDRAILS]: [...new Set([...(delivery.sensitivePaths[GUARDRAILS] ?? []), ...guard.protectedPaths])],
}

// A glob with ** before its last name (**/billing/**, **/*.sql, api/**/keys/**) names a folder or file at any depth.
const atAnyDepth = (glob) => segmentsOf(glob).slice(0, -1).includes('**')
// What an owned path names itself: its ** folders left out, so api/new/** names api/new and nothing below it.
const named = (owned) => segmentsOf(owned).filter((segment) => segment !== '**').join('/')

// True when the plan must ask about a lane that owns `owned` and the sensitive `glob`. A glob anchored at the root is
// hit by any overlap: a lane that owns api/** can write api/billing/. A glob at any depth, and each guardrail glob (the
// guard matches those at any depth too), is hit only when the owned path names it, as api/src/billing/** names billing;
// a lane that writes into such a folder under one it owns fails its report check instead (areasOfFile).
function ownsSensitive(owned, glob, guardrail) {
  if (guardrail) return overlaps(owned, glob) || overlaps(named(owned), `**/${glob}`)
  return atAnyDepth(glob) ? overlaps(named(owned), glob) : overlaps(owned, glob)
}

/** The sensitive areas a lane touches, sorted, and its owned paths in them; null when it touches none. */
function sensitiveArea(lane) {
  const hits = Object.entries(SENSITIVE_AREAS)
    .map(([area, globs]) => [area, lane.owns.filter((owned) => globs.some((glob) => ownsSensitive(owned, glob, area === GUARDRAILS)))])
    .filter(([, paths]) => paths.length)
  return hits.length ? { areas: hits.map(([area]) => area).sort(), paths: [...new Set(hits.flatMap(([, paths]) => paths))] } : null
}

/** The sensitive areas a changed file lies in; guardrail globs match at any folder depth, as the guard matches them. */
const areasOfFile = (file) => Object.entries(SENSITIVE_AREAS)
  .filter(([area, globs]) => globs.some((glob) => (area === GUARDRAILS ? matchesAtAnyDepth(glob, file) : matches(glob, file))))
  .map(([area]) => area)

// The decision names the lane's areas, so an approval does not carry over to a re-plan that made the lane more sensitive.
const laneDecision = (lane, hit = sensitiveArea(lane)) => hit && `lane:${lane.id}:${hit.areas.join('+')}`

// ── plan checks: run on the planner's plan, and again on the plan each later stage receives ──
function planProblems(plan) {
  if (!plan || !Array.isArray(plan.lanes) || !Array.isArray(plan.scenarios)) return ['the plan is missing or malformed']
  const { lanes } = plan
  const problems = []
  if (plan.id !== input.id) problems.push(`the plan is for change ${plan.id}, not ${input.id}`)
  if (lanes.length < 1 || lanes.length > MAX_LANES) problems.push(`a plan has 1 to ${MAX_LANES} lanes; this one has ${lanes.length}`)
  lanes.forEach((lane, i) => {
    if (!SAFE_NAME.test(String(lane.id))) problems.push(`lane ${i + 1} has an id that cannot name a branch: ${JSON.stringify(lane.id)}`)
    else if (lanes.findIndex((other) => other.id === lane.id) !== i) problems.push(`two lanes are called ${lane.id}`)
    if (!Object.hasOwn(DOMAINS, String(lane.domain))) problems.push(`lane ${lane.id} has an unknown domain ${JSON.stringify(lane.domain)}`)
    if (!Array.isArray(lane.owns) || lane.owns.length === 0) problems.push(`lane ${lane.id} owns no paths`)
  })
  if (problems.length) return problems
  for (const lane of lanes) for (const owned of lane.owns) {
    const domain = DOMAINS[lane.domain]
    if (!isRepositoryPath(owned)) problems.push(`lane ${lane.id} owns ${owned}, which is not a relative path inside the repository`)
    else if (!domain.owns.some((glob) => contains(glob, owned))) {
      problems.push(`lane ${lane.id} owns ${owned}, which is not inside the ${lane.domain} domain (${domain.owns.join(', ')})`)
    }
  }
  lanes.forEach((a, i) => lanes.slice(i + 1).forEach((b) => {
    for (const x of a.owns) for (const y of b.owns) {
      if (overlaps(x, y)) problems.push(`${x === y ? `${x} is` : `${x} and ${y} are`} owned by lanes ${a.id} and ${b.id}`)
    }
  }))
  const served = new Set(lanes.flatMap((lane) => lane.scenarios ?? []))
  const named = new Set(plan.scenarios.map((s) => s.name))
  for (const s of plan.scenarios) {
    if (!PROOFS.includes(s.proof)) problems.push(`scenario "${s.name}" has no proof (product, unit or review)`)
    else if (s.proof !== 'review' && !served.has(s.name)) problems.push(`scenario "${s.name}" is proven by ${s.proof}, but no lane serves it`)
  }
  for (const lane of lanes) for (const name of lane.scenarios ?? []) {
    if (!named.has(name)) problems.push(`lane ${lane.id} serves "${name}", which the plan's scenario map does not list`)
  }
  for (const c of plan.contracts ?? []) {
    if (!lanes.some((lane) => lane.id === c.owner)) problems.push(`contract ${c.name} is owned by ${c.owner}, which is not a lane`)
  }
  if (input.kind === 'fix' && !String(lanes[0].reproduction ?? '').trim()) {
    problems.push('a fix plan must start from a failing reproduction: the first lane names the failing test or command in its reproduction field')
  }
  return problems
}

// A sensitive lane builds only on the first answer (trimmed, any case); any other answer sends the plan back.
const BUILD_AS_PLANNED = 'Build as planned'
const SEND_PLAN_BACK = 'Send the plan back'
const approves = (answer) => String(answer ?? '').trim().toLowerCase() === BUILD_AS_PLANNED.toLowerCase()

const answers = new Map((Array.isArray(input.decisions) ? input.decisions : [])
  .filter((d) => d && String(d.answer ?? '').trim())
  .map((d) => [d.about, String(d.answer).trim()]))

/** Decisions the plan still needs from the user: sensitive lanes first, then open questions by priority. */
function pendingDecisions(plan) {
  const lanes = plan.lanes.flatMap((lane) => {
    const hit = sensitiveArea(lane)
    if (!hit) return []
    const areas = hit.areas.join(' and ')
    const unlock = hit.areas.includes(GUARDRAILS)
      ? ` The guard also blocks writes to ${GUARDRAILS} unless you start the session with ${guard.unlockEnv}=1.`
      : ''
    return [{
      about: laneDecision(lane, hit),
      question: `Lane ${lane.id} changes ${areas} (${hit.paths.join(', ')}). Build it as planned?`,
      options: [BUILD_AS_PLANNED, SEND_PLAN_BACK],
      recommendation: `Read the lane in tasks.md and answer "${BUILD_AS_PLANNED}" if it matches the approved proposal`,
      why: `${areas} ${hit.areas.length > 1 ? 'are sensitive areas' : 'is a sensitive area'}: no code is written there without your decision.${unlock}`,
    }]
  })
  const questions = [...(plan.openQuestions ?? [])].sort((a, b) => a.priority - b.priority).map((q) => ({
    about: `question:${q.id}`, question: q.question, options: q.options, recommendation: q.recommendation, why: q.why,
  }))
  return [...lanes, ...questions].filter((d) => !answers.has(d.about))
}

const commonArgs = (plan) => ({ id: input.id, base: input.base, kind: input.kind ?? 'feature', plan, decisions: input.decisions })
const rerunArgs = (plan) => ({ ...commonArgs(plan), stage: input.stage, round: input.round, defects: input.defects, reports: input.reports })
const describeDefect = (d) => `${d.severity} ${d.lane ?? 'no lane'} ${d.where}: ${d.problem} (evidence: ${d.evidence})`

const blocked = (headline, evidence = [], next = { note: 'Correct the args and run the stage again.' }) => brief({ status: 'blocked', headline, evidence, next })
const blockedPlan = (problems) =>
  blocked('The plan cannot be built as it stands', problems, { note: 'Re-plan with the plan stage, or correct tasks.md and pass the corrected plan.' })

/** Why no builder may start yet: a decision is missing, or the user did not approve a sensitive lane. Null when builders may start. */
function decisionStop(plan) {
  const pending = pendingDecisions(plan)
  const stage = input.stage === 'plan' ? 'build' : input.stage
  if (pending.length) {
    const note = `Record each answer and its reason in ${CHANGE_DIR}/design.md, then run the ${stage} stage with these args plus decisions: [{about, answer}].`
    return brief({ status: 'needs-decision', headline: `${pending.length} decision(s) from the user are needed before any builder starts`,
      decisions: pending, evidence: pending.map((d) => d.question), next: { stage, args: { ...rerunArgs(plan), stage }, note } })
  }
  const sentBack = plan.lanes.filter((lane) => sensitiveArea(lane) && !approves(answers.get(laneDecision(lane))))
  if (!sentBack.length) return null
  return blocked(`The user sent lane(s) ${sentBack.map((lane) => lane.id).join(', ')} back: the plan goes back to the planner`,
    sentBack.map((lane) => `lane ${lane.id}: the user answered "${answers.get(laneDecision(lane))}", not "${BUILD_AS_PLANNED}"`),
    { stage: 'plan', args: { id: input.id, base: input.base, kind: input.kind ?? 'feature', stage: 'plan' },
      note: `No builder started. Record the answer and its reason in ${CHANGE_DIR}/design.md, then run the plan stage again.` })
}

/** A run that stops for the user: one decision, the evidence behind it, and no builder started. */
const askUser = (headline, decision, evidence) =>
  brief({ status: 'needs-decision', headline, decisions: [decision], evidence, next: { note: 'No builder started; the head acts on the answer.' } })

// ── builders ──
function builderPrompt(plan, lane, defects) {
  const domain = DOMAINS[lane.domain]
  const proof = new Map(plan.scenarios.map((s) => [s.name, s.proof]))
  const lines = [
    `Change: ${input.id} (${input.kind === 'fix' ? 'bug fix' : 'feature'})`,
    `Change folder (read it; never write it): ${CHANGE_DIR}/`,
    `Lane: ${lane.id}`,
    `Goal: ${lane.goal}`,
    `Base branch: ${input.base}`,
    `Lane branch: lane/${input.id}/${lane.id}`,
    `Changed files for the report: git diff --name-only --no-renames ${input.base}...HEAD (a moved file shows its old path too)`,
    `Owned paths (the only ones you may change): ${lane.owns.join(', ')}`,
    `Read-only paths: ${(lane.reads ?? []).join(', ') || 'none named'}`,
    `Scenarios: ${(lane.scenarios ?? []).map((name) => `${name} [${proof.get(name)}]`).join('; ') || 'none'}`,
    `Shared contracts: ${(plan.contracts ?? []).map((c) => `${c.name} (owner ${c.owner}): ${c.detail}`).join('; ') || 'none'}`,
    `Proof in the ${lane.domain} domain: ${domain.proof}`,
    `Gate (run it, and list that run in checks; a lane without a passing gate run fails): ${domain.gate}`,
  ]
  if (domain.escalate) lines.push(`Ask the user first (stop and report blocked if the lane needs it): ${domain.escalate}`)
  if (answers.has(laneDecision(lane))) lines.push(`Decision from the user: ${answers.get(laneDecision(lane))}`)
  for (const q of plan.openQuestions ?? []) {
    if (answers.has(`question:${q.id}`)) lines.push(`Answer from the user to "${q.question}": ${answers.get(`question:${q.id}`)}`)
  }
  if (input.kind === 'fix' && lane.reproduction) lines.push(`Reproduce first: ${lane.reproduction}. It must fail before you change any code.`)
  if (defects) lines.push(`Defects to fix (fix round ${input.round}):`, JSON.stringify(defects, null, 2))
  return lines.join('\n')
}

const SHELL_TOKEN = /'([^']*)'|"([^"]*)"|([;&|\n])|([^\s'";&|]+)/g

/** The simple commands of a shell line, each as its words: split at ; & | and line ends outside quotes. */
function simpleCommands(line) {
  const commands = [[]]
  for (const [, single, double, separator, bare] of String(line).matchAll(SHELL_TOKEN)) {
    if (separator) commands.push([])
    else commands.at(-1).push(single ?? double ?? bare)
  }
  return commands.filter((words) => words.length)
}

/** A simple command's words after its leading VAR=value assignments; none when it is only assignments. */
function withoutAssignments(words) {
  const start = words.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word))
  return start === -1 ? [] : words.slice(start)
}

/** True when `command` runs `gate`: the gate's commands start consecutive simple commands of it, after any assignments. */
function runsGate(command, gate) {
  const said = simpleCommands(command).map(withoutAssignments)
  const wanted = simpleCommands(gate).map(withoutAssignments)
  const startsWith = (words, prefix) => prefix.every((word, i) => words[i] === word)
  return wanted.length > 0 && said.some((_, at) => wanted.every((prefix, i) => said[at + i] && startsWith(said[at + i], prefix)))
}

/** Why a lane report cannot be accepted. Self-reported evidence is checked for shape here and for truth by the reviewer. */
function reportProblems(plan, lane, report) {
  if (!report) return ['the builder returned no report']
  if (report.status === 'blocked') return [`the builder is blocked: ${report.blockedReason || report.summary}`]
  const problems = []
  const branch = `lane/${input.id}/${lane.id}`
  if (report.branch !== branch) problems.push(`it reports branch ${report.branch}, not ${branch}`)
  const changed = report.diffNameOnly.split('\n').map((line) => line.trim()).filter(Boolean)
  if (changed.length === 0) problems.push('its diff output lists no changed files')
  // A changed file is a path, never a glob. The lane's owned paths lie inside its domain (planProblems), so its files do too.
  const approved = sensitiveArea(lane)?.areas ?? []
  for (const file of changed) {
    if (!lane.owns.some((owned) => matches(owned, file))) {
      problems.push(`changed ${file}, which the lane does not own`)
      continue
    }
    for (const area of areasOfFile(file).filter((a) => !approved.includes(a))) {
      problems.push(`changed ${file}, which is in the sensitive area ${area} that its decision did not cover`)
    }
  }
  const { gate } = DOMAINS[lane.domain]
  if (!report.checks.some((c) => c.expect === 'pass' && c.exitCode === 0 && runsGate(c.command, gate))) problems.push(`no passing run of the gate ${gate}`)
  const servesUnit = plan.scenarios.some((s) => s.proof === 'unit' && (lane.scenarios ?? []).includes(s.name))
  if (servesUnit && report.newTests.length === 0) problems.push('it serves a unit scenario but reports no new test')
  for (const t of report.newTests) {
    if (!changed.includes(t.file.trim())) problems.push(`new test ${t.name} is in ${t.file}, which the lane's diff does not list`)
    if (!t.redCommand.trim() || t.redExitCode === 0 || !t.redExcerpt.trim()) {
      problems.push(`new test ${t.name} (${t.file}) has no red run: the command, a non-zero exit code and a failure excerpt from before the change`)
    } else if (t.greenExitCode !== 0) problems.push(`new test ${t.name} (${t.file}) does not pass: exit code ${t.greenExitCode}`)
  }
  // A red run or a planted mutant must fail; every other check must pass. A mutant that passes proves nothing.
  for (const c of report.checks) {
    if (c.expect === 'fail' && c.exitCode === 0) problems.push(`check \`${c.command}\` was expected to fail but exited 0`)
    else if (c.expect !== 'fail' && c.exitCode !== 0) problems.push(`check \`${c.command}\` exited ${c.exitCode}`)
  }
  return problems
}

/** One builder per lane, at most MAX_PARALLEL_BUILDERS at a time; results come back in plan order. */
async function runBuilders(plan, lanes, phaseTitle, defectsByLane = {}) {
  const queue = [...lanes]
  const results = new Map()
  const worker = async () => {
    while (queue.length) {
      const lane = queue.shift()
      const report = await startAgent(builderPrompt(plan, lane, defectsByLane[lane.id]), {
        label: `builder:${lane.id}`, phase: phaseTitle, agentType: 'falsifiable:builder', isolation: 'worktree', schema: LANE_REPORT_SCHEMA,
      }).catch(() => null)
      results.set(lane.id, { lane, report, problems: reportProblems(plan, lane, report) })
    }
  }
  await parallel(Array.from({ length: Math.min(MAX_PARALLEL_BUILDERS, lanes.length) }, () => worker))
  return plan.lanes.filter((lane) => results.has(lane.id)).map((lane) => results.get(lane.id))
}

// Every accepted report, in plan lane order and, within a lane, build before fix rounds; one report passed twice is kept
// once. The reviewer compares the whole change with all of them, so a fix round adds its report and never replaces one.
function allReports(plan, accepted) {
  const unique = new Map([...(Array.isArray(input.reports) ? input.reports : []), ...accepted].map((r) => [`${r.lane}@${r.headSha}`, r]))
  return plan.lanes.flatMap((lane) => [...unique.values()].filter((r) => r.lane === lane.id))
}

/** The brief after builders ran; `deferred` are defects of lanes a fix round left for the next round. */
function afterBuilders(plan, results, nextRound, deferred = []) {
  const built = results.filter((r) => r.problems.length === 0)
  const failed = results.filter((r) => r.problems.length > 0)
  const reports = allReports(plan, built.map((r) => r.report))
  const done = built.map((r) => `${r.lane.id}: ${r.report.summary} (${r.report.headSha.slice(0, 7)}, ${r.report.newTests.length} new test(s))`)
  if (failed.length) {
    const retry = input.stage === 'build' ? { lanes: failed.map((r) => r.lane.id) } : {}
    return brief({
      status: 'blocked',
      headline: `${failed.length} of ${results.length} lane(s) failed their checks`,
      done,
      evidence: failed.flatMap((r) => r.problems.map((problem) => `${r.lane.id}: ${problem}`)),
      next: { stage: input.stage, args: { ...rerunArgs(plan), ...retry, reports }, note: 'Fix the cause or the plan, then run the stage again; lane branches are reused.' },
    })
  }
  // Every lane in plan order: a lane built in an earlier run still needs merging, and an already merged one is a no-op.
  const merged = plan.lanes.map((lane) => lane.id).join(' ')
  return brief({
    status: 'built',
    headline: `${built.length} lane(s) built; every report passed its checks`,
    done,
    evidence: [...built.flatMap((r) => r.report.checks.map((c) => `${r.lane.id}: ${c.command} exited ${c.exitCode}`)),
      ...deferred.map((d) => `deferred to the next fix round: ${describeDefect(d)}`)],
    next: {
      stage: 'verify', args: { ...commonArgs(plan), stage: 'verify', reports, round: nextRound, defects: deferred.length ? deferred : undefined },
      note: `On ${input.base}, merge the lanes in plan order with the merge-lanes script of the plugin: merge-lanes.mjs ${input.id} ${merged}. Then run the verify stage with these args.`,
    },
  })
}

// ── verification ──
const evidenceOf = (s) => [...s.evidence, ...(s.steps?.length ? [`steps: ${s.steps.join(' > ')}`] : [])].join('; ')

/** Typed defects: what a fix-round builder receives. lane is null when no lane owns the defect, as for a regression from the sweep. */
function defectsFrom(plan, results, findings, regressions) {
  const laneServing = (scenario) => plan.lanes.find((lane) => (lane.scenarios ?? []).includes(scenario))?.id ?? null
  const laneOwning = (file) => plan.lanes.find((lane) => lane.owns.some((owned) => matches(owned, file)))?.id ?? null
  const failed = results.filter((s) => s.result === 'FAIL').map((s) => ({
    source: 'verify', lane: laneServing(s.scenario), severity: 'FAIL', where: s.scenario, rule: '',
    problem: `expected ${s.expected ?? 'the scenario to hold'}, got ${s.actual ?? 'something else'}`, evidence: evidenceOf(s), fix: '',
  }))
  const swept = regressions.map((problem) => ({
    source: 'verify', lane: null, severity: 'FAIL', where: 'regression sweep', rule: 'verify:regression',
    problem, evidence: `the verifier saw it in the regression sweep of ${verify.sweep.join(', ') || 'the app'}`, fix: '',
  }))
  const mismatch = findings.diffMatchesReports.ok ? [] : [{
    source: 'review', lane: null, severity: 'P0', where: 'lane reports', rule: 'review:diff-matches-reports',
    problem: findings.diffMatchesReports.detail, evidence: 'the reviewer compared the diff with the lane reports',
    fix: 'find out which report is wrong before fixing anything else',
  }]
  const serious = findings.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1').map((f) => ({
    source: 'review', lane: laneOwning(f.file), severity: f.severity, where: `${f.file}:${f.line}`, rule: f.rule,
    problem: f.problem, evidence: `${f.file}:${f.line}`, fix: f.fix,
  }))
  return [...failed, ...swept, ...mismatch, ...serious]
}

// ── stages ──
async function planStage() {
  phase('Plan')
  const asked = (Array.isArray(input.scoutQuestions) ? input.scoutQuestions : []).map((q) =>
    typeof q === 'string' ? { question: q, paths: [] } : { question: String(q.question), paths: Array.isArray(q.paths) ? q.paths : [] })
  if (asked.length > MAX_SCOUTS) log(`Only ${MAX_SCOUTS} scout(s) run per plan; not asked: ${asked.slice(MAX_SCOUTS).map((q) => q.question).join(' | ')}`)
  const facts = await parallel(asked.slice(0, MAX_SCOUTS).map((q, i) => () => startAgent(
    `Question: ${q.question}\nPaths in scope: ${q.paths.join(', ') || 'the whole repository'}`,
    { label: `scout:${i + 1}`, phase: 'Plan', agentType: 'falsifiable:scout', schema: SCOUT_SCHEMA },
  )))
  const prompt = [
    `Change: ${input.id} (${input.kind === 'fix' ? 'a bug fix' : 'a feature'})`,
    `Change folder: ${CHANGE_DIR}/`,
    `Write the plan into ${CHANGE_DIR}/tasks.md, one group per lane, and return the same plan.`,
    `Limits: 1 to ${MAX_LANES} lanes; no path owned by two lanes; every owned path inside its lane's domain;`
      + ' a lane owns files, or folders written as folder/**; lane ids are lowercase words joined by hyphens.',
    'Domains (the paths they cover: how a change is proven; the gate; what to ask the user first):',
    ...Object.entries(DOMAINS).map(([name, d]) => `- ${name} (${d.owns.join(', ')}): ${d.proof}; ${d.gate}; ${d.escalate || 'nothing named'}`),
    "Sensitive areas (a lane that owns a path in one waits for the user's decision before build):",
    ...Object.entries(SENSITIVE_AREAS).map(([area, globs]) => `- ${area}: ${globs.join(', ')}${area === GUARDRAILS ? ' (at any folder depth)' : ''}`),
    ...(input.kind === 'fix' ? ['This is a bug fix: the first lane must start from a failing reproduction. Put the failing test or command in its reproduction field.'] : []),
    ...(facts.some(Boolean) ? ['Scout facts:', JSON.stringify(facts.filter(Boolean), null, 2)] : []),
  ].join('\n')
  const plan = await startAgent(prompt, { label: 'planner', phase: 'Plan', agentType: 'falsifiable:planner', schema: PLAN_SCHEMA }).catch(() => null)
  if (!plan) return blocked('The planner returned no plan', [], { note: 'Run the plan stage again.' })
  const problems = planProblems(plan)
  if (problems.length) return blockedPlan(problems)
  const stop = decisionStop(plan)
  if (stop) return stop
  return brief({
    status: 'planned',
    headline: `Plan for ${input.id}: ${plan.lanes.length} lane(s), written to ${CHANGE_DIR}/tasks.md`,
    done: plan.lanes.map((lane) => `${lane.id} (${lane.domain}): ${lane.goal}`),
    evidence: plan.scenarios.map((s) => `${s.name}: proven by ${s.proof}`),
    next: { stage: 'build', args: { ...commonArgs(plan), stage: 'build' }, note: 'Run the build stage with these args.' },
  })
}

async function buildStage() {
  phase('Build')
  const { plan } = input
  const problems = planProblems(plan)
  if (problems.length) return blockedPlan(problems)
  const stop = decisionStop(plan)
  if (stop) return stop
  const only = Array.isArray(input.lanes) ? input.lanes : null
  const results = await runBuilders(plan, plan.lanes.filter((lane) => !only || only.includes(lane.id)), 'Build')
  return afterBuilders(plan, results, 1)
}

async function verifyStage() {
  phase('Verify')
  const { plan } = input
  const problems = planProblems(plan)
  if (problems.length) return blockedPlan(problems)
  const { baseUrl } = verify
  if (!LOCAL_URL.test(baseUrl)) {
    return blocked(`verify.baseUrl ${JSON.stringify(baseUrl)} is not a local app: its host must be localhost, 127.0.0.1 or [::1], with no backslash or space`)
  }
  const remote = [...verify.health, ...verify.sweep].filter((item) => !onLocalApp(item))
  if (remote.length) {
    return blocked('verify.health or verify.sweep names something that is not on the local app: use local URLs, or paths on the app such as /settings', remote)
  }
  const reports = Array.isArray(input.reports) ? input.reports : []
  const product = plan.scenarios.filter((s) => s.proof === 'product').map((s) => s.name)
  const signIn = verify.credentialEnv.length
    ? `Sign-in: the environment variables ${verify.credentialEnv.join(' and ')} hold the test credentials. Use them by name; never print their values.`
    : 'Sign-in: no credential variables are configured; a scenario that needs a signed-in user is BLOCKED.'
  // The verifier is blind to the build: its prompt carries no plan, report, branch or source path.
  const verifierPrompt = [
    `Change: ${input.id}`,
    `Product scenarios to judge, as written under "#### Scenario:" in ${CHANGE_DIR}/specs/:`,
    ...product.map((name) => `- ${name}`),
    `Base URL: ${baseUrl} (the app runs with local settings; never start, restart or kill a server)`,
    'A path in the lists below is on the base URL.',
    `Health checks (each must answer before any scenario runs): ${verify.health.join(', ') || 'none configured; the base URL must answer'}`,
    signIn,
    `Instruments: ${verify.instruments}`,
    verify.sweep.length
      ? `Regression sweep (load each once; report console errors and failed calls): ${verify.sweep.join(', ')}`
      : 'Regression sweep: none configured; return an empty regressions list.',
    `Readable besides the change's specs and .verify/: ${verify.readPaths.join(', ') || 'nothing'}`,
    `Commands besides curl to the base URL and housekeeping under .verify/: ${verify.commands.map((argv) => argv.join(' ')).join('; ') || 'none'}`,
    `MCP servers: ${verify.mcpServers.join(', ') || 'none'}`,
    'The guard allows you nothing else. A refused call (fence-read, fence-tool, fence-write or fence-diff) is the fence working: judge from the running app.',
  ].join('\n')
  const reviewerPrompt = [
    `Change: ${input.id}; the approved change is in ${CHANGE_DIR}/`,
    `Diff range: origin/${delivery.baseBranch}...${input.base}`,
    ...reviewSetup(review.checklist, review.secondOpinion),
    expectedWithoutReport(delivery.specsDir, input.id, false),
    'Lane reports: every accepted report, from the build and each fix round; together they must match the diff.'
      + ' Check that first, listing the changed files with git diff --name-only --no-renames:',
    JSON.stringify(reports, null, 2),
  ].join('\n')
  const [verdict, findings] = await parallel([
    () => (product.length
      ? startAgent(verifierPrompt, { label: 'verifier', phase: 'Verify', agentType: 'falsifiable:verifier', schema: VERDICT_SCHEMA })
      : { scenarios: [], regressions: [] }),
    () => startAgent(reviewerPrompt, { label: 'reviewer', phase: 'Verify', agentType: 'falsifiable:reviewer', schema: FINDINGS_SCHEMA }),
  ])
  const verifyArgs = { ...commonArgs(plan), stage: 'verify', reports, round: input.round ?? 1, defects: input.defects }
  const missing = [!verdict && 'the verifier returned nothing', !findings && 'the reviewer returned nothing'].filter(Boolean)
  if (missing.length) return blocked('Verification did not finish', missing, { stage: 'verify', args: verifyArgs, note: 'Run the verify stage again.' })

  const judged = new Map(verdict.scenarios.map((s) => [s.scenario, s]))
  const results = product.map((name) => judged.get(name) ?? { scenario: name, result: 'BLOCKED', evidence: ['the verifier did not judge it'] })
  const fresh = defectsFrom(plan, results, findings, verdict.regressions)
  // Defects a fix round deferred stay open, and one found again is listed once.
  const same = (a, b) => a.lane === b.lane && a.where === b.where && a.rule === b.rule
  const defects = [...fresh, ...(Array.isArray(input.defects) ? input.defects : []).filter((d) => !fresh.some((f) => same(f, d)))]
  const minor = findings.findings.filter((f) => f.severity === 'P2' || f.severity === 'P3')
    .map((f) => `${f.severity} ${f.file}:${f.line} [${f.rule}] ${f.problem}`)
  const unchecked = results.filter((s) => s.result === 'BLOCKED')
  if (defects.length) {
    const failedCount = defects.filter((d) => d.severity === 'FAIL').length
    return brief({
      status: 'needs-fix',
      headline: `${failedCount} failed scenario(s) or regression(s) and ${defects.length - failedCount} P0/P1 finding(s)`,
      done: results.filter((s) => s.result === 'PASS').map((s) => `${s.scenario}: PASS`),
      evidence: [...defects.map(describeDefect), ...unchecked.map((s) => `BLOCKED ${s.scenario}: ${evidenceOf(s)}`), ...minor],
      next: { stage: 'fix', args: { ...verifyArgs, stage: 'fix', defects }, note: 'Run the fix stage with these args.' },
    })
  }
  if (unchecked.length) {
    return blocked(`${unchecked.length} product scenario(s) could not be checked`, [...unchecked.map((s) => `${s.scenario}: ${evidenceOf(s)}`), ...minor], {
      stage: 'verify', args: verifyArgs,
      note: 'Fix what blocked the verifier (the app not running with local settings, missing credentials or data), then run the verify stage again.',
    })
  }
  return brief({
    status: 'verified',
    headline: product.length ? `All ${product.length} product scenario(s) pass; no P0 or P1 findings` : 'No P0 or P1 findings; the change has no product scenarios',
    done: [...results.map((s) => `${s.scenario}: PASS`), `review: ${findings.findings.length} finding(s), none P0 or P1`],
    evidence: [...results.map((s) => `${s.scenario}: ${evidenceOf(s)}`), ...(product.length ? ['regression sweep: nothing found'] : []), ...minor],
    next: { note: `Hand over: archive the change as the last commit on ${input.base} (openspec archive ${input.id} --yes when the project uses the OpenSpec CLI),`
      + ' push the branch, update the draft pull request, mark it ready, and report with this brief.' },
  })
}

async function fixStage() {
  phase('Fix')
  const { plan, round } = input
  const defects = Array.isArray(input.defects) ? input.defects : []
  if (!Number.isInteger(round) || round < 1 || defects.length === 0) return blocked('fix needs round (1 or more) and the defects from the verify brief')
  if (round > MAX_FIX_ROUNDS) {
    return askUser(`${defects.length} defect(s) are still open after ${MAX_FIX_ROUNDS} fix round(s)`, {
      about: 'fix-rounds', question: `${MAX_FIX_ROUNDS} fix round(s) did not clear ${defects.length} defect(s). How do we continue?`,
      options: ['Re-plan the affected lanes', 'One more fix round with your guidance', 'Stop and leave this change unmerged'], recommendation: 'Re-plan the affected lanes',
      why: 'Fixes on the same plan did not converge, so the plan is the likely problem',
    }, defects.map(describeDefect))
  }
  const problems = planProblems(plan)
  if (problems.length) return blockedPlan(problems)
  const orphans = defects.filter((d) => !plan.lanes.some((lane) => lane.id === d.lane))
  if (orphans.length) {
    return askUser(`${orphans.length} defect(s) belong to no lane`, {
      about: 'orphan-defects', question: 'No lane owns these defects. Who fixes them?',
      options: ['Re-plan with a lane that owns them', 'Answer them in the pull request as not defects'], recommendation: 'Re-plan with a lane that owns them',
      why: 'A builder may only change the paths its lane owns',
    }, orphans.map(describeDefect))
  }
  const stop = decisionStop(plan)
  if (stop) return stop
  const rank = (lane) => Math.min(...defects.filter((d) => d.lane === lane.id).map((d) => {
    const i = SEVERITY_ORDER.indexOf(d.severity)
    return i === -1 ? SEVERITY_ORDER.length : i
  }))
  const affected = plan.lanes.filter((lane) => defects.some((d) => d.lane === lane.id)).sort((a, b) => rank(a) - rank(b))
  const now = affected.slice(0, MAX_FIX_LANES)
  const later = affected.slice(MAX_FIX_LANES)
  if (later.length) log(`Fixing ${now.map((l) => l.id).join(', ')} this round; ${later.map((l) => l.id).join(', ')} waits for the next round`)
  const byLane = Object.fromEntries(now.map((lane) => [lane.id, defects.filter((d) => d.lane === lane.id)]))
  const results = await runBuilders(plan, now, 'Fix', byLane)
  return afterBuilders(plan, results, round + 1, defects.filter((d) => later.some((lane) => lane.id === d.lane)))
}

const STAGES = { plan: planStage, build: buildStage, verify: verifyStage, fix: fixStage }
const PROTECTED_BRANCHES = [delivery.baseBranch, ...guard.protectedBranches]
// Branch names compare without letter case: on a case-insensitive file system Main and main are one branch.
const isProtectedBranch = (branch) =>
  typeof branch === 'string' && PROTECTED_BRANCHES.some((glob) => matches(glob.toLowerCase(), branch.toLowerCase()))

const refusal =
  (!SAFE_NAME.test(String(input.id ?? '')) && `ship needs the id of an approved change, not ${JSON.stringify(input.id)}`) ||
  (!Object.hasOwn(STAGES, String(input.stage)) && `ship has no stage ${JSON.stringify(input.stage)}; use plan, build, verify or fix`) ||
  (input.kind !== undefined && !KINDS.includes(input.kind) && `ship has no kind ${JSON.stringify(input.kind)}; use feature or fix`) ||
  (input.stage !== 'plan' && !SAFE_REF.test(String(input.base ?? '')) && 'ship needs base: the change branch the lanes start from and merge into') ||
  (isProtectedBranch(input.base) && `base ${input.base} is a protected branch; pass the change branch the lanes start from and merge into`)
return refusal ? blocked(refusal) : await STAGES[input.stage]()
