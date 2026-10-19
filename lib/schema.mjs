// A small JSON Schema validator with no dependencies.
//
// It implements only the keywords this project uses. checkSchema() reports any
// other keyword, so a schema can never quietly mean less here than it says.
// Two keyword sets exist: the subset the Claude Code workflow runtime accepts
// for agent result schemas, and the wider set the config schema uses.

const ANNOTATIONS = ['$schema', '$id', 'title', 'description', 'default', 'examples'];

/** Keywords an agent result schema may use inside a workflow script. */
export const RUNTIME_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'description',
]);

/** Keywords schema/config.schema.json may use. */
export const CONFIG_KEYWORDS = new Set([...RUNTIME_KEYWORDS, 'pattern', 'minLength', 'uniqueItems', ...ANNOTATIONS]);

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The JSON type name of a value, for messages: every number is "number". */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function hasType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  return typeOf(value) === type;
}

/** Problems with the schema itself; empty when every keyword is supported and well placed. */
export function checkSchema(schema, keywords = RUNTIME_KEYWORDS) {
  const problems = [];
  if (!isPlainObject(schema) || schema.type !== 'object' || !isPlainObject(schema.properties)) {
    return ['$: the root must be {type: "object", properties: {...}}'];
  }
  const walk = (node, at) => {
    if (!isPlainObject(node)) {
      problems.push(`${at}: a schema must be an object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!keywords.has(key)) problems.push(`${at}: unsupported keyword "${key}"`);
    }
    if (node.type !== undefined && !TYPES.has(node.type)) problems.push(`${at}: unknown type "${node.type}"`);
    if (node.pattern !== undefined) {
      try {
        new RegExp(node.pattern, 'u');
      } catch {
        problems.push(`${at}: pattern is not a valid regular expression`);
      }
    }
    if (isPlainObject(node.properties)) {
      for (const key of node.required ?? []) {
        if (!(key in node.properties)) problems.push(`${at}: required key "${key}" is not in properties`);
      }
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${at}.${key}`);
    }
    if (isPlainObject(node.additionalProperties)) walk(node.additionalProperties, `${at}.*`);
    if (node.items !== undefined) walk(node.items, `${at}[]`);
  };
  walk(schema, '$');
  return problems;
}

/** Every way `value` breaks `schema`, as "<path>: <problem>" lines; empty when it matches. */
export function validate(schema, value, at = '$') {
  if (schema.type !== undefined && !hasType(value, schema.type)) {
    return [`${at}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  const errors = [];
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: must be at least ${schema.minLength} character(s)`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} item(s)`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}: items must be unique`);
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) errors.push(...validate(properties[key], child, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
      else if (isPlainObject(schema.additionalProperties)) errors.push(...validate(schema.additionalProperties, child, `${at}.${key}`));
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: required`);
    }
  }
  return errors;
}
