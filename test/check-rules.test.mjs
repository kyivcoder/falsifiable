// Tests for scripts/check-rules.mjs: every rule names one enforcer, and the
// enforcer exists. Run: node --test test/check-rules.test.mjs
//
// Fixtures live in test/fixtures/rules/: `project` resolves every tag kind but
// lint (its CI workflow runs its two checks), `lint` has one ESLint workspace,
// and `fake-eslint` stands in for the project's own ESLint. Each test works on
// a copy in a temporary folder.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';
import { scriptCalls, workflowRuns } from '../lib/runs.mjs';
import { checkRules, extractRules, listRulebooks, makeTargets, parseTag, reviewSlugs } from '../scripts/check-rules.mjs';

// Git sets GIT_DIR and friends inside its hooks; a throwaway repository must never inherit them.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-rules.mjs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'rules');
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A temporary copy of a fixture project (or an empty folder) with `files`
 * written over it, the stand-in ESLint linked into the `eslintIn` folder, and
 * `git init` when asked.
 */
function project(fixture, files = {}, { git = false, eslintIn } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'falsifiable-rules-'));
  dirs.push(dir);
  if (fixture) cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  if (eslintIn !== undefined) {
    mkdirSync(path.join(dir, eslintIn, 'node_modules'), { recursive: true });
    symlinkSync(path.join(FIXTURES, 'fake-eslint'), path.join(dir, eslintIn, 'node_modules', 'eslint'), 'dir');
  }
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** A rulebook whose rules section holds these list items; the first rule is on line 6. */
const rulesDoc = (...rules) => ['# Map', '', '## Rules', '<!-- rules -->', '', ...rules, ''].join('\n');

/** A CI workflow with one job whose steps run these commands. */
const ciWorkflow = (...runs) => ['on: [pull_request]', 'jobs:', '  check:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', ...runs.map((r) => `      - run: ${r}`), ''].join('\n');

const check = (dir, files = ['AGENTS.md']) => checkRules({ root: dir, config: loadConfig(dir).config, files });
const problemsFor = async (dir, file = 'AGENTS.md') => (await check(dir, [file])).problems;
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

describe('extractRules', () => {
  test('reads top-level list items only inside marked sections, with 1-based lines', () => {
    const md = [
      '# Title', // 1
      '', // 2
      '- not a rule: no marker above', // 3
      '', // 4
      '## Rules', // 5
      '<!-- rules -->', // 6
      '', // 7
      'An intro paragraph is not a rule.', // 8
      '', // 9
      '- First rule. [review:a]', // 10
      '- Second rule', // 11
      '  wraps here. [review:b]', // 12
      '', // 13
      '### Sub', // 14
      '', // 15
      '* Third rule under a subheading. [review:c]', // 16
      '', // 17
      '## Commands', // 18
      '', // 19
      '- not a rule: the section ended', // 20
    ].join('\n');
    assert.deepEqual(extractRules(md), [
      { line: 10, text: 'First rule. [review:a]' },
      { line: 11, text: 'Second rule wraps here. [review:b]' },
      { line: 16, text: 'Third rule under a subheading. [review:c]' },
    ]);
  });

  test('the marker may follow blank lines after the heading', () => {
    assert.deepEqual(extractRules('## Rules\n\n<!-- rules -->\n\n- A rule. [review:a]\n'), [{ line: 5, text: 'A rule. [review:a]' }]);
  });

  test('skips fenced code inside a rules section', () => {
    const md = '## Rules\n<!-- rules -->\n```\n- not a rule\n```\n- A rule. [review:a]\n';
    assert.deepEqual(extractRules(md).map((rule) => rule.text), ['A rule. [review:a]']);
  });

  test('numbered items are rules too', () => {
    assert.deepEqual(extractRules('## Rules\n<!-- rules -->\n1. Numbered. [review:a]\n').map((rule) => rule.text), ['Numbered. [review:a]']);
  });
});

describe('parseTag', () => {
  test('returns the one tag at the end of the rule', () => {
    assert.deepEqual(parseTag('Never merge. [hook:gh-merge]'), { tag: { kind: 'hook', value: 'gh-merge' } });
    assert.deepEqual(parseTag('Typed. [lint:@typescript-eslint/no-explicit-any]'), {
      tag: { kind: 'lint', value: '@typescript-eslint/no-explicit-any' },
    });
    assert.deepEqual(parseTag('Specs validate. [check:check:specs]'), { tag: { kind: 'check', value: 'check:specs' } });
  });

  test('rejects a rule without a tag, with two tags, or with a tag that does not end it', () => {
    assert.match(parseTag('No tag here.').error, /no enforcement tag/);
    assert.match(parseTag('Unknown kind. [docs:x]').error, /no enforcement tag/);
    assert.match(parseTag('Two. [review:a] [review:b]').error, /2 enforcement tags/);
    assert.match(parseTag('Early [review:a] then text.').error, /must end the rule/);
    assert.match(parseTag('Empty value. [review:]').error, /malformed/);
  });

  test('ignores tags quoted in inline code', () => {
    assert.match(parseTag('Write `[review:x]` tags.').error, /no enforcement tag/);
    assert.deepEqual(parseTag('Write `[review:x]` tags. [review:tags]'), { tag: { kind: 'review', value: 'tags' } });
  });
});

describe('reviewSlugs', () => {
  test('reads `slug`: items outside code fences, and needs the colon', () => {
    const md = readFileSync(path.join(FIXTURES, 'project', '.claude', 'review-checklist.md'), 'utf8');
    assert.deepEqual([...reviewSlugs(md)].sort(), ['scope', 'secrets', 'tests-prove']);
  });
});

describe('makeTargets', () => {
  test('reads rule targets and skips assignments, recipes, special targets and patterns', () => {
    const text = readFileSync(path.join(FIXTURES, 'project', 'Makefile'), 'utf8');
    assert.deepEqual([...makeTargets(text)].sort(), ['build', 'check-links', 'docs']);
  });
});

describe('checkRules', () => {
  test('each tag kind but lint resolves in the fixture project', async () => {
    const result = await check(project('project'));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.counts, { lint: 0, hook: 2, check: 2, test: 1, review: 2 });
    assert.equal(result.total, 7);
  });

  test('an untagged rule fails with file, line and the rule text', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- Keep tests honest.') }));
    assert.equal(problems.length, 1);
    assert.deepEqual({ ...problems[0], message: undefined }, { file: 'AGENTS.md', line: 6, rule: 'Keep tests honest.', message: undefined });
    assert.match(problems[0].message, /no enforcement tag/);
  });

  test('a rule outside a rules section is not checked', async () => {
    const md = ['# Map', '', '- Untagged, before.', '', '## Rules', '<!-- rules -->', '', '- Tagged. [review:scope]', '', '## Notes', '', '- Untagged, after.', ''];
    const result = await check(project('project', { 'AGENTS.md': md.join('\n') }));
    assert.deepEqual(result.problems, []);
    assert.equal(result.total, 1);
  });

  test('a rulebook without any rules section fails, so a dropped marker cannot hide its rules', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': '# Map\n\n## Rules\n\n- Keep tests honest.\n' }));
    assert.equal(problems.length, 1);
    assert.equal(problems[0].line, 1);
    assert.match(problems[0].message, /no rules section/);
  });

  test('a tag inside inline code does not count', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- End a rule with `[review:scope]`.') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /no enforcement tag/);
  });

  test('a rule with two tags fails', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- Two enforcers. [review:scope] [hook:gh-merge]') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /2 enforcement tags/);
  });

  test('a hook id from guard.blockCommands resolves only with the config that adds it', async () => {
    const rule = rulesDoc('- Never publish. [hook:npm-publish]');
    assert.deepEqual(await problemsFor(project('project', { 'AGENTS.md': rule })), []);
    const problems = await problemsFor(project('project', { 'AGENTS.md': rule, '.claude/falsifiable.json': {} }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /\[hook:npm-publish\] is not a rule id the guard reports/);
  });

  test('a hook tag fails for an id the guard does not report', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- Never deploy. [hook:deploy-everything]') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /\[hook:deploy-everything\] is not a rule id/);
  });

  test('a hook tag fails when the config turns its pack off', async () => {
    const dir = project('project', {
      'AGENTS.md': rulesDoc('- Never deploy from an agent. [hook:deploy-railway]', '- The verifier reads no source. [hook:fence-read]'),
      '.claude/falsifiable.json': { guard: { packs: ['git', 'github', 'database', 'paths', 'secrets'] } },
    });
    const problems = await problemsFor(dir);
    assert.equal(problems.length, 1, 'the fence rules have no pack to turn off');
    assert.match(problems[0].message, /\[hook:deploy-railway\] belongs to the "deploy" pack, which guard\.packs turns off/);
  });

  test('a check tag resolves to a Makefile target, and an assignment is not one', async () => {
    const dir = project('project', {
      'AGENTS.md': rulesDoc('- Builds. [check:build]', '- Docs. [check:docs]', '- Out. [check:OUT]'),
      '.github/workflows/ci.yml': ciWorkflow('make build docs OUT=x'),
    });
    const problems = await problemsFor(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /\[check:OUT\] is not a script in package\.json or a target in the Makefile/);
  });

  test('a check tag fails in a project with neither a package.json nor a Makefile', async () => {
    const problems = await problemsFor(project(null, { 'AGENTS.md': rulesDoc('- Tests pass. [check:test]') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /\[check:test\] is not a script/);
  });

  test('a test tag fails for a missing file, a folder, and a path outside the project', async () => {
    const dir = project('project', {
      'AGENTS.md': rulesDoc('- Gone. [test:proof/gone.test.js]', '- Folder. [test:proof]', '- Outside. [test:../notes.test.js]'),
    });
    const messages = (await problemsFor(dir)).map((p) => p.message);
    assert.equal(messages.length, 3);
    assert.match(messages[0], /\[test:proof\/gone\.test\.js\] does not exist/);
    assert.match(messages[1], /\[test:proof\] is a folder/);
    assert.match(messages[2], /\[test:\.\.\/notes\.test\.js\] is outside the project/);
  });

  test('a review tag fails when its slug is not in the checklist', async () => {
    const dir = project('project', {
      'AGENTS.md': rulesDoc('- Missing. [review:rate-limits]', '- Fenced. [review:in-a-fence]', '- No colon. [review:no-colon]'),
    });
    const problems = await problemsFor(dir);
    assert.equal(problems.length, 3);
    for (const p of problems) assert.match(p.message, /is not a slug in \.claude\/review-checklist\.md/);
  });

  test('a review tag reads the checklist the config names, and says when it does not exist', async () => {
    const rule = rulesDoc('- Scoped. [review:scope]');
    const moved = { review: { checklist: 'docs/checklist.md' } };
    const found = project('project', { 'AGENTS.md': rule, '.claude/falsifiable.json': moved, 'docs/checklist.md': '- `scope`: in scope.\n' });
    assert.deepEqual(await problemsFor(found), []);
    const problems = await problemsFor(project('project', { 'AGENTS.md': rule, '.claude/falsifiable.json': moved }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /\[review:scope\] cannot resolve: docs\/checklist\.md does not exist/);
  });
});

describe('workflowRuns', () => {
  test('reads run steps in every YAML form, and nothing else', () => {
    const yaml = [
      'name: npm run named',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: npm test',
      '      - name: quoted',
      "        run: 'npm run single'",
      '      - run: "npm run double" # a comment',
      '      - name: literal block',
      '        run: |',
      '          npm run one',
      '          make two',
      '',
      '      - run: >-',
      '          npm run',
      '          folded',
      '      # - run: npm run commented',
      '      - name: echo',
      '        env:',
      '          run: npm run env-value',
      '        run: echo done',
      '',
    ].join('\n');
    assert.deepEqual(workflowRuns(yaml), ['npm test', 'npm run single', 'npm run double', 'npm run one\nmake two', 'npm run folded', 'echo done']);
  });

  test('leaves out a step whose working-directory, its own or the nearest default, is another folder', () => {
    const yaml = [
      'defaults:',
      '  run:',
      '    working-directory: app',
      'jobs:',
      '  web:',
      '    defaults:',
      '      run:',
      '        working-directory: ./',
      '    steps:',
      '      - run: npm run web-root',
      '      - run: npm run in-web',
      '        working-directory: web',
      '  api:',
      '    steps:',
      '      - run: npm run in-app',
      '      - working-directory: .',
      '        run: npm run api-root',
      '      - run: npm run workspace-root',
      '        working-directory: ${{ github.workspace }}',
      '',
    ].join('\n');
    assert.deepEqual(workflowRuns(yaml), ['npm run web-root', 'npm run api-root', 'npm run workspace-root']);
  });

  test('reads a sequence written at its key\'s own indent', () => {
    const yaml = ['jobs:', '  t:', '    steps:', '    - run: npm test', '    - run: npm run lint', '      working-directory: web', ''].join('\n');
    assert.deepEqual(workflowRuns(yaml), ['npm test']);
  });
});

describe('scriptCalls', () => {
  const calls = (command) => scriptCalls(command).map(({ kind, name }) => `${kind}:${name}`);

  test('finds the package scripts each package manager runs', () => {
    assert.deepEqual(calls('npm test && npm t; npm run-script a; npm run --if-present b -- --watch; CI=1 npm start'), [
      'script:test',
      'script:test',
      'script:a',
      'script:b',
      'script:start',
    ]);
    assert.deepEqual(calls('pnpm test; pnpm lint; pnpm run c; yarn d; yarn run e; bun run f; node --run g'), [
      'script:test',
      'script:lint',
      'script:c',
      'script:d',
      'script:e',
      'script:f',
      'script:g',
    ]);
  });

  test('finds make targets, and the default goal when none is named', () => {
    assert.deepEqual(calls('make; make build docs OUT=x; $(MAKE) -j 4 lint; ${MAKE} -k check; gmake all'), [
      'target:null',
      'target:build',
      'target:docs',
      'target:lint',
      'target:check',
      'target:all',
    ]);
  });

  test('reads conditions and comments as a shell does', () => {
    assert.deepEqual(calls('# npm run commented\nif [ -n "$CI" ]; then npm run ci; fi'), ['script:ci']);
  });

  test('a command in another folder or package, or no script at all, is not a call', () => {
    const none = [
      'npm --prefix web test',
      'npm test --workspace web',
      'npm -w web run x',
      'pnpm --filter web test',
      'pnpm -C web test',
      'yarn --cwd web test',
      'yarn workspace web test',
      'bun test',
      'make -C web test',
      'make --directory=web test',
      'make -f other.mk test',
      'make -n test',
      'make --dry-run test',
      'pnpm install',
      'yarn add left-pad',
      'pnpm exec lint',
      'cd web && npm test',
      'npx test',
      'echo npm test',
    ];
    for (const command of none) assert.deepEqual(scriptCalls(command), [], command);
  });
});

describe('checkRules: a check runs in CI or a git hook', () => {
  test('a script no CI workflow or git hook runs fails, and says where to run it', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- Lints. [check:lint]') }));
    assert.equal(problems.length, 1);
    assert.match(
      problems[0].message,
      /\[check:lint\] is a script in package\.json, but no CI workflow or git hook runs it; run it from a step in \.github\/workflows\/ or a git hook in \.husky\/ or \.githooks\//,
    );
  });

  test('a make target no CI workflow or git hook runs fails', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- Builds. [check:build]') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /\[check:build\] is a target in the Makefile, but no CI workflow or git hook runs it/);
  });

  test('a check reached through scripts, make prerequisites and recipes counts', async () => {
    const dir = project(null, {
      'package.json': { scripts: { ci: 'npm run check', check: 'npm test && make docs', test: 'node --test', spell: 'cspell .', unused: 'echo unused' } },
      Makefile: ['all: lint-docs', 'lint-docs: links', '\t$(MAKE) spell-check', 'links:', '\tnode links.mjs', 'spell-check:', '\t@npm run spell', 'docs:', '\techo docs', 'orphan:', '\techo orphan', ''].join('\n'),
      '.github/workflows/ci.yml': ciWorkflow('npm run ci', 'make'),
      'AGENTS.md': rulesDoc(
        '- a [check:test]',
        '- b [check:docs]',
        '- c [check:links]',
        '- d [check:spell-check]',
        '- e [check:spell]',
        '- f [check:unused]',
        '- g [check:orphan]',
      ),
    });
    const tags = (await problemsFor(dir)).map((p) => p.message.split(' ')[0]);
    assert.deepEqual(tags, ['[check:unused]', '[check:orphan]']);
  });

  test('a make recipe continued with a backslash is one command, so a cd in it still leaves the folder', async () => {
    const dir = project(null, {
      'package.json': { scripts: { test: 'node --test', lint: 'eslint .' } },
      Makefile: ['ci:', '\tcd sub && \\', '\tnpm test', '\tnpm run \\', '\t  lint', ''].join('\n'),
      '.github/workflows/ci.yml': ciWorkflow('make ci'),
      'AGENTS.md': rulesDoc('- a [check:ci]', '- b [check:test]', '- c [check:lint]'),
    });
    const tags = (await problemsFor(dir)).map((p) => p.message.split(' ')[0]);
    assert.deepEqual(tags, ['[check:test]']);
  });

  test('a git hook that can stop a commit or a push counts; other files beside it do not', async () => {
    const dir = project(null, {
      'package.json': { scripts: { lint: 'eslint .', test: 'node --test', docs: 'echo docs', notes: 'echo notes' } },
      '.husky/pre-commit': 'npm run lint\n',
      '.githooks/pre-push': '#!/bin/sh\nset -e\nnpm test\n',
      '.husky/post-commit': 'npm run docs\n',
      '.githooks/README.md': 'Run `npm run notes` by hand.\n',
      'AGENTS.md': rulesDoc('- a [check:lint]', '- b [check:test]', '- c [check:docs]', '- d [check:notes]'),
    });
    const tags = (await problemsFor(dir)).map((p) => p.message.split(' ')[0]);
    assert.deepEqual(tags, ['[check:docs]', '[check:notes]']);
  });

  test('a command commented out, outside a run step, in another folder or outside .github/workflows does not count', async () => {
    const dir = project(null, {
      'package.json': { scripts: { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x', f: 'x', g: 'x' } },
      '.github/workflows/ci.yml': [
        'name: npm run a',
        'on: [push]',
        'jobs:',
        '  t:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      # - run: npm run b',
        '      - run: cd web && npm run c',
        '      - run: npm --prefix web run d',
        '      - run: npm run e',
        '        working-directory: web',
        '',
      ].join('\n'),
      '.github/workflows/nested/ci.yml': ciWorkflow('npm run f'),
      'ci/workflow.yml': ciWorkflow('npm run g'),
      'AGENTS.md': rulesDoc('- a [check:a]', '- b [check:b]', '- c [check:c]', '- d [check:d]', '- e [check:e]', '- f [check:f]', '- g [check:g]'),
    });
    const problems = await problemsFor(dir);
    assert.equal(problems.length, 7);
    for (const p of problems) assert.match(p.message, /but no CI workflow or git hook runs it/);
  });
});

describe('checkRules: lint tags', () => {
  test('resolve when the rule is at error for a source file in every workspace', async () => {
    const dir = project('lint', { 'AGENTS.md': rulesDoc('- Log through the logger. [lint:no-console]') }, { eslintIn: 'web' });
    const result = await check(dir);
    assert.deepEqual(result.problems, []);
    assert.equal(result.counts.lint, 1);
  });

  test('fail when the rule is warn or off, naming the file checked after skipping specs and ignored paths', async () => {
    const dir = project('lint', { 'AGENTS.md': rulesDoc('- No debugger. [lint:no-debugger]', '- No eval. [lint:no-eval]') }, { eslintIn: 'web' });
    const problems = await problemsFor(dir);
    assert.equal(problems.length, 2);
    assert.match(problems[0].message, /\[lint:no-debugger\] is "warn" for web\/src\/a\.mjs; it must be "error"/);
    assert.match(problems[1].message, /\[lint:no-eval\] is "off" for web\/src\/a\.mjs/);
  });

  test('a nested rulebook is checked against a file in its own folder', async () => {
    const dir = project('lint', { 'web/src/cli/AGENTS.md': rulesDoc('- No console here. [lint:no-console]') }, { eslintIn: 'web' });
    const problems = await problemsFor(dir, 'web/src/cli/AGENTS.md');
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /"off" for web\/src\/cli\/run\.mjs/);
  });

  test('fail when no ESLint config covers the rulebook', async () => {
    const dir = project('lint', { 'docs/AGENTS.md': rulesDoc('- No console. [lint:no-console]') }, { eslintIn: 'web' });
    const problems = await problemsFor(dir, 'docs/AGENTS.md');
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /no eslint\.config\.\* covers docs\/AGENTS\.md/);
  });

  test('fail with a clear message when the project has a config but no ESLint installed', async () => {
    const problems = await problemsFor(project('lint', { 'AGENTS.md': rulesDoc('- No console. [lint:no-console]') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /ESLint is not installed in the project/);
  });

  test('fail in a project without any ESLint config', async () => {
    const problems = await problemsFor(project('project', { 'AGENTS.md': rulesDoc('- No console. [lint:no-console]') }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /no eslint\.config\.\* covers AGENTS\.md/);
  });
});

describe('listRulebooks', () => {
  const book = rulesDoc('- Scoped. [review:scope]');

  test('in a repository, lists what git tracks or would track, never what it ignores', () => {
    const dir = project(null, { 'AGENTS.md': book, 'docs/AGENTS.md': book, 'ignored/AGENTS.md': book, '.gitignore': 'ignored/\n' }, { git: true });
    assert.deepEqual(listRulebooks(dir, ['**/AGENTS.md']), { files: ['AGENTS.md', 'docs/AGENTS.md'], nested: [] });
  });

  test('outside a repository, walks the folder and skips node_modules and dot folders', () => {
    const dir = project(null, { 'AGENTS.md': book, 'a/b/AGENTS.md': book, 'node_modules/x/AGENTS.md': book, '.cache/AGENTS.md': book });
    assert.deepEqual(listRulebooks(dir, ['**/AGENTS.md']).files, ['AGENTS.md', 'a/b/AGENTS.md']);
  });

  test('rules.files decides which files are rulebooks', () => {
    const dir = project(null, { 'AGENTS.md': book, 'docs/rules.md': book, 'docs/guide.md': '# Guide\n' });
    assert.deepEqual(listRulebooks(dir, ['docs/rules.md']).files, ['docs/rules.md']);
  });

  test('a folder with its own config is a project of its own and is skipped', () => {
    const dir = project(null, { 'AGENTS.md': book, 'examples/app/AGENTS.md': book, 'examples/app/.claude/falsifiable.json': {} }, { git: true });
    assert.deepEqual(listRulebooks(dir, ['**/AGENTS.md']), { files: ['AGENTS.md'], nested: ['examples/app'] });
  });
});

describe('CLI', () => {
  test('exits 1 and prints file:line, the problem and the rule text', () => {
    const dir = project('project', { 'AGENTS.md': rulesDoc('- Keep tests honest.') }, { git: true });
    const result = run([], dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /AGENTS\.md:6 {2}no enforcement tag/);
    assert.match(result.stderr, /Keep tests honest\./);
  });

  test('exits 0 and prints the counts per tag kind', () => {
    const result = run([project('project')]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /7 rules in 1 file resolve \(lint 0 · hook 2 · check 2 · test 1 · review 2\)/);
  });

  test('checks only the files given after the project folder', () => {
    const dir = project('project', { 'docs/AGENTS.md': rulesDoc('- Untagged nested rule.') }, { git: true });
    const all = run([dir]);
    assert.equal(all.status, 1, all.stdout + all.stderr);
    assert.match(all.stderr, /docs\/AGENTS\.md:6/);
    const one = run([dir, 'AGENTS.md']);
    assert.equal(one.status, 0, one.stdout + one.stderr);
  });

  test('exits 1 when no rulebook matches rules.files', () => {
    const result = run([project(null, { 'README.md': '# Readme\n' })]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no rulebook matches rules\.files \(\*\*\/AGENTS\.md\)/);
  });

  test('names the nested projects it skipped', () => {
    const dir = project('project', { 'examples/app/AGENTS.md': rulesDoc('- Untagged.'), 'examples/app/.claude/falsifiable.json': {} });
    const result = run([dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /skipped examples\/app: it has its own \.claude\/falsifiable\.json/);
  });

  test('exits 2 on an invalid config and names the problem', () => {
    const invalid = run([project('project', { '.claude/falsifiable.json': { rules: { files: [] } } })]);
    assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /\$\.rules\.files/);
    const broken = run([project('project', { '.claude/falsifiable.json': '{ not json' })]);
    assert.equal(broken.status, 2, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /not valid JSON/);
  });

  test('a planning problem in a valid config does not stop the rule check', () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'project', '.claude', 'falsifiable.json'), 'utf8'));
    const domains = { api: { owns: ['api/**'], proof: 'tests', gate: 'npm test' } };
    const dir = project('project', { '.claude/falsifiable.json': { ...fixture, delivery: { domains, sensitivePaths: { billing: ['billing/**'] } } } });
    assert.match(loadConfig(dir).problems.join('\n'), /no domain owns/, 'the fixture has a planning problem');
    const result = run([dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('exits 2 on bad usage: a flag, a folder that does not exist, a file that is not there', () => {
    const dir = project('project');
    for (const args of [['--fix'], [path.join(dir, 'nowhere')], [path.join(dir, 'AGENTS.md')], [dir, 'docs/AGENTS.md']]) {
      const result = run(args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /usage|not a folder|no such file/);
    }
  });

  test('the starter rules resolve against the starter checklist', () => {
    const dir = project(null, {
      'AGENTS.md': readFileSync(path.join(ROOT, 'templates', 'agents-rules.md'), 'utf8'),
      '.claude/review-checklist.md': readFileSync(path.join(ROOT, 'templates', 'review-checklist.md'), 'utf8'),
    });
    const result = run([dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('the example project passes, with every tag kind but lint in use, and its config is valid', () => {
    const result = run(['examples/notes-app']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\(lint 0 · hook [1-9]\d* · check [1-9]\d* · test [1-9]\d* · review [1-9]\d*\)/);
    const config = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.mjs'), '--check', 'examples/notes-app'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(config.status, 0, config.stdout + config.stderr);
    assert.equal(config.stdout, 'ok\n');
  });
});
