# Contributing

Thank you for helping. A few things keep this plugin honest.

## Before you open a pull request

```bash
npm test                          # every unit test (node --test, no dependencies)
npm run check:rules               # every rule in AGENTS.md names an enforcer that resolves
npm run check:example             # the example project's config, rules and tests
claude plugin validate --strict . # the plugin manifest, agents, skills and hooks
```

All four must pass (`npm run check` runs the first three). There is nothing to install: the project has no dependencies, and that is on purpose.

## The rules for changes

- **A test that cannot fail proves nothing.** Write the test first and see it fail for the right reason. For a guard rule, add the case to the table in `test/guard/` that would have let the bypass through.
- **A new guard rule** gets an id in `lib/guard/rule-ids.mjs`, cases that block and cases that must still pass, and a row in `docs/guard.md`.
- **A workflow change** gets a test against the fake runtime in `test/workflows/`, including the branch where it refuses.
- **Agent and skill descriptions stay short.** They are loaded into every session that has the plugin.
- **No new dependencies** without an issue first.

## Reporting a bypass

A way around the guard is a security bug: see [SECURITY.md](SECURITY.md).
