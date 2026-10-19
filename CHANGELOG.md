# Changelog

## 0.1.0

First release.

- The guard: one PreToolUse hook with six rule packs (git, github, database, deploy, paths, secrets), project config in `.claude/falsifiable.json`, custom `blockCommands`, and an unlock variable for a person-started session. It fails closed.
- Role fences in the same hook for the planner, verifier, reviewer and scout.
- `/falsifiable:ship` and the `ship-stage` workflow: plan, build, verify and fix, one stage per run.
- `/falsifiable:review` for any pull request or range: three lenses and a refuter, run by the `review-run` workflow.
- `/falsifiable:propose` and `/falsifiable:init`.
- `scripts/check-rules.mjs`: every rule in `AGENTS.md` names an enforcer that resolves, and a check rule names a check that CI or a git hook runs.
- `scripts/mutants.mjs`: planted mutants that the tests must catch.
- `examples/notes-app` with one proposed change, four plugin evals, and a recorded run of that change in `docs/walkthrough.md`.
- CI that runs the tests, the rule check and the example on Node 22 and 24.
