// The role agents keep their contract: supported frontmatter only, a short
// description, the tools their role allows, and instructions that match what
// the workflows and the guard's fences expect.
// Run: node --test test/workflows/agents.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ROLES } from '../../lib/config.mjs';
import { RULES } from '../../lib/guard/rule-ids.mjs';
import { ROOT } from './fixtures.mjs';

// What Claude Code reads from a plugin agent's frontmatter; it ignores hooks, permissionMode and mcpServers there.
const SUPPORTED = ['name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools', 'skills', 'memory', 'background', 'isolation', 'color'];
const MAX_DESCRIPTION = 250;
const COLOURS = { scout: 'cyan', planner: 'blue', builder: 'green', verifier: 'yellow', reviewer: 'red' };
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const AGENTS_DIR = path.join(ROOT, 'agents');

/** The frontmatter fields (top-level `key: value` lines) and the body of an agent file. */
function readAgent(name) {
  const source = readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, `${name}.md has no frontmatter`);
  const lines = match[1].split('\n');
  for (const line of lines) assert.match(line, /^[A-Za-z]+: \S/, `${name}.md: "${line}" is not a one-line key: value field`);
  const fields = Object.fromEntries(lines.map((line) => /^([A-Za-z]+): (.*)$/.exec(line).slice(1).map((s) => s.trim())));
  return { fields, body: match[2], source };
}

const list = (value = '') => value.split(',').map((s) => s.trim()).filter(Boolean);

describe('role agents', () => {
  test('there is one agent file per role, and no other', () => {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
    assert.deepEqual(files, [...ROLES].sort());
  });

  for (const name of ROLES) {
    test(`${name}: supported frontmatter only, named after its file, coloured, with a short description that says when to use it`, () => {
      const { fields } = readAgent(name);
      for (const key of Object.keys(fields)) assert.ok(SUPPORTED.includes(key), `${name}.md uses "${key}", which a plugin agent does not support`);
      assert.equal(fields.name, name);
      assert.equal(fields.color, COLOURS[name]);
      assert.match(fields.description, /^Use when /);
      assert.ok(fields.description.length < MAX_DESCRIPTION, `${name}: the description is ${fields.description.length} characters; it is loaded on every turn`);
      if ('isolation' in fields) assert.equal(fields.isolation, 'worktree');
    });

    test(`${name}: every frontmatter value is a valid YAML plain scalar`, () => {
      for (const [key, value] of Object.entries(readAgent(name).fields)) {
        assert.doesNotMatch(value, /: | #/, `${name}.md ${key}: ": " or " #" ends a YAML plain scalar early`);
        assert.doesNotMatch(value, /^[[\]{}&*!|>'"%@`,?:-]/, `${name}.md ${key}: a YAML plain scalar cannot start with "${value[0]}"`);
      }
    });

    test(`${name}: names no tool of one particular project, and runs on the session's model`, () => {
      const { source, fields } = readAgent(name);
      assert.doesNotMatch(source, /\bpnpm\b|\byarn\b|\.env\b/);
      assert.equal(fields.model, undefined, 'a plugin agent inherits the model the user chose');
    });
  }

  test('scout and reviewer write nothing and start no agents', () => {
    for (const name of ['scout', 'reviewer']) {
      const tools = list(readAgent(name).fields.tools);
      assert.ok(tools.length > 0, `${name} needs an explicit tool list`);
      for (const tool of [...WRITE_TOOLS, 'Agent']) assert.ok(!tools.includes(tool), `${name} may not use ${tool}`);
      assert.ok(tools.includes('Read'));
    }
  });

  test('planner writes, but cannot edit, run commands or start agents, and knows the guard fences it to tasks.md', () => {
    const { fields, body } = readAgent('planner');
    const tools = list(fields.tools);
    assert.ok(tools.includes('Write'));
    for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent']) assert.ok(!tools.includes(tool), `planner may not use ${tool}`);
    assert.match(body, /tasks\.md/);
    assert.match(body, /fence-write/);
  });

  test('builder works in its own worktree on the lane branch, test first, and starts no agents', () => {
    const { fields, body } = readAgent('builder');
    assert.equal(fields.isolation, 'worktree');
    assert.ok(list(fields.disallowedTools).includes('Agent'));
    assert.ok(Number(fields.maxTurns) >= 100);
    assert.match(body, /lane\/<id>\/<lane>/);
    assert.match(body, /test-driven-development/);
  });

  test('builder reports whether each check should pass or fail, and what could not run', () => {
    const { body } = readAgent('builder');
    assert.match(body, /`checks`:.*`expect`/);
    assert.match(body, /red run.*mutant.*`fail`/i);
    assert.match(body, /Not run: X because Y/);
  });

  test('verifier starts no agents, has room for long runs and knows which fences the guard holds it to', () => {
    const { fields, body } = readAgent('verifier');
    assert.ok(list(fields.disallowedTools).includes('Agent'));
    assert.ok(Number(fields.maxTurns) >= 100);
    for (const id of ['fence-read', 'fence-diff', 'fence-write']) {
      assert.ok(RULES.some((rule) => rule.id === id), `${id} is not a guard rule`);
      assert.ok(body.includes(id), `the verifier is not told about ${id}`);
    }
    assert.match(body, /a block is expected/i);
    for (const forbidden of ['design.md', 'tasks.md', 'proposal.md', 'lane reports', 'git diff']) assert.ok(body.includes(forbidden), `the verifier body should forbid ${forbidden}`);
  });

  test('verifier never starts a server, judges only the named scenarios and needs evidence for a PASS', () => {
    const { body } = readAgent('verifier');
    assert.match(body, /Never start, restart or kill a server/);
    assert.match(body, /the app is not running; the head starts it with local settings/);
    assert.match(body, /Judge only the named scenarios/);
    assert.match(body, /\*\*PASS\*\*: .*at least one piece of evidence/);
  });

  test('verifier reports a clean regression sweep as an empty list, since every item stops the hand-over', () => {
    const { body } = readAgent('verifier');
    assert.match(body, /`regressions`:.*an empty list when the sweep found nothing/);
    assert.match(body, /each one stops the hand-over/i);
  });

  test("reviewer walks the project's checklist and verifies each serious second-opinion finding, with no checklist of its own", () => {
    const { body } = readAgent('reviewer');
    assert.match(body, /review\.checklist/);
    assert.match(body, /review\.secondOpinion/);
    assert.match(body, /read-only/);
    assert.match(body, /Verify each of its P0 and P1 findings/);
    assert.doesNotMatch(body, /^- `[a-z-]+`: /m, 'the checklist belongs to the project, not to the agent');
  });

  // A `tools:` list drops every MCP tool it does not name by server (code.claude.com/docs/en/sub-agents), and the
  // verifier's browser servers are the project's verify.mcpServers, whose real names vary. So the verifier keeps the
  // inherited pool, denies the web tools by name, and the guard's fence holds it to the configured servers.
  test('verifier keeps the MCP servers the project allows, never has the web tools, and says what its allowlist fence lets it read, run and use', () => {
    const { fields, body } = readAgent('verifier');
    assert.equal(fields.tools, undefined, 'a tools list would drop the browser MCP servers the config allows');
    const denied = list(fields.disallowedTools);
    for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'NotebookEdit']) assert.ok(denied.includes(tool), `the verifier may not use ${tool}`);
    for (const part of ['verify.readPaths', 'verify.commands', 'verify.mcpServers', '.verify/', 'curl', 'fence-tool']) {
      assert.ok(body.includes(part), `the verifier is not told about ${part}`);
    }
    assert.match(body, /Everything else is refused/);
  });

  test('reviewer and scout run read-only commands only, and know the fence enforces it', () => {
    for (const name of ['reviewer', 'scout']) {
      const { body } = readAgent(name);
      assert.match(body, /read-only commands only/, name);
      assert.match(body, /fence-tool/, name);
      assert.match(body, /fence-write/, name);
    }
  });

  test('builder lists its run of the domain gate in checks, since a report without a passing gate run fails', () => {
    const { body } = readAgent('builder');
    assert.match(body, /gate/);
    assert.match(body, /no passing run of the gate/);
  });

  test('reviewer expects the change folder and the merge commits in the diff without a lane report', () => {
    const { body } = readAgent('reviewer');
    assert.match(body, /change folder/);
    assert.match(body, /merge commits/);
    assert.match(body, /are not mismatches/);
  });

  test('every changed-file listing an agent asks for turns rename detection off', () => {
    const listings = ROLES.flatMap((name) => [...readAgent(name).source.matchAll(/git diff --name-only[^`'"\n]*/g)].map((m) => [name, m[0]]));
    assert.ok(listings.some(([name]) => name === 'builder'), 'builder.md no longer asks for the changed files');
    for (const [name, command] of listings) assert.match(command, /--no-renames/, `${name}.md: "${command}" hides the old path of a moved file`);
  });
});
