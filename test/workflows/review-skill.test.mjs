// The review skill loads the config the way ship does and runs the review-run
// workflow with it; it reports and changes nothing.
// Run: node --test test/workflows/review-skill.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ROOT, load } from './fixtures.mjs';

const FILE = path.join(ROOT, 'skills/review/SKILL.md');

function readSkill() {
  const source = readFileSync(FILE, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, 'SKILL.md has no frontmatter');
  const fields = Object.fromEntries([...match[1].matchAll(/^([\w-]+): (.*)$/gm)].map((m) => [m[1], m[2].trim()]));
  return { source, fields, body: match[2] };
}

describe('review skill', () => {
  test('runs only when the user asks for it, as /falsifiable:review', () => {
    const { fields } = readSkill();
    assert.equal(fields.name, 'review');
    assert.equal(fields['disable-model-invocation'], 'true');
    assert.ok(fields.description && fields.description.length < 250);
    assert.match(readSkill().body, /\$ARGUMENTS/);
  });

  test('its workflow has another name, so the skill and the workflow are two commands', () => {
    const { meta } = load('review-run');
    assert.notEqual(meta.name, readSkill().fields.name);
    assert.ok(readSkill().body.includes(`falsifiable:${meta.name}`));
  });

  test('loads the config with the plugin script, stops on its problems and passes it to the workflow', () => {
    const { body } = readSkill();
    assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"'));
    assert.match(body, /exits 1/);
    assert.match(body, /config/);
    for (const script of [...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)].map((m) => m[1])) {
      assert.ok(existsSync(path.join(ROOT, script)), `${script} does not exist`);
    }
  });

  test('takes a pull request number or a range, and the change and its lane reports when there are any', () => {
    const { body } = readSkill();
    for (const part of ['{pr}', '{range}', '`id`', '`reports`']) assert.ok(body.includes(part), `the skill does not mention ${part}`);
  });

  test('reports and changes nothing', () => {
    const { body } = readSkill();
    assert.match(body, /Never edit, commit, push or merge/);
  });

  test('speaks of the user and names no tool of one particular project', () => {
    assert.match(readSkill().source, /the user/);
    assert.doesNotMatch(readSkill().source, /\bpnpm\b|\byarn\b|\.env\b/);
  });
});
