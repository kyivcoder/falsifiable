// Tests for the role fences (lib/guard/fence.mjs) against throwaway git
// repositories and worktrees. The fences are allow-lists: the verifier may
// read, write and run only the little its job needs; the reviewer and the
// scout only read.
//
//   node --test test/guard/fence.test.mjs
import './git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { resolveConfig } from '../../lib/config.mjs';
import { fence } from '../../lib/guard/fence.mjs';

const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** A repository with one commit at `root` (created when missing). */
function makeRepo(root) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
  return root;
}

// The main checkout, a worktree nested inside it, a worktree beside it, another
// repository, a plain folder, a scratchpad, and a project that lives under a
// folder named src (as in ~/src/project).
const ROOT = makeRepo(tempDir('fence-'));
const NESTED = path.join(ROOT, '.claude/worktrees/lane');
mkdirSync(path.dirname(NESTED), { recursive: true });
git(ROOT, 'worktree', 'add', '-q', '-b', 'lane', NESTED);
const BESIDE = path.join(tempDir('fence-beside-'), 'wt');
git(ROOT, 'worktree', 'add', '-q', '-b', 'beside', BESIDE);
const OTHER_REPO = makeRepo(tempDir('fence-other-'));
const NO_REPO = tempDir('fence-plain-');
const SCRATCH = tempDir('fence-scratch-');
const UNDER_SRC = makeRepo(path.join(tempDir('fence-home-'), 'src', 'project'));

for (const dir of ['src', 'openspec/changes/foo/specs/cap', '.verify/real', 'e2e']) mkdirSync(path.join(ROOT, dir), { recursive: true });
writeFileSync(path.join(ROOT, 'src/app.ts'), 'export {};\n');
symlinkSync(path.join(ROOT, 'src'), path.join(ROOT, 'openspec/changes/evil'));
symlinkSync(path.join(ROOT, 'src'), path.join(ROOT, '.verify/into-src'));
symlinkSync(path.join(ROOT, '.verify/real'), path.join(ROOT, '.verify/alias'));
symlinkSync(ROOT, path.join(SCRATCH, 'into-repo'));
symlinkSync(path.join(ROOT, 'src/app.ts'), path.join(ROOT, 'openspec/changes/foo/specs/cap/app-link.md'));

const DEFAULT = resolveConfig(undefined).config;
const as = (role) => `falsifiable:${role}`;

/** fence() for one tool call by `role`, from ROOT unless the extra fields say otherwise. */
function check(role, tool, input, extra = {}, config = DEFAULT) {
  return fence({ tool, input, agentType: role && as(role), cwd: ROOT, projectDir: ROOT, scratchpadDir: SCRATCH, ...extra }, config);
}
const write = (role, file, extra) => check(role, 'Write', { file_path: file, content: 'x' }, extra);
const bash = (role, command, extra, config) => check(role, 'Bash', { command }, extra, config);
const read = (role, file, extra) => check(role, 'Read', { file_path: file }, extra);

function assertBlocked(result, rule, pattern) {
  assert.equal(result.allow, false, `expected a block, got ${JSON.stringify(result)}`);
  assert.equal(result.rule, rule, result.message);
  assert.match(result.message, new RegExp(`^falsifiable guard blocked: ${rule}: .+\\. .+\\.$`));
  if (pattern) assert.match(result.message, pattern);
}
const assertAllowed = (result) => assert.deepEqual(result, { allow: true }, result.message);

describe('who is fenced', () => {
  test('the main session and other agents are not', () => {
    assertAllowed(write(undefined, `${ROOT}/src/app.ts`));
    assertAllowed(check(undefined, 'Write', { file_path: `${ROOT}/src/app.ts` }, { agentType: 'reviewer' }));
    assertAllowed(check(undefined, 'Write', { file_path: `${ROOT}/src/app.ts` }, { agentType: 'other-plugin:reviewer' }));
  });

  test('the builder is not', () => {
    assertAllowed(write('builder', `${ROOT}/src/app.ts`));
    assertAllowed(bash('builder', 'git diff && git commit -am x'));
    assertAllowed(read('builder', `${ROOT}/src/app.ts`));
    assertAllowed(check('builder', 'WebFetch', { url: 'https://example.com' }));
  });
});

describe('planner', () => {
  test('may write a change plan, here or in another worktree', () => {
    assertAllowed(write('planner', `${ROOT}/openspec/changes/foo/tasks.md`));
    assertAllowed(write('planner', 'openspec/changes/foo/tasks.md'));
    assertAllowed(write('planner', `${NESTED}/openspec/changes/foo/tasks.md`));
    assertAllowed(write('planner', `${BESIDE}/openspec/changes/foo/tasks.md`));
  });

  test('may not write anything else, and is told where it may', () => {
    assertBlocked(write('planner', `${ROOT}/openspec/changes/foo/design.md`), 'fence-write', /openspec\/changes\/\*\/tasks\.md/);
    assertBlocked(write('planner', `${ROOT}/openspec/changes/a/b/tasks.md`), 'fence-write');
    assertBlocked(check('planner', 'Edit', { file_path: `${ROOT}/src/app.ts` }), 'fence-write');
    assertBlocked(write('planner', `${NESTED}/src/app.ts`), 'fence-write', /src\/app\.ts/);
  });

  test('may not write into another repository or outside every repository', () => {
    assertBlocked(write('planner', `${OTHER_REPO}/openspec/changes/foo/tasks.md`), 'fence-write', /outside every worktree/);
    assertBlocked(write('planner', `${NO_REPO}/openspec/changes/foo/tasks.md`), 'fence-write', /outside every worktree/);
  });

  test('may not write through a symlink that leads out of the allowed files', () => {
    assertBlocked(write('planner', `${ROOT}/openspec/changes/evil/tasks.md`), 'fence-write', /symlink/);
  });

  test('blocks every write when the project is not in a git repository', () => {
    assertBlocked(write('planner', `${NO_REPO}/x.md`, { cwd: NO_REPO, projectDir: NO_REPO }), 'fence-write', /not in a git repository/);
  });

  test('follows delivery.specsDir', () => {
    const config = resolveConfig({ delivery: { specsDir: 'specs' } }).config;
    assertAllowed(check('planner', 'Write', { file_path: `${ROOT}/specs/changes/foo/tasks.md` }, {}, config));
    assertBlocked(check('planner', 'Write', { file_path: `${ROOT}/openspec/changes/foo/tasks.md` }, {}, config), 'fence-write');
  });

  test('may write the plan from the shell, and nothing else', () => {
    assertAllowed(bash('planner', 'cat draft > openspec/changes/foo/tasks.md'));
    assertAllowed(bash('planner', 'ls 2>/dev/null'));
    assertBlocked(bash('planner', 'echo x > README.md'), 'fence-write');
  });

  test('may read and run anything', () => {
    assertAllowed(read('planner', `${ROOT}/src/app.ts`));
    assertAllowed(bash('planner', 'node scripts/plan.mjs'));
    assertAllowed(check('planner', 'WebFetch', { url: 'https://example.com' }));
  });

  test('never changes the repository through git', () => {
    assertBlocked(bash('planner', 'git add -A'), 'fence-write', /changes the repository/);
  });
});

describe('verifier: writes', () => {
  test('may write evidence under .verify/, /dev/null or its scratchpad', () => {
    assertAllowed(write('verifier', `${ROOT}/.verify/foo/report.md`));
    assertAllowed(write('verifier', `${ROOT}/.verify/alias/shots/home.png`));
    assertAllowed(bash('verifier', 'curl -s localhost:3000 > .verify/foo/home.html'));
    assertAllowed(bash('verifier', `curl -s localhost:3000 > ${SCRATCH}/home.html 2>/dev/null`));
    assertAllowed(bash('verifier', 'mkdir -p .verify/shots'));
  });

  test('may not write anywhere else', () => {
    assertBlocked(write('verifier', `${ROOT}/src/app.ts`), 'fence-write', /\.verify\/\*\*/);
    assertBlocked(write('verifier', `${ROOT}/.verify/into-src/app.ts`), 'fence-write', /symlink/);
    assertBlocked(bash('verifier', 'echo x > src/app.ts'), 'fence-write');
    assertBlocked(bash('verifier', 'cd src && mkdir build'), 'fence-write');
  });
});

describe('verifier: reads only the change specs, .verify/ and the configured read paths', () => {
  test('may read the change specs and under .verify/', () => {
    assertAllowed(read('verifier', `${ROOT}/openspec/changes/foo/specs/cap/spec.md`));
    assertAllowed(read('verifier', `${ROOT}/.verify/real/notes.md`));
  });

  test('may not read the rest of the repository, including the plan, design and proposal', () => {
    assertBlocked(read('verifier', `${ROOT}/README.md`), 'fence-read');
    assertBlocked(read('verifier', `${ROOT}/src/app.ts`), 'fence-read', /src\/app\.ts/);
    assertBlocked(read('verifier', `${NESTED}/src/app.ts`), 'fence-read');
    assertBlocked(read('verifier', 'src/app.ts'), 'fence-read');
    for (const file of ['tasks.md', 'design.md', 'proposal.md']) {
      assertBlocked(read('verifier', `${ROOT}/openspec/changes/foo/${file}`), 'fence-read');
    }
  });

  test('may not read source through a symlink out of the allow-list', () => {
    assertBlocked(read('verifier', `${ROOT}/openspec/changes/foo/specs/cap/app-link.md`), 'fence-read');
  });

  test('judges the path inside its repository, so a project under a folder named src works', () => {
    const specs = `${UNDER_SRC}/openspec/changes/x/specs/cap/spec.md`;
    mkdirSync(path.dirname(specs), { recursive: true });
    writeFileSync(specs, 'x');
    assertAllowed(read('verifier', specs, { cwd: UNDER_SRC, projectDir: UNDER_SRC }));
    assertBlocked(read('verifier', `${UNDER_SRC}/README.md`, { cwd: UNDER_SRC, projectDir: UNDER_SRC }), 'fence-read');
  });

  test('follows verify.readPaths', () => {
    const config = resolveConfig({ verify: { readPaths: ['e2e/**'] } }).config;
    assertAllowed(check('verifier', 'Read', { file_path: `${ROOT}/e2e/login.spec.ts` }, {}, config));
    assertBlocked(check('verifier', 'Read', { file_path: `${ROOT}/README.md` }, {}, config), 'fence-read');
  });

  test('may search only inside the allow-list', () => {
    assertAllowed(check('verifier', 'Grep', { pattern: 'x', path: `${ROOT}/openspec/changes/foo/specs` }));
    assertAllowed(check('verifier', 'Grep', { pattern: 'x', path: `${ROOT}/.verify` }));
    assertAllowed(check('verifier', 'Glob', { pattern: '**/spec.md', path: `${ROOT}/openspec/changes/foo/specs` }));
    assertBlocked(check('verifier', 'Grep', { pattern: 'x', path: `${ROOT}/src` }), 'fence-read');
    assertBlocked(check('verifier', 'Grep', { pattern: 'x', path: ROOT }), 'fence-read');
    assertBlocked(check('verifier', 'Grep', { pattern: 'x' }), 'fence-read');
    assertBlocked(check('verifier', 'Grep', { pattern: 'x', path: path.dirname(ROOT) }), 'fence-read');
    assertBlocked(check('verifier', 'Grep', { pattern: 'x', path: `${ROOT}/openspec` }), 'fence-read');
    assertBlocked(check('verifier', 'Glob', { pattern: '*.md', path: ROOT }), 'fence-read');
  });

  test('may read allow-listed files through the shell, not others', () => {
    assertAllowed(bash('verifier', 'cat openspec/changes/foo/specs/cap/spec.md'));
    assertAllowed(bash('verifier', 'jq . .verify/real/data.json'));
    assertAllowed(bash('verifier', 'head -n 5 .verify/real/home.html'));
    assertBlocked(bash('verifier', 'cat src/app.ts'), 'fence-read');
    assertBlocked(bash('verifier', 'cat README.md'), 'fence-read');
    assertBlocked(bash('verifier', 'cat openspec/changes/foo/tasks.md'), 'fence-read');
  });

  test('treats an input redirect as a read', () => {
    assertAllowed(bash('verifier', 'cat < .verify/real/home.html'));
    assertBlocked(bash('verifier', 'cat < src/app.ts'), 'fence-read');
  });
});

describe('verifier: the programs it may run', () => {
  test('may curl or wget the local app', () => {
    assertAllowed(bash('verifier', 'curl -s http://localhost:3000/api/notes'));
    assertAllowed(bash('verifier', 'curl -s localhost:3000'));
    assertAllowed(bash('verifier', 'curl -s http://127.0.0.1:3000/health'));
    assertAllowed(bash('verifier', 'curl -s "http://[::1]:3000/health"'));
    assertAllowed(bash('verifier', 'wget -qO - http://localhost:3000/'));
  });

  test('may run its housekeeping commands', () => {
    for (const command of ['ls .verify', 'echo done', 'printf "%s" x', 'sleep 1', 'date', 'true', 'test -f .verify/real/home.html']) {
      assertAllowed(bash('verifier', command));
    }
  });

  test('refuses curl to anything but the local app over http', () => {
    assertBlocked(bash('verifier', 'curl -s https://example.com/data'), 'fence-tool', /example\.com/);
    assertBlocked(bash('verifier', 'curl -s http://169.254.169.254/latest/meta-data'), 'fence-tool');
    assertBlocked(bash('verifier', 'curl -s file:///etc/passwd'), 'fence-tool', /file:/);
  });

  test('refuses curl output that leaves .verify/', () => {
    assertBlocked(bash('verifier', 'curl -s http://localhost:3000 -o src/app.ts'), 'fence-write');
    assertBlocked(bash('verifier', 'curl -sO http://localhost:3000/app.js'), 'fence-write');
  });

  test('refuses any other program', () => {
    assertBlocked(bash('verifier', 'node scripts/run.mjs'), 'fence-tool');
    assertBlocked(bash('verifier', 'git status'), 'fence-tool');
    assertBlocked(bash('verifier', 'rm -rf .verify'), 'fence-tool');
    assertBlocked(bash('verifier', 'grep -rn TODO .verify'), 'fence-tool');
  });

  test('may run the commands it is configured to run', () => {
    const config = resolveConfig({ verify: { commands: [['npx', 'playwright', 'test']] } }).config;
    assertAllowed(bash('verifier', 'npx playwright test', {}, config));
    assertAllowed(bash('verifier', 'npx playwright test e2e/login.spec.ts', {}, config));
    assertBlocked(bash('verifier', 'npx vitest run', {}, config), 'fence-tool');
  });
});

describe('verifier: the diff and the history', () => {
  const blocked = [
    'git diff',
    'git diff --stat main',
    'git --no-pager diff HEAD~1',
    'git -C ../x diff',
    'git show HEAD',
    'git log -p',
    'git log --patch -1',
    'git log --stat',
    'git log --name-only',
    'git blame src/app.ts',
    'git reflog -p',
    'git difftool',
    'git cat-file -p HEAD:src/app.ts',
    'git stash show',
    'gh pr diff 12',
    'gh pr view 12',
    'gh api repos/o/r/pulls/12/files',
    'gh api repos/o/r/commits/abc',
    'gh api repos/o/r/compare/main...feat',
    `bash -c "git diff"`,
  ];
  for (const command of blocked) {
    test(`blocks ${command}`, () => assertBlocked(bash('verifier', command), 'fence-diff'));
  }
});

describe('verifier: MCP and the web', () => {
  test('may use its browser or testing MCP servers only', () => {
    assertAllowed(check('verifier', 'mcp__chrome__navigate', { url: 'http://localhost:3000' }));
    assertAllowed(check('verifier', 'mcp__playwright__browser_click', {}));
    assertBlocked(check('verifier', 'mcp__supabase__execute_sql', { query: 'select 1' }), 'fence-tool');
    assertBlocked(check('verifier', 'mcp__github__get_pull_request', {}), 'fence-tool');
  });

  test('follows verify.mcpServers', () => {
    const config = resolveConfig({ verify: { mcpServers: ['puppeteer'] } }).config;
    assertAllowed(check('verifier', 'mcp__puppeteer__goto', {}, {}, config));
    assertBlocked(check('verifier', 'mcp__chrome__navigate', {}, {}, config), 'fence-tool');
  });

  test('may not reach the web', () => {
    assertBlocked(check('verifier', 'WebFetch', { url: 'http://localhost:3000' }), 'fence-tool');
    assertBlocked(check('verifier', 'WebSearch', { query: 'x' }), 'fence-tool');
  });
});

describe('reviewer and scout: read-only by allow-list', () => {
  for (const role of ['reviewer', 'scout']) {
    test(`${role}: no file tool may write, even into .verify/ or the scratchpad`, () => {
      assertBlocked(write(role, `${ROOT}/README.md`), 'fence-write', new RegExp(`the ${role} agent writes nothing`));
      assertBlocked(write(role, `${SCRATCH}/notes.md`), 'fence-write');
      assertBlocked(check(role, 'Edit', { file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' }), 'fence-write');
      assertBlocked(check(role, 'MultiEdit', { file_path: `${ROOT}/src/app.ts`, edits: [] }), 'fence-write');
      assertBlocked(check(role, 'NotebookEdit', { notebook_path: `${ROOT}/a.ipynb`, new_source: 'x' }), 'fence-write');
    });

    test(`${role}: may read source and the diff, and run read-only commands`, () => {
      assertAllowed(read(role, `${ROOT}/src/app.ts`));
      assertAllowed(bash(role, 'git diff origin/main...HEAD'));
      assertAllowed(bash(role, 'git log --oneline -20'));
      assertAllowed(bash(role, 'git show HEAD'));
      assertAllowed(bash(role, 'git grep -n TODO'));
      assertAllowed(bash(role, 'git config --get remote.origin.url'));
      assertAllowed(bash(role, 'git remote -v'));
      assertAllowed(bash(role, 'git branch --show-current'));
      assertAllowed(bash(role, 'git worktree list'));
      assertAllowed(bash(role, 'git stash list'));
      assertAllowed(bash(role, 'cat src/app.ts'));
      assertAllowed(bash(role, 'rg TODO src'));
      assertAllowed(bash(role, `sed -n '1,20p' src/app.ts`));
      assertAllowed(bash(role, 'find . -name "*.ts"'));
      assertAllowed(bash(role, 'gh pr diff 12'));
      assertAllowed(bash(role, 'gh pr checks 12'));
      assertAllowed(bash(role, 'gh api repos/o/r/issues/1'));
      assertAllowed(bash(role, 'cd src && cat app.ts'));
      assertAllowed(bash(role, 'diff a.ts b.ts'));
    });

    test(`${role}: shell writes only to /dev/null and the scratchpad`, () => {
      assertAllowed(bash(role, `git log --oneline > ${SCRATCH}/log.txt`));
      assertAllowed(bash(role, 'git status > /dev/null 2>&1'));
      assertBlocked(bash(role, 'echo x > README.md'), 'fence-write');
      assertBlocked(bash(role, `echo x > ${SCRATCH}/into-repo/README.md`), 'fence-write');
      assertBlocked(bash(role, 'echo x > "$TMPDIR/x"'), 'fence-write');
    });

    test(`${role}: refuses any program that is not read-only`, () => {
      assertBlocked(bash(role, 'node scripts/run.mjs'), 'fence-tool');
      assertBlocked(bash(role, 'rm -rf src'), 'fence-tool');
      assertBlocked(bash(role, 'cp a.ts b.ts'), 'fence-tool');
      assertBlocked(bash(role, 'sed -i s/a/b/ src/app.ts'), 'fence-tool');
      assertBlocked(bash(role, 'find . -delete'), 'fence-tool');
      assertBlocked(bash(role, 'git commit -am x'), 'fence-tool');
      assertBlocked(bash(role, 'git checkout main'), 'fence-tool');
      assertBlocked(bash(role, 'git push origin feat/x'), 'fence-tool');
      assertBlocked(bash(role, 'git branch -D old'), 'fence-tool');
      assertBlocked(bash(role, 'git config user.name me'), 'fence-tool');
      assertBlocked(bash(role, 'gh pr merge 12'), 'fence-tool');
      assertBlocked(bash(role, 'gh api -X POST repos/o/r/issues -f title=x'), 'fence-tool');
      assertBlocked(bash(role, 'gh api repos/o/r/dispatches -f event_type=x'), 'fence-tool');
    });

    test(`${role}: MCP tools must be read-shaped`, () => {
      assertAllowed(check(role, 'mcp__github__get_pull_request', {}));
      assertAllowed(check(role, 'mcp__github__list_commits', {}));
      assertAllowed(check(role, 'mcp__linear__search_issues', {}));
      assertBlocked(check(role, 'mcp__supabase__execute_sql', { query: 'select 1' }), 'fence-tool');
      assertBlocked(check(role, 'mcp__github__create_issue', {}), 'fence-tool');
      assertBlocked(check(role, 'mcp__github__update_pull_request', {}), 'fence-tool');
    });

    test(`${role}: may read and search anything with a file tool`, () => {
      assertAllowed(read(role, `${ROOT}/src/app.ts`));
      assertAllowed(check(role, 'Grep', { pattern: 'x', path: ROOT }));
      assertAllowed(check(role, 'Glob', { pattern: '**/*.ts', path: ROOT }));
    });
  }

  test('a configured second opinion may run', () => {
    const config = resolveConfig({ review: { secondOpinion: 'codex exec --sandbox read-only' } }).config;
    assertAllowed(bash('reviewer', 'codex exec --sandbox read-only "review this"', {}, config));
    assertBlocked(bash('reviewer', 'codex apply patch', {}, config), 'fence-tool');
  });
});

describe('the fence fails closed on what it cannot read', () => {
  test('a write without a path', () => assertBlocked(check('reviewer', 'Write', { content: 'x' }), 'malformed-input'));
  test('a read without a path', () => assertBlocked(check('verifier', 'Read', {}), 'malformed-input'));
  test('a shell call without a command', () => assertBlocked(check('scout', 'Bash', {}), 'malformed-input'));
});
