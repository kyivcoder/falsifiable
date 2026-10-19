## Rules
<!-- rules -->

Each rule ends with the one thing that enforces it: `[hook:…]` a guard rule, `[check:…]` a package script or make target that CI or a git hook runs, `[test:…]` a test that goes red when the rule breaks, `[review:…]` an item in the review checklist, `[lint:…]` an ESLint rule at error. The rule check fails on a rule without a tag, or with a tag that resolves to nothing. A rule that stops being true is deleted.

### Boundaries
- Never push to a protected branch; push a branch and open a pull request. [hook:git-push-protected]
- Never force-push, mirror or delete a protected branch. [hook:git-force-push-protected]
- Never skip the git hooks. [hook:git-no-verify]
- Never merge a pull request; a person merges. [hook:gh-merge]
- Never change repository settings, branch protection, rulesets or secrets. [hook:gh-admin]
- Never edit a protected path: the agent settings and hooks, the MCP config, the CI workflows or `.claude/falsifiable.json`. Ask the user. [hook:protected-path]
- Never write a secret into a file; read it from an environment variable. [hook:secret-in-file]
- Never run a migration or a schema push against a database that is not local. [hook:db-remote-migrate]
- Never put a secret in a command line, a fixture or a log. [review:secrets]
- Production is read-only: nothing runs against it, real user accounts or paid services unless the user asks for that exact run. [review:production]

### Delivery
- The diff does what the approved change says, and nothing else. [review:scope]
- Before lanes start, every shared contract has one owning lane, and lanes never share a file. [review:lane-plan]
- Say which checks could not run and why. Never claim production behaviour from a local run. [review:evidence]
- Never weaken a check to get green: no skipped or focused tests, no raised baseline, no widened exemption. [review:weakened-checks]

### Tests
- A new test fails without the change, and the lane report shows its red run. [review:tests-prove]
- Input from users and other systems is validated where it enters. [review:boundary-validation]
- A change to an API contract or a shared schema comes with an integration test. [review:integration-test]
