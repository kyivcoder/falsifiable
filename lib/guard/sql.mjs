// A read-only SQL classifier for SQL that reaches a database through an MCP
// tool. Comments, string literals, dollar-quoted bodies and quoted identifiers
// are blanked out first, so keywords inside them never count. When in doubt
// it says "not read-only".
//
//   classifySql('select 1')        -> {readOnly: true}
//   classifySql('delete from t')   -> {readOnly: false, reason: 'starts with DELETE'}
//
// Tests: node --test test/guard/engine.test.mjs

const READ_STARTERS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'VALUES', 'TABLE']);

/** Words that write, or can write from inside a SELECT, WITH or EXPLAIN. */
const WRITE_WORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|VACUUM|REINDEX|REFRESH|INTO|EXECUTE|PREPARE|COMMENT\s+ON|SECURITY\s+LABEL|SET\s+ROLE|SET\s+SESSION\s+AUTHORIZATION|LOCK\s+TABLE)\b/i;

/** Functions with side effects that a SELECT can call. */
const WRITE_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote|pg_create_restore_point|pg_drop_replication_slot|pg_create_logical_replication_slot|pg_create_physical_replication_slot|pg_(?:try_)?advisory(?:_xact)?_(?:lock|unlock)(?:_shared|_all)?|set_config|setval|nextval|dblink_exec|dblink|lo_import|lo_export|lo_unlink|lo_create|lo_from_bytea|lo_put)\s*\(/i;

/** The SQL with comments, literals and dollar-quoted bodies blanked out, and quoted identifiers unquoted. */
export function stripSql(sql) {
  const s = String(sql);
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '-' && next === '-') {
      const eol = s.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += ' ';
    } else if (c === "'" || ((c === 'E' || c === 'e') && next === "'" && !/\w/.test(s[i - 1] ?? ''))) {
      const backslashEscapes = c !== "'";
      i += backslashEscapes ? 2 : 1;
      while (i < n) {
        if (backslashEscapes && s[i] === '\\') i += 2;
        else if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      out += " '' ";
    } else if (c === '"') {
      i += 1;
      let ident = '';
      while (i < n) {
        if (s[i] === '"' && s[i + 1] === '"') {
          ident += '"';
          i += 2;
        } else if (s[i] === '"') {
          i += 1;
          break;
        } else {
          ident += s[i];
          i += 1;
        }
      }
      out += ` ${ident} `;
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (tag) {
        const end = s.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        out += " '' ";
      } else {
        out += c;
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Whether every statement only reads, and when not, why. */
export function classifySql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return { readOnly: false, reason: 'is empty or missing' };
  const statements = stripSql(sql)
    .split(';')
    .map((st) => st.trim())
    .filter(Boolean);
  if (statements.length === 0) return { readOnly: false, reason: 'has no statement' };
  for (const statement of statements) {
    const first = (/^[(\s]*([A-Za-z]+)/.exec(statement)?.[1] ?? '').toUpperCase();
    if (!READ_STARTERS.has(first)) return { readOnly: false, reason: `starts with ${first || 'something unknown'}` };
    const word = WRITE_WORDS.exec(statement);
    if (word) return { readOnly: false, reason: `contains ${word[1].toUpperCase().replace(/\s+/g, ' ')}` };
    const fn = WRITE_FUNCTIONS.exec(statement);
    if (fn) return { readOnly: false, reason: `calls ${fn[1]}()` };
  }
  return { readOnly: true };
}

/** True when the SQL only reads. */
export const isReadOnlySql = (sql) => classifySql(sql).readOnly;
