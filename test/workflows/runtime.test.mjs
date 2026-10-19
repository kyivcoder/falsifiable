// Tests for the fake workflow runtime. Run: node --test test/workflows/runtime.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { loadWorkflow, parseWorkflow, runWorkflow } from './runtime.mjs';

const META = "export const meta = { name: 'probe', description: 'A probe workflow' }\n";
const probe = (body) => parseWorkflow(META + body, 'probe.js');
const ANSWER = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const SCHEMA_SOURCE = `const ANSWER = ${JSON.stringify(ANSWER)}\n`;

const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('parseWorkflow', () => {
  test('reads meta and keeps it available to the body', async () => {
    const wf = probe('return meta.name');
    assert.equal(wf.meta.name, 'probe');
    assert.equal(wf.meta.description, 'A probe workflow');
    assert.equal((await runWorkflow(wf)).result, 'probe');
  });

  test('loads a saved workflow from disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'falsifiable-workflow-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'probe.js');
    writeFileSync(file, `${META}// a comment\nreturn 1 + 1\n`);
    assert.equal((await runWorkflow(loadWorkflow(file))).result, 2);
  });

  const impure = {
    'a variable': "const NAME = 'x'\nexport const meta = { name: NAME, description: 'd' }",
    'a function call': "export const meta = { name: String('x'), description: 'd' }",
    'a spread': "export const meta = { ...base, description: 'd' }",
    'a template interpolation': 'export const meta = { name: `x${1}`, description: \'d\' }',
    'a shorthand property': "export const meta = { name, description: 'd' }",
    'arithmetic': "export const meta = { name: 'x', description: 'd', phases: [1 + 1] }",
  };
  for (const [what, source] of Object.entries(impure)) {
    test(`rejects a meta with ${what}`, () => {
      assert.throws(() => parseWorkflow(source, 'bad.js'), /meta/);
    });
  }

  test('accepts nested literals, negative numbers, booleans, null and comments in meta', () => {
    const source = `export const meta = {
      name: 'x', // the command
      description: "d", whenToUse: \`plain template\`,
      phases: [{ title: 'A', detail: 'b', n: -1.5, on: true, off: null }],
    }\nreturn 1`;
    assert.deepEqual(parseWorkflow(source, 'ok.js').meta.phases, [{ title: 'A', detail: 'b', n: -1.5, on: true, off: null }]);
  });

  test('requires a name and a description', () => {
    assert.throws(() => parseWorkflow("export const meta = { name: 'x' }", 'bad.js'), /description/);
  });

  test('rejects module loading in the body', () => {
    assert.throws(() => probe("const fs = await import('node:fs')"), /import/);
  });
});

describe('runWorkflow: agents', () => {
  test('answers by label, records every call and validates the result against its schema', async () => {
    const wf = probe(`${SCHEMA_SOURCE}const r = await agent('Say hi', { label: 'greeter', schema: ANSWER })\nreturn r.answer`);
    const run = await runWorkflow(wf, { agents: { greeter: { answer: 'hi' } } });
    assert.equal(run.result, 'hi');
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].prompt, 'Say hi');
    assert.equal(run.calls[0].label, 'greeter');
    assert.deepEqual(run.calls[0].opts.schema, ANSWER);
  });

  test('answers with a function of the call', async () => {
    const wf = probe("return await agent('echo me')");
    const run = await runWorkflow(wf, { agents: (call) => call.prompt.toUpperCase() });
    assert.equal(run.result, 'ECHO ME');
  });

  test('a label entry may itself be a function of the call', async () => {
    const wf = probe("return await agent('p', { label: 'x' })");
    const run = await runWorkflow(wf, { agents: { x: (call) => `${call.label}!` } });
    assert.equal(run.result, 'x!');
  });

  test('fails the test when a scripted result breaks the call schema', async () => {
    const wf = probe(`${SCHEMA_SOURCE}return await agent('p', { label: 'a', schema: ANSWER })`);
    await assert.rejects(runWorkflow(wf, { agents: { a: { answer: 1 } } }), /"a".*\$\.answer: expected string, got number/s);
  });

  test('fails the test when a schema could never be satisfied', async () => {
    const wf = probe("return await agent('p', { label: 'a', schema: { type: 'object', additionalProperties: false, properties: {}, required: ['x'] } })");
    await assert.rejects(runWorkflow(wf, { agents: { a: {} } }), /required key "x" is not in properties/);
  });

  test('fails the test when a schema uses a keyword the runtime does not accept', async () => {
    const wf = probe("return await agent('p', { label: 'a', schema: { type: 'object', properties: { x: { type: 'string', pattern: '^a' } } } })");
    await assert.rejects(runWorkflow(wf, { agents: { a: { x: 'a' } } }), /unsupported keyword "pattern"/);
  });

  test('fails the test for an agent nobody scripted, even inside parallel()', async () => {
    const wf = probe("return await parallel([() => agent('p', { label: 'ghost' })])");
    await assert.rejects(runWorkflow(wf, { agents: {} }), /no scripted result for agent "ghost"/);
  });

  test('a text agent must be scripted with a string', async () => {
    const wf = probe("return await agent('p', { label: 'a' })");
    await assert.rejects(runWorkflow(wf, { agents: { a: { not: 'text' } } }), /returns text/);
  });

  test('a scripted null is an agent that died; a scripted Error is an agent that failed', async () => {
    const wf = probe("const a = await agent('p', { label: 'dead' })\nreturn [a, await agent('q', { label: 'broken' })]");
    const run = await runWorkflow(wf, { agents: { dead: null, broken: new Error('API error') } });
    assert.equal(run.error.message, 'API error');
    assert.equal(run.calls.length, 2);
  });

  test('gives each call its own copy of a scripted result', async () => {
    const shared = { answer: 'x' };
    const wf = probe(`${SCHEMA_SOURCE}const r = await agent('p', { label: 'a', schema: ANSWER })\nr.answer = 'changed'\nreturn 1`);
    await runWorkflow(wf, { agents: { a: shared } });
    assert.equal(shared.answer, 'x');
  });
});

describe('runWorkflow: parallel, pipeline and the rest of the API', () => {
  test('parallel() keeps order and turns a throwing thunk into null', async () => {
    const wf = probe("return await parallel([() => agent('a', { label: 'a' }), () => { throw new Error('x') }, () => agent('b', { label: 'b' })])");
    const run = await runWorkflow(wf, { agents: { a: 'A', b: 'B' } });
    assert.deepEqual(run.result, ['A', null, 'B']);
  });

  test('records how many agents ran at once', async () => {
    const wf = probe("return await parallel([1, 2, 3].map((n) => () => agent('p' + n, { label: 'a' + n })))");
    const run = await runWorkflow(wf, { agents: () => 'ok' });
    assert.equal(run.maxConcurrent, 3);
  });

  test('pipeline() passes (previous, item, index) and drops a throwing item to null', async () => {
    const body = `return await pipeline([1, 2, 3],
      (prev, item, i) => prev * 10 + i,
      (prev, item) => { if (item === 2) throw new Error('drop'); return prev },
      (prev, item, i) => prev + ':' + item + ':' + i)`;
    assert.deepEqual((await runWorkflow(probe(body))).result, ['10:1:0', null, '32:3:2']);
  });

  test('passes args through verbatim, including a JSON string', async () => {
    assert.equal((await runWorkflow(probe('return args'), { args: '{"a":1}' })).result, '{"a":1}');
    assert.equal((await runWorkflow(probe('return args'))).result, undefined);
  });

  test('records logs and phases', async () => {
    const run = await runWorkflow(probe("phase('One')\nlog('hello')\nphase('Two')\nreturn null"));
    assert.deepEqual(run.phases, ['One', 'Two']);
    assert.deepEqual(run.logs, ['hello']);
  });

  test('exposes a budget with no target by default', async () => {
    const run = await runWorkflow(probe('return [budget.total, budget.spent(), budget.remaining()]'));
    assert.deepEqual(run.result, [null, 0, Infinity]);
  });

  test('runs a named child workflow with its own args and shared agents', async () => {
    const child = parseWorkflow("export const meta = { name: 'child', description: 'd' }\nreturn await agent('c', { label: 'c' }) + args", 'child.js');
    const run = await runWorkflow(probe("return await workflow('child', '!')"), { agents: { c: 'C' }, workflows: { child } });
    assert.equal(run.result, 'C!');
    assert.equal(run.calls.length, 1);
  });
});

describe('runWorkflow: determinism', () => {
  const blocked = {
    'Date.now()': 'return Date.now()',
    'Math.random()': 'return Math.random()',
    'new Date() without arguments': 'return new Date()',
    'Date() called as a function': 'return Date()',
  };
  for (const [what, body] of Object.entries(blocked)) {
    test(`${what} throws inside a script`, async () => {
      const run = await runWorkflow(probe(body));
      assert.match(run.error?.message ?? '', /not available in a workflow script/);
    });
  }

  test('dated values and the rest of Math still work', async () => {
    const run = await runWorkflow(probe("return [new Date('2026-10-15T00:00:00Z').getUTCDate(), Math.max(1, 2), Date.UTC(2026, 0, 1)]"));
    assert.deepEqual(run.result, [15, 2, Date.UTC(2026, 0, 1)]);
  });

  test('the script sees no Node process', async () => {
    assert.equal((await runWorkflow(probe('return typeof process'))).result, 'undefined');
  });
});
