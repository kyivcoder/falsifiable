// Best-effort shell reading for the guard. It is not a full POSIX parser: it
// is tuned to see through the forms agents actually write (compound commands,
// quotes, $(...), bash -c, eval, env/npx/pnpm wrappers, heredocs) and to err on
// the side of finding a command rather than missing one.
//
//   collectCommands('cd api && npx prisma db push', '/repo')
//     -> {commands: [{argv: ['cd', 'api'], ...}, {argv: ['prisma', 'db', 'push'], dir: '/repo/api', ...}], allAssigns}
//
// Tests: node --test test/guard/shell.test.mjs
import path from 'node:path';

const isDigits = (s) => /^\d+$/.test(s);

/** The command strings inside the $(...) and backticks of `text`, for expanding an unquoted heredoc body. */
export function commandSubs(text) {
  const subs = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
      }
      subs.push(text.slice(i + 2, j - 1));
      i = j - 1;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) break;
      subs.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return subs;
}

/**
 * Splits a command line into simple commands. `depth` bounds how far it follows
 * heredoc bodies into themselves.
 * @returns {{words: string[], redirects: string[], inputs: string[], depth: number, piped: boolean}[]}
 *   redirects are the output targets, inputs the input ones; depth counts the
 *   subshells around the command, and piped marks a part of a pipeline
 */
export function parseShell(command, depth = 0) {
  const s = String(command);
  const n = s.length;
  const segments = [];
  let words = [];
  let redirects = [];
  let inputs = [];
  let cur = null;
  let pending = null; // 'out' | 'in' | 'heredoc'
  let quote = null;
  const heredocs = [];
  let heredocStrip = false;
  let heredocQuoted = false;
  const frames = []; // the open subshells: ( ), $( ), <( ), backticks, each with its own id
  let nextFrame = 0;
  const open = () => frames.push((nextFrame += 1));
  const close = () => frames.pop();
  let inBacktick = false;
  let afterPipe = false;

  const pushWord = () => {
    if (cur === null) return;
    if (pending === 'out') redirects.push(cur);
    else if (pending === 'heredoc') heredocs.push({ delim: cur, strip: heredocStrip, quoted: heredocQuoted, cmd: words[0] });
    else if (pending === 'in') inputs.push(cur);
    else words.push(cur);
    pending = null;
    cur = null;
  };
  const endSegment = (endsWithPipe = false) => {
    pushWord();
    if (words.length || redirects.length || inputs.length) {
      segments.push({ words, redirects, inputs, depth: frames.length, frames: [...frames], piped: afterPipe || endsWithPipe });
      afterPipe = endsWithPipe;
    } else if (endsWithPipe) afterPipe = true;
    words = [];
    redirects = [];
    inputs = [];
    pending = null;
  };
  const consumeHeredocBodies = (start) => {
    let i = start;
    while (heredocs.length && i < n) {
      const { delim, strip, quoted, cmd } = heredocs.shift();
      const lines = [];
      while (i < n) {
        const eol = s.indexOf('\n', i);
        const line = s.slice(i, eol === -1 ? n : eol);
        i = eol === -1 ? n : eol + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        lines.push(line);
      }
      // A quoted delimiter (<<'EOF') keeps the body inert. An unquoted body is
      // expanded: a shell runs the whole body as a script, and any $(...) or
      // backticks in it run as commands.
      if (quoted || depth >= 3) continue;
      const body = lines.join('\n');
      const script = SHELLS.has(binName(cmd ?? '')) ? body : commandSubs(body).join('\n');
      if (script.trim() !== '') for (const seg of parseShell(script, depth + 1)) segments.push(seg);
    }
    return i;
  };

  let i = 0;
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i += 1;
      } else if (c === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
        cur += next;
        i += 2;
      } else if (c === '`' || (c === '$' && next === '(' && s[i + 2] !== '(')) {
        quote = null;
        endSegment();
        if (c === '`') inBacktick = !inBacktick;
        if (c === '`' && !inBacktick) close();
        else open();
        i += c === '`' ? 1 : 2;
      } else {
        cur += c;
        i += 1;
      }
      continue;
    }
    if (c === '\\') {
      if (next === '\n') i += 2;
      else {
        if (pending === 'heredoc') heredocQuoted = true;
        cur = (cur ?? '') + (next ?? '');
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      if (pending === 'heredoc') heredocQuoted = true;
      quote = c;
      cur = cur ?? '';
      i += 1;
      continue;
    }
    if (c === '$' && next === "'") {
      if (pending === 'heredoc') heredocQuoted = true;
      quote = "'";
      cur = cur ?? '';
      i += 2;
      continue;
    }
    if (c === '$' && next === '(' && s[i + 2] !== '(') {
      endSegment();
      open();
      i += 2;
      continue;
    }
    if (c === '#' && cur === null) {
      const eol = s.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (c === '`') {
      endSegment();
      inBacktick = !inBacktick;
      if (inBacktick) open();
      else close();
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      i += 1;
      continue;
    }
    if (c === '\n') {
      endSegment();
      i = consumeHeredocBodies(i + 1);
      continue;
    }
    if (c === ';' || c === '(' || c === ')') {
      endSegment();
      if (c === '(') open();
      if (c === ')') close();
      i += 1;
      continue;
    }
    if (c === '&') {
      if (next === '>') {
        pushWord();
        pending = 'out';
        i += s[i + 2] === '>' ? 3 : 2;
      } else {
        endSegment();
        i += next === '&' ? 2 : 1;
      }
      continue;
    }
    if (c === '|') {
      endSegment(next !== '|');
      i += next === '|' || next === '&' ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<') {
      if (cur !== null && isDigits(cur)) cur = null;
      else pushWord();
      if (next === '(') {
        endSegment();
        open();
        i += 2;
        continue;
      }
      if (c === '<') {
        if (next === '<' && s[i + 2] !== '<') {
          heredocStrip = s[i + 2] === '-';
          heredocQuoted = false;
          pending = 'heredoc';
          i += heredocStrip ? 3 : 2;
        } else {
          pending = 'in';
          i += next === '<' ? 3 : next === '>' ? 2 : 1;
        }
        continue;
      }
      let j = i + 1;
      if (s[j] === '>' || s[j] === '|') j += 1;
      if (s[j] === '&') {
        j += 1;
        while (j < n && /[\d-]/.test(s[j])) j += 1;
        i = j;
        continue;
      }
      pending = 'out';
      i = j;
      continue;
    }
    cur = (cur ?? '') + c;
    i += 1;
  }
  endSegment();
  return segments;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PASSTHROUGH = new Set(['command', 'builtin', 'exec', 'nohup', 'noglob', 'caffeinate']);
/** Well-known package scripts that wrap a command the guard checks: `pnpm db:push` is `prisma db push`. */
const SCRIPT_ALIASES = {
  'db:push': ['prisma', 'db', 'push'],
  'db:migrate': ['prisma', 'migrate', 'dev'],
};
/** npm packages whose binary has another name: `npx @railway/cli up` runs `railway up`. */
const PACKAGE_BINS = { '@railway/cli': 'railway' };
/** Secret and env injectors that run the command after `--`: `dotenv -e .env.production -- cmd`. */
const ENV_RUNNERS = new Set(['dotenv', 'dotenvx', 'doppler', 'op', 'infisical', 'with-env']);
const CONTAINER_VALUE_OPTS = ['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--name', '-v', '--volume', '-p', '--publish', '--entrypoint', '--network'];

/** A program word normalised: the path's basename, with an npx-style @version stripped. */
export function binName(word) {
  const w = String(word);
  for (const [pkg, bin] of Object.entries(PACKAGE_BINS)) if (w === pkg || w.startsWith(`${pkg}@`)) return bin;
  const base = path.posix.basename(w);
  return base.replace(/^(.+?)@.*$/, '$1');
}

const skipOptions = (words, i, valueOptions = []) => {
  let j = i;
  while (j < words.length && words[j].startsWith('-') && words[j] !== '-') {
    j += valueOptions.includes(words[j]) ? 2 : 1;
  }
  return j;
};

/**
 * Strips wrappers (env, sudo, timeout, xargs, npx, pnpm exec, package scripts,
 * secret injectors, docker exec) and leading VAR=value assignments.
 * @returns {{argv: string[], assigns: Record<string, string>}}
 */
export function unwrapCommand(words) {
  const assigns = {};
  let i = 0;
  for (let guard = 0; guard < 50 && i < words.length; guard += 1) {
    const w = words[i];
    if (KEYWORDS.has(w)) {
      i += 1;
      continue;
    }
    const m = ASSIGNMENT.exec(w);
    if (m) {
      assigns[m[1]] = m[2];
      i += 1;
      continue;
    }
    const bin = binName(w);
    if (bin === 'env') {
      i = skipOptions(words, i + 1, ['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
      continue;
    }
    if (bin === 'sudo' || bin === 'doas') {
      i = skipOptions(words, i + 1, ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']);
      continue;
    }
    if (PASSTHROUGH.has(bin)) {
      i = skipOptions(words, i + 1, ['-a']);
      continue;
    }
    if (bin === 'nice') {
      i = skipOptions(words, i + 1, ['-n']);
      continue;
    }
    if (bin === 'timeout') {
      i = skipOptions(words, i + 1, ['-s', '--signal', '-k', '--kill-after']) + 1;
      continue;
    }
    if (bin === 'stdbuf') {
      i = skipOptions(words, i + 1, ['-i', '-o', '-e']);
      continue;
    }
    if (bin === 'xargs') {
      i = skipOptions(words, i + 1, ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a']);
      continue;
    }
    if (ENV_RUNNERS.has(bin)) {
      const dashDash = words.indexOf('--', i + 1);
      if (dashDash !== -1) {
        i = dashDash + 1;
        continue;
      }
      let j = i + 1;
      if (words[j] === 'run') j += 1;
      i = skipOptions(words, j, ['-e', '-c', '-v', '-p', '-f', '--env-file', '--project', '--config']);
      continue;
    }
    if (bin === 'docker' || bin === 'podman' || bin === 'docker-compose') {
      let j = i + 1;
      if (words[j] === 'compose') j += 1;
      if (words[j] !== 'exec' && words[j] !== 'run') break;
      i = skipOptions(words, j + 1, CONTAINER_VALUE_OPTS) + 1;
      continue;
    }
    if (bin === 'npx' || bin === 'bunx' || bin === 'pnpx') {
      i = skipOptions(words, i + 1, ['-p', '--package', '-c', '--call']);
      continue;
    }
    if (bin === 'pnpm' || bin === 'yarn' || bin === 'npm' || bin === 'bun') {
      let j = skipOptions(words, i + 1, ['--filter', '-F', '-C', '--dir', '--prefix', '-w', '--workspace', '--reporter', '--loglevel']);
      const sub = words[j];
      if (sub === undefined) return { argv: words.slice(i), assigns };
      if (['exec', 'dlx', 'x'].includes(sub)) {
        i = skipOptions(words, j + 1, ['--package', '-p', '-c']);
        continue;
      }
      if (sub === 'run' || sub === 'run-script') j += 1;
      const script = words[j];
      if (script && SCRIPT_ALIASES[script]) {
        return { argv: [...SCRIPT_ALIASES[script], ...words.slice(j + 1)], assigns };
      }
      if (bin === 'npm' || sub === 'run' || sub === 'run-script') return { argv: words.slice(i), assigns };
      i = j;
      continue;
    }
    break;
  }
  const argv = words.slice(i);
  if (argv.length) argv[0] = binName(argv[0]);
  return { argv, assigns };
}

const EXPORTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

const resolveDir = (dir, target) => {
  if (!target || target === '-' || target.startsWith('~') || target.includes('$')) return null;
  if (target.startsWith('/')) return path.posix.normalize(target);
  return dir === null ? null : path.posix.join(dir, target);
};

const EMPTY_SCOPE = Object.freeze({ vars: Object.freeze({}), exported: new Set() });

/** `scope` with `assigns` set as shell variables, and exported when `exported` is true. */
function withAssigns(scope, assigns, exported) {
  const names = Object.keys(assigns);
  if (names.length === 0) return scope;
  return { vars: { ...scope.vars, ...assigns }, exported: exported ? new Set([...scope.exported, ...names]) : scope.exported };
}

/** `scope` after export, declare, typeset, readonly or local: their assignments, exported for export and -x. */
function declared(scope, argv) {
  const exporting = argv[0] === 'export' || argv.slice(1).some((a) => /^-[a-zA-Z]*x/.test(a));
  const assigns = {};
  const names = [];
  for (const word of argv.slice(1)) {
    if (word.startsWith('-')) continue;
    const m = ASSIGNMENT.exec(word);
    if (m) {
      assigns[m[1]] = m[2];
      names.push(m[1]);
    } else if (/^[A-Za-z_]\w*$/.test(word)) names.push(word);
  }
  const vars = Object.keys(assigns).length ? { ...scope.vars, ...assigns } : scope.vars;
  const exported = exporting && names.length ? new Set([...scope.exported, ...names]) : scope.exported;
  return { vars, exported };
}

/** What a child shell started by a command inherits: the exported variables, plus the command's own prefix assignments. */
function childScope(scope, assigns) {
  const vars = {};
  for (const name of scope.exported) if (Object.hasOwn(scope.vars, name)) vars[name] = scope.vars[name];
  return { vars: { ...vars, ...assigns }, exported: new Set([...scope.exported, ...Object.keys(assigns)]) };
}

/**
 * Every simple command in `command`, including those inside $(...), bash -c
 * and eval, with the folder it runs in (followed through cd; null once a cd
 * cannot be followed) and the shell variables set before it.
 *
 * `vars` are the variables a command sees, in execution order: a prefix
 * assignment (`A=1 cmd`) is only in that command's `assigns`; a standalone
 * assignment or an export applies to the commands after it in the same shell.
 * A subshell, a command substitution or a part of a pipeline keeps its own
 * assignments; bash -c inherits only the exported ones; eval shares the shell.
 * `exported` names the variables a command's environment carries. `allAssigns`
 * is every assignment anywhere in the line, for rules that block on any.
 * @returns {{commands: {argv: string[], assigns: object, redirects: string[], inputs: string[], dir: string|null, vars: Record<string, string>, exported: Set<string>}[], allAssigns: Record<string, string>, scope: {vars: object, exported: Set<string>}}}
 */
export function collectCommands(command, cwd = '', depth = 0, inherited = EMPTY_SCOPE) {
  const commands = [];
  const allAssigns = {};
  const stack = [inherited];
  const open = [];
  let dir = cwd ?? '';
  for (const segment of parseShell(command)) {
    let shared = 0;
    while (shared < open.length && open[shared] === segment.frames[shared]) shared += 1;
    open.length = shared;
    stack.length = shared + 1;
    for (const frame of segment.frames.slice(shared)) {
      open.push(frame);
      stack.push(stack[stack.length - 1]);
    }
    const before = stack[stack.length - 1];
    const { argv, assigns } = unwrapCommand(segment.words);
    Object.assign(allAssigns, assigns);
    const cmd = argv[0];
    let after = before;
    if (argv.length === 0) after = withAssigns(before, assigns, false);
    else if (EXPORTERS.has(cmd)) {
      after = declared(before, argv);
      for (const word of argv.slice(1)) {
        const m = ASSIGNMENT.exec(word);
        if (m) allAssigns[m[1]] = m[2];
      }
    }
    if (argv.length > 0 || segment.redirects.length > 0 || segment.inputs.length > 0) {
      commands.push({ argv, assigns, redirects: segment.redirects, inputs: segment.inputs, dir, vars: before.vars, exported: before.exported });
    }
    if ((cmd === 'cd' || cmd === 'pushd') && argv.length >= 2) dir = resolveDir(dir, argv[argv.length - 1]);
    if (depth < 3) {
      let nested = null;
      if (SHELLS.has(cmd)) {
        const flagIndex = argv.findIndex((a, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        if (flagIndex > 0 && argv[flagIndex + 1] !== undefined) nested = argv[flagIndex + 1];
      } else if (cmd === 'eval') {
        nested = argv.slice(1).join(' ');
      }
      if (nested !== null) {
        const inner = collectCommands(nested, dir, depth + 1, cmd === 'eval' ? withAssigns(before, assigns, true) : childScope(before, assigns));
        commands.push(...inner.commands);
        Object.assign(allAssigns, inner.allAssigns);
        if (cmd === 'eval') after = inner.scope;
      }
    }
    if (!segment.piped) stack[stack.length - 1] = after;
  }
  return { commands, allAssigns, scope: stack[0] };
}
