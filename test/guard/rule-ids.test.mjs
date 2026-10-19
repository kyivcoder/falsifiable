// The guard emits only the rule ids in lib/guard/rule-ids.mjs, and every id
// there is emitted by the code that owns it. Rule ids are read out of the
// sources, so a new block() with an id nobody registered fails here first.
//
//   node --test test/guard/rule-ids.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PACKS, resolveConfig } from '../../lib/config.mjs';
import { evaluate } from '../../lib/guard/engine.mjs';
import { PACK_LIST } from '../../lib/guard/packs/index.mjs';
import { RULES, ruleIds } from '../../lib/guard/rule-ids.mjs';
import { ALLOWED, BLOCKED, CONFIG_CASES } from './cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (file) => readFileSync(path.join(ROOT, file), 'utf8');

/** Rule ids a source names as the first argument of block(), deny() or blockMessage(). */
const idsIn = (text) => new Set([...text.matchAll(/\b(?:block|deny|blockMessage)\(\s*'([^']+)'/g)].map((m) => m[1]));

const byId = new Map(RULES.map((rule) => [rule.id, rule]));
const packSource = (name) => source(`lib/guard/packs/${name}.mjs`);

describe('rule ids', () => {
  test('the packs are the ones the config knows, each once', () => {
    assert.deepEqual(PACK_LIST.map((p) => p.name).sort(), [...PACKS].sort());
  });

  for (const pack of PACK_LIST) {
    test(`${pack.name}: every id its source emits is declared in emits, and the other way round`, () => {
      assert.deepEqual([...idsIn(packSource(pack.name))].sort(), [...pack.emits].sort());
    });

    test(`${pack.name}: every block() names its rule id literally`, () => {
      const text = packSource(pack.name);
      assert.equal((text.match(/\bblock\(/g) ?? []).length, (text.match(/\bblock\(\s*'/g) ?? []).length);
    });

    test(`${pack.name}: every id it emits is registered to this pack`, () => {
      for (const id of pack.emits) assert.equal(byId.get(id)?.pack, pack.name, `${id} is not registered to ${pack.name}`);
    });
  }

  test('every pack rule in the registry is emitted by its pack', () => {
    const emitted = new Set(PACK_LIST.flatMap((p) => p.emits));
    for (const rule of RULES.filter((r) => r.pack !== 'fence' && r.pack !== 'core')) {
      assert.ok(emitted.has(rule.id), `${rule.id} is registered but no pack emits it`);
    }
  });

  test('the fence emits exactly the fence rules, plus malformed-input', () => {
    const fenceIds = [...idsIn(source('lib/guard/fence.mjs'))].sort();
    const expected = [...RULES.filter((r) => r.pack === 'fence').map((r) => r.id), 'malformed-input'].sort();
    assert.deepEqual(fenceIds, expected);
  });

  test('the engine and the hook emit the core rules', () => {
    const coreIds = new Set([...idsIn(source('lib/guard/engine.mjs')), ...idsIn(source('scripts/hook.mjs'))]);
    for (const rule of RULES.filter((r) => r.pack === 'core')) assert.ok(coreIds.has(rule.id), `${rule.id} is never emitted`);
    for (const id of coreIds) assert.equal(byId.get(id)?.pack, 'core', `${id} is not a core rule`);
  });

  test('every block in the case table reports a registered id or a blockCommands id', () => {
    const cases = [
      ...BLOCKED.map(([, request]) => [undefined, request]),
      ...ALLOWED.map(([, request]) => [undefined, request]),
      ...CONFIG_CASES.map(([, raw, request]) => [raw, request]),
    ];
    for (const [raw, request] of cases) {
      const { config } = resolveConfig(raw);
      const result = evaluate({ env: {}, ...request }, config);
      if (!result.allow) assert.ok(ruleIds(config).includes(result.rule), `${result.rule} is not registered`);
    }
  });
});
