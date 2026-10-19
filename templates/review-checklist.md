# Review checklist

The reviewer walks these items for every change, and each `[review:<slug>]` tag in a rulebook must name one of them. An item is one line: the slug in backticks, a colon, then what to check. Keep the slugs stable, write the checks in this project's terms, and add an item only for a judgement no hook, script, test or lint rule can make.

### Delivery
- `diff-matches-reports`: the changed files, commits and tests match the lane reports, and each lane stayed inside the paths it owns.
- `scope`: the diff does what the approved change says and nothing else; a narrowed scope is an open question at the top of the pull request, never a settled fact.
- `lane-plan`: each shared contract (a type, constant, helper or schema) has one owning lane, and a cross-cutting change lists every call site and gives each one to a lane.
- `evidence`: the pull request lists the checks that ran with their results and the ones that could not run with the reason, and claims nothing about production from a local run.
- `weakened-checks`: no skipped or focused test, no raised baseline, no widened exemption, no lowered lint level, no deleted assertion.

### Safety
- `secrets`: no secret, credential or personal data in a committed file, a fixture, a log line or a command line.
- `production`: no step runs against production, real user accounts or paid services unless the user asked for that exact run.
- `boundary-validation`: input from users, webhooks, other services and models is parsed and checked before it is used.

### Tests
- `tests-prove`: each new test fails without the change (its red run is in the lane report) and asserts behaviour, not what a mock was told to return.
- `integration-test`: a change to an API contract, an adapter, a flow across modules or a shared schema comes with an integration test.
