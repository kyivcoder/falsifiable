// The ship skill is the head's chain: it must load the config, run the stages
// through the workflow, merge the lanes, keep production out of the local app
// and hand over without merging. Run: node --test test/workflows/ship-skill.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ROOT, load } from './fixtures.mjs';

const FILE = path.join(ROOT, 'skills/ship/SKILL.md');
const MAX_LINES = 150;

function readSkill() {
  const source = readFileSync(FILE, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, 'SKILL.md has no frontmatter');
  const fields = Object.fromEntries([...match[1].matchAll(/^([\w-]+): (.*)$/gm)].map((m) => [m[1], m[2].trim()]));
  return { source, fields, body: match[2] };
}

describe('ship skill', () => {
  test('runs only when the user asks for it, under its own name', () => {
    const { fields } = readSkill();
    assert.equal(fields.name, 'ship');
    assert.equal(fields['disable-model-invocation'], 'true');
    assert.ok(fields.description && fields.description.length < 250);
  });

  test(`stays under ${MAX_LINES} lines`, () => {
    assert.ok(readSkill().source.split('\n').length < MAX_LINES);
  });

  test('loads the config with the plugin script and stops on its problems', () => {
    const { body } = readSkill();
    assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"'));
    assert.match(body, /exits? 1/);
  });

  test('runs every stage through the ship-stage workflow, passing next.args back with the config', () => {
    const { body } = readSkill();
    assert.equal(load('ship-stage').meta.name, 'ship-stage');
    assert.ok(body.includes('falsifiable:ship-stage'));
    assert.match(body, /next\.args/);
    for (const stage of ['plan', 'build', 'verify', 'fix']) assert.ok(body.includes(`\`${stage}\``), `the skill does not name the ${stage} stage`);
    assert.match(body, /config/);
  });

  test('records each decision and its reason in design.md', () => {
    assert.match(readSkill().body, /design\.md/);
  });

  test('merges the lanes with the plugin script after build and after each fix', () => {
    const { body } = readSkill();
    assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-lanes.mjs"'));
  });

  test('every plugin script the skill runs exists', () => {
    const scripts = [...readSkill().body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 2);
    for (const script of scripts) assert.ok(existsSync(path.join(ROOT, script)), `${script} does not exist`);
  });

  test('makes sure the app runs locally at verify.baseUrl, and never with production credentials', () => {
    const { body } = readSkill();
    assert.match(body, /verify\.baseUrl/);
    assert.match(body, /never with production credentials/i);
  });

  test('hands over as a draft pull request, says what could not run, marks it ready last and never merges', () => {
    const { body } = readSkill();
    assert.match(body, /openspec archive <id> --yes/);
    assert.match(body, /draft/);
    assert.match(body, /Not run: X because Y/);
    assert.match(body, /gh pr ready/);
    assert.match(body, /Never merge/);
  });

  test('speaks of the user and names no tool of one particular project', () => {
    assert.match(readSkill().source, /the user/);
    assert.doesNotMatch(readSkill().source, /\bpnpm\b|\byarn\b|\.env\b/);
  });

  test('reads its arguments from $ARGUMENTS', () => {
    assert.match(readSkill().body, /\$ARGUMENTS/);
  });

  test('before a failed lane runs again, removes only its stale lane worktree, never by force, and tells the user when it cannot', () => {
    const { body } = readSkill();
    assert.match(body, /git worktree remove <path>/);
    assert.match(body, /lane\/<id>\/<lane>/);
    assert.match(body, /\.claude\/worktrees\//);
    assert.match(body, /Never pass --force/);
    assert.match(body, /tell the user/);
  });

  test('says that a lane without a passing gate run comes back blocked', () => {
    assert.match(readSkill().body, /passing run of its domain's gate/);
  });
});
