// Tests for the guard's shell reader (lib/guard/shell.mjs): splitting a
// command line, unwrapping wrappers, and following bash -c, eval and cd.
//
//   node --test test/guard/shell.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { binName, collectCommands, parseShell, unwrapCommand } from '../../lib/guard/shell.mjs';

const argvs = (command, cwd) => collectCommands(command, cwd).commands.map((c) => c.argv);

describe('parseShell()', () => {
  test('splits on shell operators and keeps quoted words whole', () => {
    const segments = parseShell(`git add . && git commit -m "a && b" ; echo 'x|y' | cat`);
    assert.deepEqual(segments.map((s) => s.words), [['git', 'add', '.'], ['git', 'commit', '-m', 'a && b'], ['echo', 'x|y'], ['cat']]);
  });

  test('records output redirection targets, not input ones', () => {
    const [segment] = parseShell('sort < in.txt > out.txt 2>>err.log');
    assert.deepEqual(segment.words, ['sort']);
    assert.deepEqual(segment.redirects, ['out.txt', 'err.log']);
  });

  test('treats 2>&1 as a file descriptor copy, not a target', () => {
    const [segment] = parseShell('make 2>&1');
    assert.deepEqual(segment.redirects, []);
  });

  test('treats command substitution as its own segment', () => {
    const words = parseShell('echo "$(git push origin main)"').map((s) => s.words.join(' '));
    assert.ok(words.includes('git push origin main'), JSON.stringify(words));
  });

  test('skips heredoc bodies', () => {
    const words = parseShell(`cat <<'EOF' > notes.txt\ngit push origin main\nEOF\necho done`).map((s) => s.words.join(' '));
    assert.deepEqual(words, ['cat', 'echo done']);
  });

  test('drops comments', () => {
    assert.deepEqual(parseShell('echo hi # git push origin main').map((s) => s.words), [['echo', 'hi']]);
  });
});

describe('unwrapCommand()', () => {
  const cases = [
    ['env with an assignment', ['env', 'A=1', 'fly', 'deploy'], ['fly', 'deploy'], { A: '1' }],
    ['leading assignments', ['A=1', 'B=2', 'psql'], ['psql'], { A: '1', B: '2' }],
    ['sudo with a user', ['sudo', '-u', 'postgres', 'psql'], ['psql'], {}],
    ['timeout with its duration', ['timeout', '-s', 'KILL', '30', 'psql'], ['psql'], {}],
    ['xargs', ['xargs', '-n', '1', 'rm'], ['rm'], {}],
    ['npx with a version', ['npx', 'prisma@5', 'migrate', 'deploy'], ['prisma', 'migrate', 'deploy'], {}],
    ['npx with a scoped package that names a known binary', ['npx', '@railway/cli', 'up'], ['railway', 'up'], {}],
    ['pnpm exec', ['pnpm', '--filter', '@app/api', 'exec', 'prisma', 'db', 'push'], ['prisma', 'db', 'push'], {}],
    ['pnpm with a binary', ['pnpm', 'prisma', 'migrate', 'reset'], ['prisma', 'migrate', 'reset'], {}],
    ['pnpm db:push names prisma db push', ['pnpm', 'db:push'], ['prisma', 'db', 'push'], {}],
    ['npm run stays a script run', ['npm', 'run', 'build'], ['npm', 'run', 'build'], {}],
    ['dotenv --', ['dotenv', '-e', '.env', '--', 'psql'], ['psql'], {}],
    ['doppler run --', ['doppler', 'run', '--', 'psql'], ['psql'], {}],
    ['op run --', ['op', 'run', '--env-file=.env', '--', 'psql'], ['psql'], {}],
    ['docker exec with flags and a container', ['docker', 'exec', '-it', 'db', 'psql'], ['psql'], {}],
    ['docker compose exec', ['docker', 'compose', 'exec', 'db', 'psql'], ['psql'], {}],
    ['a path to a binary', ['/usr/local/bin/fly', 'deploy'], ['fly', 'deploy'], {}],
    ['command and nohup', ['nohup', 'command', 'fly', 'deploy'], ['fly', 'deploy'], {}],
    ['a plain command', ['git', 'status'], ['git', 'status'], {}],
  ];
  for (const [name, words, argv, assigns] of cases) {
    test(name, () => assert.deepEqual(unwrapCommand(words), { argv, assigns }));
  }
});

describe('collectCommands()', () => {
  test('follows bash -c, sh -c and eval', () => {
    assert.deepEqual(argvs(`bash -c "git push origin main"`), [['bash', '-c', 'git push origin main'], ['git', 'push', 'origin', 'main']]);
    assert.ok(argvs(`sh -lc 'psql -h db.example.com'`).some((a) => a[0] === 'psql'));
    assert.ok(argvs(`eval "rm -rf .claude"`).some((a) => a.join(' ') === 'rm -rf .claude'));
  });

  test('tracks the folder through cd', () => {
    const { commands } = collectCommands('cd apps/api && rm x && cd .. && rm y', '/repo');
    assert.deepEqual(commands.map((c) => c.dir), ['/repo', '/repo/apps/api', '/repo/apps/api', '/repo/apps']);
  });

  test('loses the folder after a cd it cannot follow', () => {
    const { commands } = collectCommands('cd "$X" && rm y', '/repo');
    assert.equal(commands[1].dir, null);
  });

  test('collects assignments from export and from every segment', () => {
    const { allAssigns } = collectCommands('export A=1; B=2 true; env C=3 true');
    assert.deepEqual(allAssigns, { A: '1', B: '2', C: '3' });
  });
});

describe('collectCommands() scopes assignments the way the shell does', () => {
  const last = (command) => collectCommands(command).commands.at(-1);

  test('a prefix assignment applies to its own command only', () => {
    const { commands } = collectCommands('A=1 true; printenv');
    assert.deepEqual(commands[0].assigns, { A: '1' });
    assert.equal(commands[1].vars.A, undefined);
  });

  test('a standalone assignment applies to later commands, not earlier ones', () => {
    const { commands } = collectCommands('echo "$B"; B=2; echo "$B"');
    assert.equal(commands[0].vars.B, undefined);
    assert.equal(commands[1].vars.B, '2');
    assert.equal(commands[1].exported.has('B'), false);
  });

  test('export marks a variable as exported for later commands', () => {
    const cmd = last('export C=3 D; printenv');
    assert.equal(cmd.vars.C, '3');
    assert.ok(cmd.exported.has('C') && cmd.exported.has('D'));
  });

  test('a subshell keeps its assignments', () => {
    assert.equal(collectCommands('(X=1; printenv)').commands[0].vars.X, '1');
    assert.equal(last('(X=1; export Y=2); printenv').vars.X, undefined);
    assert.equal(last('(X=1; export Y=2); printenv').vars.Y, undefined);
    assert.equal(last('(X=1); (printenv)').vars.X, undefined);
  });

  test('a command substitution keeps its assignments', () => assert.equal(last('echo "$(X=1)"; printenv').vars.X, undefined));

  test('a pipeline part keeps its assignments', () => assert.equal(last('export P=1 | true; printenv').vars.P, undefined));

  test('bash -c sees only exported variables, and keeps its own', () => {
    const { commands } = collectCommands(`export E=1; V=2; bash -c "printenv; export Z=3"; printenv`);
    const inner = commands.find((c, k) => c.argv[0] === 'printenv' && k < commands.length - 1);
    assert.deepEqual(inner.vars, { E: '1' });
    assert.equal(commands.at(-1).vars.Z, undefined);
  });

  test('a prefix on bash -c reaches the inner commands as exported', () => {
    const inner = collectCommands(`PGHOST=db bash -c "psql"`).commands[1];
    assert.equal(inner.vars.PGHOST, 'db');
    assert.ok(inner.exported.has('PGHOST'));
  });

  test('eval runs in the same shell', () => assert.equal(last('eval "X=1"; printenv').vars.X, '1'));
});

describe('parseShell() marks subshells and pipelines', () => {
  test('records the depth and whether a segment is part of a pipeline', () => {
    const segments = parseShell('a; (b | c); d && e | f');
    assert.deepEqual(
      segments.map((s) => [s.words[0], s.depth, s.piped]),
      [['a', 0, false], ['b', 1, true], ['c', 1, true], ['d', 0, false], ['e', 0, true], ['f', 0, true]],
    );
  });
});

describe('binName()', () => {
  test('strips a path and a version', () => {
    assert.equal(binName('/opt/bin/psql'), 'psql');
    assert.equal(binName('vercel@latest'), 'vercel');
  });
});
