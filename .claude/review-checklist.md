# Review checklist

What the reviewer walks for a change to this repository. `[review:<slug>]` tags in `AGENTS.md` resolve to the slugs below.

### Delivery
- `scope`: the diff does what the issue or proposal says and nothing else.
- `claims`: the README and the docs claim only what a test, a check or an eval in this repository proves, and say which checks could not run.
- `weakened-checks`: no skipped or focused test (`test.skip`, `.only`, `todo`), no removed case from a guard case table, no loosened assertion.

### Guard
- `guard-cases`: a guard change adds cases that must block and cases that must still pass, in the case table; a new rule id is registered in `lib/guard/rule-ids.mjs` and documented in `docs/guard.md`.
- `fail-closed`: every path through the hook that cannot decide (unreadable input, a crash, an unknown request) blocks.

### Tests
- `tests-prove`: each new test fails without the change and asserts behaviour, not a mock's echo.
- `workflow-branches`: a workflow change is tested against the fake runtime on the branch where it refuses, not only on the happy path.

### Words
- `short-descriptions`: skill and agent descriptions stay short; they are loaded into every session that has the plugin.
- `plain-messages`: block messages, prompts and skills use short sentences and say what to do instead.
