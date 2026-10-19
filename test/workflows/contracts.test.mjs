// Contracts both workflows keep: the same shared blocks and agent budget, a
// pure meta, plugin agent types, no clock or randomness, and messages that
// speak of the user. Run: node --test test/workflows/contracts.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULTS, ROLES, agentType } from '../../lib/config.mjs';
import { RUNTIME_KEYWORDS, checkSchema } from '../../lib/schema.mjs';
import { SHARED_BLOCKS, WORKFLOWS, load, markedBlock, probeWith, workflowSource } from './fixtures.mjs';
import { runWorkflow } from './runtime.mjs';

const startSeven = "for (let i = 1; i <= 7; i += 1) await startAgent('task ' + i, { label: 'agent ' + i })\nreturn 'unreachable'";

describe('workflow contracts', () => {
  for (const title of SHARED_BLOCKS) {
    test(`the "${title}" block is identical in ${WORKFLOWS.join(' and ')}`, () => {
      const blocks = WORKFLOWS.map((name) => [name, markedBlock(workflowSource(name), title)]);
      for (const [name, block] of blocks) assert.ok(block, `${name}.js has no "${title}" block`);
      for (const [name, block] of blocks.slice(1)) assert.equal(block, blocks[0][1], `${name}.js differs from ${blocks[0][0]}.js in "${title}"`);
    });
  }

  test(`without a config the agent budget is the default of ${DEFAULTS.delivery.limits.maxAgentsPerRun}, and the next agent is refused and never starts`, async () => {
    const run = await runWorkflow(probeWith('ship-stage', startSeven), { agents: () => 'done' });
    assert.match(run.error?.message ?? '', new RegExp(`agent budget: a run may start at most ${DEFAULTS.delivery.limits.maxAgentsPerRun} agents`));
    assert.equal(run.calls.length, DEFAULTS.delivery.limits.maxAgentsPerRun);
  });

  test('the agent budget follows delivery.limits.maxAgentsPerRun, given as an object or as JSON text', async () => {
    const config = { delivery: { limits: { maxAgentsPerRun: 3 } } };
    for (const args of [{ config }, { config: JSON.stringify(config) }, JSON.stringify({ config })]) {
      const run = await runWorkflow(probeWith('ship-stage', startSeven), { args, agents: () => 'done' });
      assert.match(run.error?.message ?? '', /at most 3 agents/);
      assert.equal(run.calls.length, 3);
    }
  });

  test('the schemas both workflows share use only keywords the runtime accepts', async () => {
    const { result } = await runWorkflow(probeWith('ship-stage', 'return { FINDINGS_SCHEMA, BRIEF_SCHEMA }'));
    for (const [name, schema] of Object.entries(result)) assert.deepEqual(checkSchema(schema, RUNTIME_KEYWORDS), [], name);
  });

  for (const name of WORKFLOWS) {
    const source = workflowSource(name);
    const outsideShared = SHARED_BLOCKS.reduce((rest, title) => rest.replace(markedBlock(source, title), ''), source);

    test(`${name}: meta is a pure literal named after its file, with a description and a whenToUse`, () => {
      const { meta } = load(name);
      assert.equal(meta.name, name);
      assert.ok(meta.description.length <= 200, 'the description is shown in the permission dialog; keep it to one line');
      assert.ok(meta.whenToUse, `${name} needs a whenToUse`);
    });

    test(`${name}: every phase it starts is listed in meta.phases`, () => {
      const listed = new Set(load(name).meta.phases.map((p) => p.title));
      const used = [...outsideShared.matchAll(/\bphase(?:\(|: )'([^']+)'/g)].map((m) => m[1]);
      assert.ok(used.length > 0, `${name} names no phase`);
      for (const title of used) assert.ok(listed.has(title), `${name} uses phase "${title}", which meta.phases does not list`);
    });

    test(`${name}: starts agents only through the budget`, () => {
      assert.doesNotMatch(outsideShared, /\bagent\(/);
    });

    test(`${name}: starts only the plugin's own agents`, () => {
      const types = [...source.matchAll(/agentType: '([^']+)'/g)].map((m) => m[1]);
      assert.ok(types.length > 0, `${name} names no agent type`);
      for (const type of types) assert.ok(ROLES.map(agentType).includes(type), `${name} starts ${type}, which is not one of ${ROLES.map(agentType).join(', ')}`);
    });

    test(`${name}: reads no clock and draws no random numbers`, () => {
      assert.doesNotMatch(source, /Date\.now\(|Math\.random\(|new Date\(\s*\)/);
    });

    test(`${name}: speaks of the user and names no tool of one particular project`, () => {
      assert.match(source, /the user/);
      assert.doesNotMatch(source, /\bpnpm\b|\byarn\b|\.env\b/);
    });

    test(`${name}: every changed-file listing turns rename detection off`, () => {
      for (const [command] of source.matchAll(/git diff --name-only[^`'"\n]*/g)) assert.match(command, /--no-renames/, command);
    });
  }
});
