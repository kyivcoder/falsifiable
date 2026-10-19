// A fake Claude Code workflow runtime for unit tests.
//
// It runs a workflow script (workflows/*.js) in Node with scripted agent
// results, so a test can assert the orchestration: which agents start, with
// which prompts and options, and what the run returns. It keeps the real
// runtime's rules that matter for correctness:
//   - `meta` must be the first statement and a pure literal;
//   - the body is plain JavaScript with top-level await and return, and no
//     module loading;
//   - Date.now(), Math.random() and an argument-less Date throw;
//   - parallel() and pipeline() turn a failure into null instead of rejecting;
//   - every agent schema uses only the keywords the runtime accepts, and every
//     agent result is checked against the schema of its call.
//
// A scripted result that breaks its schema, a schema the real runtime would
// refuse, or an agent nobody scripted is a mistake in the test, not in the
// workflow, so runWorkflow() rejects for it even when the script swallowed the
// error inside parallel().
//
//   const run = await runWorkflow(loadWorkflow('workflows/ship-stage.js'), {
//     args: { id: 'x', stage: 'plan', config },
//     agents: { planner: PLAN },          // by label, or (call) => result
//   });
//   run.result, run.error, run.calls, run.logs, run.phases, run.maxConcurrent
import { readFileSync } from 'node:fs';

import { RUNTIME_KEYWORDS, checkSchema, validate } from '../../lib/schema.mjs';

const META_START = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(export)\s+const\s+meta\s*=\s*/;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const SCRIPT_GLOBALS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'Date', 'Math', 'process'];
const DEFAULT_BUDGET = Object.freeze({ total: null, spent: () => 0, remaining: () => Infinity });

/** Index just past the string or template literal that starts at `i`. */
function endOfQuoted(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === quote) return j + 1;
  }
  throw new Error('meta has an unterminated string');
}

/** Index just past a comment that starts at `i`, or -1 when none starts there. */
function endOfComment(text, i) {
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end + 1;
  }
  if (text.startsWith('/*', i)) return text.indexOf('*/', i) + 2;
  return -1;
}

/** The `{...}` that starts at `start`, matched by brackets outside strings and comments. */
function readLiteral(source, start) {
  if (source[start] !== '{') throw new Error('meta must be an object literal');
  let depth = 0;
  for (let i = start; i < source.length; ) {
    const c = source[i];
    const comment = endOfComment(source, i);
    if (comment !== -1) i = comment;
    else if (c === "'" || c === '"' || c === '`') i = endOfQuoted(source, i);
    else {
      if (c === '{' || c === '[') depth += 1;
      if (c === '}' || c === ']') depth -= 1;
      i += 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error('meta is not closed');
}

/** Why `literal` is not a pure object literal, or null when it is. */
function impurity(literal) {
  for (let i = 0; i < literal.length; ) {
    const c = literal[i];
    const rest = literal.slice(i);
    const comment = endOfComment(literal, i);
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (/\s/.test(c) || '{}[]:,'.includes(c)) i += 1;
    else if (comment !== -1) i = comment;
    else if (c === "'" || c === '"' || c === '`') {
      const end = endOfQuoted(literal, i);
      if (c === '`' && literal.slice(i, end).includes('${')) return 'a template interpolation';
      i = end;
    } else if (number) i += number[0].length;
    else if (word) {
      const isKey = literal.slice(i + word[0].length).trimStart().startsWith(':');
      if (!isKey && !['true', 'false', 'null'].includes(word[0])) return `the name "${word[0]}"`;
      i += word[0].length;
    } else return `"${c}"`;
  }
  return null;
}

/** Parses a workflow's source into {file, meta, body}; throws when the real runtime would refuse it. */
export function parseWorkflow(source, file = '<source>') {
  const start = META_START.exec(source);
  if (!start) throw new Error(`${file}: \`export const meta = {...}\` must be the first statement`);
  const literal = readLiteral(source, start[0].length);
  const why = impurity(literal);
  if (why) throw new Error(`${file}: meta must be a pure literal, but it contains ${why}`);
  const meta = new Function(`"use strict"; return (${literal});`)();
  for (const key of ['name', 'description']) {
    if (typeof meta[key] !== 'string' || meta[key] === '') throw new Error(`${file}: meta needs a ${key}`);
  }
  const exportAt = start.index + start[0].indexOf(start[1]);
  const body = source.slice(0, exportAt) + source.slice(exportAt + 'export'.length);
  if (/\bimport\s*\(/.test(body)) throw new Error(`${file}: a workflow script cannot import modules`);
  return { file, meta, body };
}

/** Reads and parses a workflow file. */
export function loadWorkflow(file) {
  return parseWorkflow(readFileSync(file, 'utf8'), file);
}

const refuse = (what) => () => {
  throw new Error(`${what} is not available in a workflow script; pass the value in through args`);
};

// Date and Math as a script sees them: no clock and no randomness, so a resumed run repeats its calls.
const ScriptDate = new Proxy(Date, {
  apply: refuse('Date()'),
  construct(target, argList, newTarget) {
    if (argList.length === 0) refuse('new Date() without arguments')();
    return Reflect.construct(target, argList, newTarget);
  },
  get: (target, key, receiver) => (key === 'now' ? refuse('Date.now()') : Reflect.get(target, key, receiver)),
});
const ScriptMath = Object.create(Math, { random: { value: refuse('Math.random()') } });

/** The agent() global: records the call, checks its schema and answers from the scripted results. */
function makeAgent(options, state) {
  const mistake = (message) => {
    state.mistakes.push(message);
    return new Error(message);
  };
  return async (prompt, opts = {}) => {
    const call = { index: state.calls.length, prompt, opts, label: opts.label ?? null };
    state.calls.push(call);
    const name = call.label ?? `#${call.index}`;
    if (opts.schema) {
      const problems = checkSchema(opts.schema, RUNTIME_KEYWORDS);
      if (problems.length) throw mistake(`agent "${name}" has a schema the runtime would refuse: ${problems.join('; ')}`);
    }
    state.inFlight += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const { agents } = options;
      let entry;
      if (typeof agents === 'function') entry = agents(call);
      else if (agents && call.label !== null && Object.hasOwn(agents, call.label)) entry = agents[call.label];
      if (typeof entry === 'function') entry = entry(call);
      entry = await entry;
      if (entry === undefined) throw mistake(`no scripted result for agent "${name}"`);
      if (entry instanceof Error) throw entry;
      if (entry === null) return null;
      if (!opts.schema && typeof entry !== 'string') throw mistake(`agent "${name}" returns text, so its scripted result must be a string`);
      const errors = opts.schema ? validate(opts.schema, entry) : [];
      if (errors.length) throw mistake(`scripted result for agent "${name}" breaks its schema: ${errors.join('; ')}`);
      return structuredClone(entry);
    } finally {
      state.inFlight -= 1;
    }
  };
}

async function execute(script, args, options, state, depth) {
  const fn = new AsyncFunction(...SCRIPT_GLOBALS, `"use strict";\n${script.body}`);
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, index) => {
        let previous = item;
        try {
          for (const stage of stages) previous = await stage(previous, item, index);
          return previous;
        } catch {
          return null;
        }
      }),
    );
  const runChild = async (name, childArgs) => {
    if (depth > 0) throw new Error('workflow() nests one level only');
    const child = options.workflows?.[name];
    if (!child) throw new Error(`unknown workflow "${name}"`);
    const outcome = await execute(child, childArgs, options, state, depth + 1);
    if (outcome.error) throw outcome.error;
    return outcome.result;
  };
  const globals = {
    agent: makeAgent(options, state),
    parallel,
    pipeline,
    phase: (title) => state.phases.push(String(title)),
    log: (message) => state.logs.push(String(message)),
    args,
    budget: options.budget ?? DEFAULT_BUDGET,
    workflow: runChild,
    Date: ScriptDate,
    Math: ScriptMath,
    process: undefined,
  };
  try {
    return { result: await fn(...SCRIPT_GLOBALS.map((key) => globals[key])), error: null };
  } catch (error) {
    return { result: undefined, error };
  }
}

/** Runs a parsed workflow against scripted agents; rejects only for mistakes in the test itself. */
export async function runWorkflow(workflow, options = {}) {
  const state = { calls: [], logs: [], phases: [], mistakes: [], inFlight: 0, maxConcurrent: 0 };
  const outcome = await execute(workflow, options.args, options, state, 0);
  if (state.mistakes.length) throw new Error(`The test scripted the run wrongly:\n- ${state.mistakes.join('\n- ')}`);
  const { calls, logs, phases, maxConcurrent } = state;
  return { ...outcome, calls, logs, phases, maxConcurrent };
}
