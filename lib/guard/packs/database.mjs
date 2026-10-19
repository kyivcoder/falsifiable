// The database pack: agents reach only local databases (guard.localHosts).
// Any other host counts as production: database shells, Prisma schema
// changes, Supabase CLI commands that touch a linked project, Supabase MCP
// tools that change a project, and SQL through MCP that is not read-only.
//
// A command's hosts come from its arguments (host, hostaddr, URL authority and
// query, all of which may list several) and from the Postgres environment it
// runs with (PGHOST, PGHOSTADDR, PGSERVICE). A service, or a host the guard
// cannot resolve, blocks. Variables expand from the shell variables set earlier
// in the same command line, in order.
//
// Best effort: a script that opens a database itself is invisible here.
//
// Tests: node --test test/guard/engine.test.mjs
import { block, flagValue, hasFlag, positionals } from '../args.mjs';
import { isLocalHost } from '../secrets.mjs';
import { classifySql } from '../sql.mjs';

const PG_BINS = new Set(['psql', 'pgcli', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pg_basebackup']);
const PG_NON_TARGET_OPTS = new Set(['-c', '-f', '-v', '-o', '-L', '-U', '-p', '-P', '-T', '-F', '-R', '-n', '-N', '-t', '-Z', '-E', '-S', '-j', '-I',
  '--command', '--file', '--set', '--variable', '--output', '--log-file', '--username', '--port', '--table', '--schema', '--format', '--jobs']);
const PG_TARGET_OPTS = new Set(['-h', '--host', '-d', '--dbname', '-D', '--dsn']);
const PG_URL = /^postgres(?:ql)?:\/\//i;
const CONNINFO_KEY = /\b(host|hostaddr|service|dbname|user|password|port|sslmode|options|target_session_attrs)\s*=/i;

/**
 * `word` with $NAME and ${NAME} expanded from `vars` (the shell variables set
 * earlier in the same command); null when a reference cannot be resolved
 * (unset, or set from $(...)).
 */
export function expandVars(word, vars) {
  if (typeof word !== 'string') return null;
  let unresolved = false;
  const out = word.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, braced, bare) => {
    const value = vars[braced ?? bare];
    if (typeof value !== 'string' || value === '' || /[$`]/.test(value)) unresolved = true;
    return value ?? '';
  });
  return unresolved || /[$`]/.test(out) ? null : out;
}

const splitHosts = (value) => String(value).split(',').map((h) => h.trim()).filter((h) => h !== '');

/** The host of a `host[:port]` or `[v6]:port` chunk of a URL authority, with any userinfo dropped. */
function authorityHost(chunk) {
  let a = chunk;
  const at = a.lastIndexOf('@');
  if (at !== -1) a = a.slice(at + 1);
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end === -1 ? a.slice(1) : a.slice(1, end);
  }
  const colon = a.indexOf(':');
  return colon === -1 ? a : a.slice(0, colon);
}

/** The hosts a conninfo string names, and whether it selects a service. */
function conninfoHosts(word) {
  const hosts = [];
  let service = false;
  for (const m of word.matchAll(/(\w+)\s*=\s*('[^']*'|"[^"]*"|\S+)/g)) {
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (key === 'host' || key === 'hostaddr') hosts.push(...splitHosts(value));
    if (key === 'service') service = true;
  }
  return { hosts, service };
}

/** The hosts a Postgres URL names (authority list plus host/hostaddr query parameters), and whether it selects a service. */
function urlHosts(word) {
  const rest = word.replace(PG_URL, '');
  const authority = rest.split(/[/?#]/)[0];
  const query = word.includes('?') ? word.slice(word.indexOf('?') + 1) : '';
  const hosts = [];
  let service = false;
  for (const chunk of authority.split(',')) {
    const host = authorityHost(chunk);
    if (host !== '') hosts.push(host);
  }
  for (const m of query.matchAll(/(\w+)=([^&;#]*)/g)) {
    const key = m[1].toLowerCase();
    let value = m[2];
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value */
    }
    if (key === 'host' || key === 'hostaddr') hosts.push(...splitHosts(value));
    if (key === 'service') service = true;
  }
  return { hosts, service };
}

/** The hosts a target word reaches: {hosts} to check, {service} when a service file decides, {unknown} when the guard cannot tell. */
function hostsOf(word, isHostValue) {
  if (word === null || /[$`]/.test(word)) return { unknown: true };
  if (isHostValue) return { hosts: splitHosts(word) };
  if (PG_URL.test(word)) return urlHosts(word);
  if (CONNINFO_KEY.test(word)) return conninfoHosts(word);
  return { hosts: [] };
}

/** Every word of a Postgres client argv that names a host, a database or a connection URL. */
function pgTargets(argv) {
  const targets = [];
  for (let k = 1; k < argv.length; k += 1) {
    const a = argv[k];
    if (PG_URL.test(a)) targets.push({ word: a });
    else if (PG_TARGET_OPTS.has(a)) {
      if (argv[k + 1] !== undefined) targets.push({ word: argv[k + 1], host: a === '-h' || a === '--host' });
      k += 1;
    } else if (/^-[hd]./.test(a)) targets.push({ word: a.slice(2), host: a[1] === 'h' });
    else if (/^--(host|dbname|dsn)=/.test(a)) targets.push({ word: a.slice(a.indexOf('=') + 1), host: a.startsWith('--host') });
    else if (PG_NON_TARGET_OPTS.has(a)) k += 1;
    else if (!a.startsWith('-')) targets.push({ word: a });
  }
  return targets;
}

const hostsText = (ctx) => (ctx.guard.localHosts.length ? ctx.guard.localHosts.join(', ') : 'none configured');

/** Postgres clients pointed anywhere but a local host. */
function databaseShell(cmd, ctx) {
  const { argv } = cmd;
  if (!PG_BINS.has(argv[0])) return null;
  const env = cmd.env ?? {};
  const vars = cmd.vars ?? {};
  const local = ctx.guard.localHosts;
  const instead = `Use a local database (local hosts: ${hostsText(ctx)}) or a read-only query; anything that must touch production goes through the user`;
  const bad = (why) => block('db-remote-shell', why, instead);
  const service = () => bad(`${argv[0]} selects a Postgres service, whose host the guard cannot resolve`);
  if ('PGPASSWORD' in env) return bad(`${argv[0]} is given a password through PGPASSWORD`);
  if (env.PGSERVICE !== undefined || env.PGSERVICEFILE !== undefined) return service();

  let commandHasHost = false;
  const check = (info, where) => {
    if (info.unknown) return bad(`${argv[0]} targets ${where}, which is not clearly a local database`);
    if (info.service) return service();
    if (info.hosts.length) commandHasHost = true;
    for (const host of info.hosts) {
      if (host !== '' && !isLocalHost(host, local)) return bad(`${argv[0]} targets ${host}, which is not a local host`);
    }
    return null;
  };

  const targets = pgTargets(argv);
  if (env.DATABASE_URL !== undefined && argv.length === 1) targets.push({ word: env.DATABASE_URL });
  for (const { word: raw, host: isHostValue } of targets) {
    const hit = check(hostsOf(expandVars(raw, vars), isHostValue), raw);
    if (hit) return hit;
  }
  if (env.PGHOSTADDR !== undefined) {
    const hit = check({ hosts: splitHosts(env.PGHOSTADDR) }, `PGHOSTADDR=${env.PGHOSTADDR}`);
    if (hit) return hit;
  }
  if (!commandHasHost && env.PGHOST !== undefined) {
    const hit = check({ hosts: splitHosts(env.PGHOST) }, `PGHOST=${env.PGHOST}`);
    if (hit) return hit;
  }
  return null;
}

const PRISMA_WRITES = { migrate: ['deploy', 'reset', 'dev', 'resolve'], db: ['push', 'execute'] };

/** True when every url in `urls` resolves to a local host. */
function allLocal(urls, local) {
  if (urls.length === 0) return false;
  return urls.every((url) => {
    const info = hostsOf(url, false);
    return !info.unknown && !info.service && info.hosts.length > 0 && info.hosts.every((h) => h !== '' && isLocalHost(h, local));
  });
}

/** Prisma schema pushes and migrations not pinned to a local host. */
function prismaWrite(cmd, ctx) {
  const { argv } = cmd;
  if (argv[0] !== 'prisma') return null;
  const [group, action] = positionals(argv, ['--schema', '--file', '--url', '--name']);
  if (!PRISMA_WRITES[group]?.includes(action)) return null;
  const env = cmd.env ?? {};
  const urlFlag = flagValue(argv, '--url');
  const urls = [env.DATABASE_URL, env.DIRECT_URL, urlFlag === undefined ? undefined : expandVars(urlFlag, cmd.vars ?? {})].filter((u) => u !== undefined && u !== null);
  if (allLocal(urls, ctx.guard.localHosts)) return null;
  return block(
    'db-remote-migrate',
    `prisma ${group} ${action} changes whatever database DATABASE_URL points to, and this command does not pin it to a local host`,
    `Run it against a local database by prefixing DATABASE_URL=<a URL on ${hostsText(ctx)}>; production migrations ship through the user's release`,
  );
}

const SUPABASE_GLOBAL_OPTS = ['--workdir', '--profile', '--dns-resolver', '--network-id', '-o', '--output', '--project-ref'];
const SUPABASE_REMOTE = new Set([
  'functions deploy', 'functions delete', 'projects create', 'projects delete', 'branches create', 'branches delete',
  'branches update', 'branches pause', 'branches unpause', 'config push', 'postgres-config update', 'postgres-config delete',
  'backups restore', 'network-restrictions update', 'ssl-enforcement update', 'domains create', 'domains activate',
  'domains delete', 'domains reverify', 'vanity-subdomains activate', 'vanity-subdomains delete', 'sso add', 'sso remove',
  'sso update', 'network-bans remove', 'encryption update-root-key', 'orgs create',
]);

/** The host a --db-url points at, '' for a socket or plain name, null when unknown. */
function dbUrlHost(url) {
  const info = hostsOf(url, false);
  if (info.unknown || info.service) return null;
  return info.hosts[0] ?? '';
}

/** Supabase CLI commands that change or read out a linked project. */
function supabaseCli({ argv }, ctx) {
  if (argv[0] !== 'supabase') return null;
  const [group = '', action = ''] = positionals(argv, SUPABASE_GLOBAL_OPTS);
  const dbUrl = flagValue(argv, '--db-url');
  const host = dbUrl === undefined ? undefined : dbUrlHost(dbUrl);
  const dbUrlLocal = typeof host === 'string' && host !== '' && isLocalHost(host, ctx.guard.localHosts);
  const local = hasFlag(argv, '--local') || dbUrlLocal;
  const linked = hasFlag(argv, '--linked') || (dbUrl !== undefined && !dbUrlLocal);
  const key = `${group} ${action}`;
  const remote =
    (['db push', 'db dump', 'migration repair'].includes(key) && !local) ||
    (['db reset', 'migration up', 'migration down', 'migration squash', 'seed buckets'].includes(key) && linked) ||
    (['storage rm', 'storage mv', 'storage cp'].includes(key) && !local) ||
    group === 'secrets' ||
    SUPABASE_REMOTE.has(key);
  if (!remote) return null;
  return block(
    'db-supabase-cli',
    `supabase ${key.trim()} changes or reads out the linked (production) Supabase project`,
    'Use the local stack (supabase start, --local) and leave remote changes to the user',
  );
}

const SUPABASE_WRITE_TOOL =
  /^(apply|deploy|create|delete|drop|merge|reset|rebase|pause|restore|unpause|update|upsert|insert|remove|set|enable|disable|rollback|upload|move|rename|revoke|grant|truncate)_/i;

/** Supabase MCP tools that change a project, and execute_sql that writes. */
function supabaseTool({ server, name, input }) {
  if (!/supabase/i.test(server)) return null;
  if (name === 'execute_sql') {
    const verdict = classifySql(input.query ?? input.sql);
    if (verdict.readOnly) return null;
    return block(
      'db-mcp-sql-write',
      `execute_sql runs only read-only SQL here (SELECT, WITH ... SELECT, EXPLAIN, SHOW), and this query ${verdict.reason}`,
      'Put data or schema changes in a migration in the repository for the user to review',
    );
  }
  if (!SUPABASE_WRITE_TOOL.test(name)) return null;
  return block('db-mcp-write', `the MCP tool ${name} changes the Supabase project`, 'Write a migration or a code change in the repository instead; the user applies it in a release');
}

export const pack = Object.freeze({
  name: 'database',
  emits: Object.freeze(['db-remote-shell', 'db-remote-migrate', 'db-supabase-cli', 'db-mcp-write', 'db-mcp-sql-write']),
  command: Object.freeze([databaseShell, prismaWrite, supabaseCli]),
  mcp: Object.freeze([supabaseTool]),
});
