# falsifiable

A Claude Code plugin: agents ship approved specs in parallel lanes, a guard hook keeps them out of production, a verifier blind to the code tests the running app, and a person keeps the merge. This file is the map and the rulebook for anyone, human or agent, changing the plugin itself.

## Map

- `.claude-plugin/`: the plugin manifest and the one-plugin marketplace.
- `hooks/hooks.json` → `scripts/hook.mjs` → `lib/guard/`: the guard engine, its rule packs (`lib/guard/packs/`), the role fences (`lib/guard/fence.mjs`) and the rule-id registry (`lib/guard/rule-ids.mjs`).
- `workflows/`: `ship-stage.js` (one stage of a change) and `review-run.js` (any pull request). They cannot import, so shared code is copied in and kept equal by tests.
- `agents/`: the five roles. `skills/`: `propose`, `ship`, `review`, `init`; `ship` and `review` load the config and start their workflow.
- `lib/config.mjs` and `schema/config.schema.json`: the project config every part reads. `lib/glob.mjs`: the one glob meaning. `lib/runs.mjs`: what a project's CI and git hooks run, for the rule check.
- `scripts/`: `config.mjs`, `check-rules.mjs`, `merge-lanes.mjs`.
- `.github/workflows/ci.yml`: `npm run check` on Node 22 and 24, for every pull request and push to `main`.
- `test/`: everything above, on `node:test`. `test/workflows/runtime.mjs` is the fake workflow runtime.
- `evals/`: plugin evals run with `claude plugin eval`. `examples/notes-app/`: a small project with one proposed change, ready to ship.
- `docs/`: architecture, design decisions, the guard, testing, and the comparison with other kits.

## Commands

```bash
npm test                          # every unit test
node --test "test/guard/*.test.mjs"   # one area
npm run check                     # tests, the rule check, the example's config, rules and tests
claude plugin validate --strict . # manifests, agents, skills, hooks
```

## Rules
<!-- rules -->

### Boundaries
- Never push to `main`; push a branch and open a pull request. [hook:git-push-protected]
- Never merge a pull request; a maintainer merges. [hook:gh-merge]
- Never skip the git hooks. [hook:git-no-verify]
- Never write a credential into a file, fixture or test; tests use obvious fakes. [hook:secret-in-file]

### Code
- No dependencies: Node built-ins and the repository's own files only. [test:test/repo.test.mjs]
- Every guard rule id is registered in `lib/guard/rule-ids.mjs` and emitted by a pack. [test:test/guard/rule-ids.test.mjs]
- The blocks the two workflows share stay identical. [test:test/workflows/contracts.test.mjs]
- The glob code copied into `ship-stage.js` agrees with `lib/glob.mjs`. [test:test/workflows/glob-parity.test.mjs]
- Agent files use only the frontmatter Claude Code honours for plugin agents, and their descriptions stay short. [test:test/workflows/agents.test.mjs]
- The hook fails closed on anything it cannot decide. [review:fail-closed]
- A guard change adds cases that must block and cases that must still pass. [review:guard-cases]
- Messages the model reads say what to do instead. [review:plain-messages]
- Skill and agent descriptions stay short; every session pays for them. [review:short-descriptions]

### Tests and evidence
- The unit tests pass on every pull request; CI runs them. [check:test]
- A new test fails without the change. [review:tests-prove]
- A workflow change is tested on the branch where it refuses. [review:workflow-branches]
- No test is skipped or focused, and no case is removed to get green. [review:weakened-checks]
- The README and docs claim only what a test, check or eval proves. [review:claims]
- The diff does what its issue or proposal says, and nothing else. [review:scope]
