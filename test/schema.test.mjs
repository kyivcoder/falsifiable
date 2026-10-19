import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONFIG_SCHEMA } from '../lib/config.mjs';
import { CONFIG_KEYWORDS, RUNTIME_KEYWORDS, checkSchema, validate } from '../lib/schema.mjs';

const object = (properties, extra = {}) => ({ type: 'object', properties, ...extra });

describe('checkSchema', () => {
  test('the config schema uses only supported keywords', () => assert.deepEqual(checkSchema(CONFIG_SCHEMA, CONFIG_KEYWORDS), []));

  test('the runtime subset refuses keywords the workflow runtime does not take', () => {
    const problems = checkSchema(object({ id: { type: 'string', pattern: '^a' } }), RUNTIME_KEYWORDS);
    assert.deepEqual(problems, ['$.id: unsupported keyword "pattern"']);
  });

  test('a required key must be a property', () => {
    assert.deepEqual(checkSchema(object({ a: { type: 'string' } }, { required: ['b'] })), ['$: required key "b" is not in properties']);
  });
});

describe('validate', () => {
  const schema = object(
    {
      id: { type: 'string', pattern: '^[a-z]+$', minLength: 2 },
      n: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', uniqueItems: true, minItems: 1, items: { enum: ['a', 'b'] } },
    },
    { required: ['id'], additionalProperties: false },
  );

  test('accepts a matching value', () => assert.deepEqual(validate(schema, { id: 'ab', n: 2, tags: ['a'] }), []));

  test('reports each problem with its path', () => {
    assert.deepEqual(validate(schema, { id: 'A', n: 9, tags: ['a', 'a', 'c'], x: 1 }), [
      '$.id: must be at least 2 character(s)',
      '$.id: must match ^[a-z]+$',
      '$.n: must be <= 3',
      '$.tags: items must be unique',
      '$.tags[2]: must be one of "a", "b"',
      '$.x: not allowed',
    ]);
  });

  test('reports a missing required key and a wrong type', () => {
    assert.deepEqual(validate(schema, {}), ['$.id: required']);
    assert.deepEqual(validate(schema, []), ['$: expected object, got array']);
    assert.deepEqual(validate(schema, { id: 'ab', n: 1.5 }), ['$.n: expected integer, got number']);
  });
});
