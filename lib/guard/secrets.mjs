// High-signal secret detection for new file content. Tuned for few false
// positives: placeholders, local database URLs, docs examples and obvious
// fakes pass. It reports the kind of secret, never the value.
//
//   findSecret(content, filePath, {localHosts})   -> {label} | null
//
// Tests: node --test test/guard/engine.test.mjs

/** The hosts that count as local when a caller passes none; the config's guard.localHosts default. */
export const DEFAULT_LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

const PLACEHOLDER =
  /^(password|passwd|pass|pwd|postgres|test|testing|example|changeme|change_me|secret|admin|root|user|x+|\*+|\.+|<[^>]*>|\[[^\]]*\]|\{\{[^}]*\}\}|\$\{[^}]*\}|\$[A-Za-z_]\w*|%[A-Za-z_]+%|your[-_]?password|placeholder|redacted)$/i;
const FAKE_MARKER =
  /(x{4,}|\*{3,}|0{8,}|1234567|abcdef|test|fake|dummy|example|sample|placeholder|redacted|changeme|your[_-]?(api[_-]?)?(key|token|secret)|\.\.\.|[<>{}])/i;
/** Hosted database providers: a password for one of them counts even in a test file. */
const HOSTED_DATABASE = /supabase\.(co|com)|pooler\.|amazonaws\.com|rlwy\.net|railway\.(app|internal)|neon\.tech|render\.com/i;
const TEST_PATH = /(^|\/)(__tests__|__fixtures__|fixtures|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

const bare = (host) => String(host).toLowerCase().replace(/^\[(.*)\]$/, '$1');

/** True for a host in `localHosts`, or a Unix socket folder (a path), which is always on this machine. */
export function isLocalHost(host, localHosts = DEFAULT_LOCAL_HOSTS) {
  const h = bare(host);
  return h.startsWith('/') || localHosts.some((local) => bare(local) === h);
}

/** True for values that are clearly not real credentials. */
export const looksFake = (value) => FAKE_MARKER.test(value) || new Set(value).size < 8;

/** Classic fixture and docs passwords, and ALL_CAPS placeholders (YOUR_PASSWORD, DB_PASS). */
const FAKE_PASSWORD = /(s3cr3t|s3cret|secret|passw(or|0r)d|hunter2|letmein|changeme|example|dummy|fake|test)/i;
const isPlaceholder = (value) => PLACEHOLDER.test(value) || looksFake(value) || FAKE_PASSWORD.test(value) || /^[A-Z][A-Z_]*$/.test(value);

const decodeJwtPayload = (segment) => {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const TOKEN_PATTERNS = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI API key', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/g],
  ['AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['GitHub token', /\bgithub_pat_[A-Za-z0-9_]{50,}/g],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}/g],
];

/** A PEM private key block with a real-looking body. */
function findPrivateKey(content) {
  const re = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----([\s\S]{0,400})/g;
  for (const m of content.matchAll(re)) if (/[A-Za-z0-9+/=]{40,}/.test(m[1])) return 'private key';
  return null;
}

/** A provider token in its known shape that does not look fake. */
function findToken(content) {
  for (const [label, re] of TOKEN_PATTERNS) {
    for (const m of content.matchAll(re)) if (!looksFake(m[0])) return label;
  }
  return null;
}

/** A Supabase JWT whose payload grants service_role. */
function findServiceRoleJwt(content) {
  const re = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{16,}/g;
  for (const m of content.matchAll(re)) {
    const payload = decodeJwtPayload(m[1]);
    if (payload?.role === 'service_role' && payload.iss !== 'supabase-demo') return 'Supabase service_role key';
  }
  return null;
}

/** A Postgres URL or PGPASSWORD with a real password for a host that is not local. */
function findPostgresPassword(content, isTest, localHosts) {
  const urlRe = /postgres(?:ql)?:\/\/([^\s:/@'"`]{1,256}):([^\s@'"`]{1,256})@([^\s/:?'"`,;)]{1,256})/gi;
  for (const m of content.matchAll(urlRe)) {
    const [, , password, host] = m;
    if (isLocalHost(host, localHosts) || isPlaceholder(password)) continue;
    if (isTest && !HOSTED_DATABASE.test(host)) continue;
    return 'Postgres URL with an inline password';
  }
  if (isTest) return null;
  for (const m of content.matchAll(/\bPGPASSWORD\s*[=:]\s*["']?([^\s"';&|`]+)/g)) {
    if (!isPlaceholder(m[1])) return 'PGPASSWORD value';
  }
  return null;
}

/**
 * The kind of credential `content` holds, or null. `filePath` relaxes the
 * database-URL checks in test files; `localHosts` are the database hosts whose
 * passwords are not secrets.
 */
export function findSecret(content, filePath = '', { localHosts = DEFAULT_LOCAL_HOSTS } = {}) {
  if (typeof content !== 'string' || content === '') return null;
  const isTest = TEST_PATH.test(String(filePath).replace(/\\/g, '/'));
  const label = findPrivateKey(content) ?? findToken(content) ?? findServiceRoleJwt(content) ?? findPostgresPassword(content, isTest, localHosts);
  return label ? { label } : null;
}
