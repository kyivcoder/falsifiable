# Design decisions

Each entry is a choice that shaped the plugin, with the alternatives that lost. When a decision changes, edit its entry; history lives in git.

## 1. A rule without an enforcer is a wish

**Decision.** Every rule in a rulebook (`AGENTS.md`) ends with one tag that names what enforces it: `[hook:…]`, `[lint:…]`, `[check:…]`, `[test:…]` or `[review:…]`. `scripts/check-rules.mjs` fails on a rule without a tag and on a tag that resolves to nothing. A `[check:…]` resolves only to a script or make target that a CI workflow or a git hook runs: a check nobody runs enforces nothing.

**Why.** Agents read rulebooks, but prose decays: rules contradict the code, outlive their reason, or are never checked. A tag makes each rule answer "what goes red when this is broken?", and the check keeps the answer true. New rules take the strongest enforcement that fits, in the order hook, lint, check, test, review.

**Lost.** Free-form rulebooks (no feedback when a rule rots). Generating rules from incidents automatically (rules nobody owns).

## 2. Guardrails are code, not prompts

**Decision.** What must never happen (pushing to a protected branch, merging, touching a production database, deploying, editing the agent's own guardrails, writing a secret) is blocked by a PreToolUse hook that parses the command and fails closed.

**Why.** An instruction is a request; a hook is a fact. The guard parses before it judges: it splits shell input on `;`, `&&`, `|`, `$(…)`, `bash -c` and `eval`, unwraps `env`, `sudo`, `timeout`, `npx`, `pnpm exec`, `dotenv run --` and similar, and then judges each simple command, so `env A=1 bash -c "git push origin main"` is judged as the push it runs.

**Lost.** Permission rules alone (they match command patterns, and every wrapper is a new pattern to remember). An LLM judge in the hook (slow, non-deterministic, costs money on every call).

## 3. Production is decided by the target, not the verb

**Decision.** The database pack blocks a shell, dump or migration pointed at any host that is not in `guard.localHosts`. It does not try to decide whether a query is destructive.

**Why.** For an agent, "read-only on production" is still a production incident waiting to happen: it reads customer data into a transcript. Local versus not-local is a question the guard can answer exactly.

**Lost.** Destructive-command lists (a long tail, and `SELECT` on production still leaks data).

## 4. The policy lives in the repository, and the guard protects it

**Decision.** The config is `.claude/falsifiable.json` in the project. The guard always protects it, along with `.claude/settings*.json`, `.claude/hooks/**`, installed plugins (`.claude/plugins/**`), `.mcp.json`, and git's own `.git/config` and `.git/hooks/**`. A person unlocks a session by starting it with `FALSIFIABLE_UNLOCK=1`; an assignment inside an agent's command does not count.

**Why.** A team's policy belongs in review, next to the code. Claude Code's plugin `userConfig` is per user, and project-scoped values are ignored, so it cannot carry a team policy. A guard whose agent can rewrite its policy guards nothing.

**Lost.** `userConfig` (per user). No config (a guard that knows nothing about the project's branches or hosts).

## 5. Role fences live in the hook, keyed on the agent type

**Decision.** The same hook reads `agent_type` from the payload and fences the plugin's roles with allowlists: the planner writes only a change's `tasks.md`; the verifier reads only the change's specs, `.verify/` and the paths the project lists, runs only requests to the local app and the commands the project lists, and uses only the MCP servers it lists; the reviewer and the scout run read-only programs and write nothing.

**Why.** Claude Code ignores `hooks` in a plugin agent's frontmatter, and tool lists cannot express "Read, but only these folders". A verifier that has seen the implementation tests the implementation; one that has only seen the scenarios tests the product.

**Lost.** Instructions only ("do not read the diff"), which a verifier under pressure ignores.

## 6. Built for agents that make mistakes, not for hostile code

**Decision.** The threat model is a capable agent that errs and, when one route is blocked, tries another. The guard blocks the command shapes such agents use, and every bypass found becomes a must-block case. The role fences are allowlists. Hostile code is out of scope and named as such.

**Why.** A hook that reads commands can never see inside a program the agent writes and runs, so promising more would be false. Saying exactly what the guard is for lets it be complete for that job, and tells a team which other controls (an OS sandbox, branch protection, database roles) still carry the rest.

**Lost.** Claiming a sandbox (untrue). A denylist for the fences too: a reviewer found shapes nobody had listed within minutes; an allowlist refuses them by default.

## 7. A broken config can only add protection

**Decision.** When `.claude/falsifiable.json` breaks the schema, the defaults apply, plus the file's own protective lists that are valid on their own (protected branches and paths, blocked commands). Lists that grant access (local database hosts, the verifier's read paths, commands and MCP servers) wait until the file is fixed.

**Why.** Falling back to the bare defaults silently dropped a project's own protections when someone made an unrelated typo. Keeping the file as it is would let a typo grant access.

**Lost.** Failing every tool call until the file is fixed (it locks the session, and the agent cannot fix a protected file anyway).

## 8. One stage per workflow run; state lives in files

**Decision.** `/falsifiable:ship` runs plan, build, verify and fix as separate workflow runs. Between runs the state is the change folder and the lane branches; each run returns a brief whose `next.args` start the next one.

**Why.** A person reads every hand-off, a failed stage re-runs alone, and nothing depends on a long session's memory surviving compaction.

**Lost.** One long autonomous run (cheaper to start, impossible to steer, and a failure late in the run loses everything).

## 9. Lanes own disjoint paths, checked before anyone builds

**Decision.** The planner splits a change into lanes that each own files or folders. The workflow rejects a plan in which any file could belong to two lanes (glob overlap, not string equality), and each lane is built by its own builder in its own git worktree.

**Why.** Parallel agents that share a file produce merge conflicts or, worse, silent overwrites. Ownership checked up front makes parallelism safe; shared contracts (a type, a schema) are named in the plan with one owner.

**Lost.** Letting builders coordinate by message (they do not), one builder for everything (slow, and a long context loses the plan).

## 10. Agents return data, and self-reported evidence is checked twice

**Decision.** Every hand-off is a JSON Schema the runtime validates. A builder's lane report must show, for every new test, the red run (command, non-zero exit code, failure lines) and the green run. The workflow checks the shape and the lane's owned paths; the reviewer checks the reports against the real diff.

**Why.** "Tests pass" is the most common false claim an agent makes. A test that was never seen failing proves nothing.

**Lost.** Trusting the builder's summary. Re-running every test in the workflow (a workflow script cannot run commands).

## 11. The orchestration is tested like code

**Decision.** Workflow scripts run in unit tests against a fake agent runtime: scripted agent results, schema checks on every result, the same refusals as the real runtime (no clock, no randomness, no imports).

**Why.** A workflow is a program that spends money and touches the repository. Its branches (a blocked lane, a third fix round, a non-local base URL) must be proven without paying for agents.

**Lost.** Testing workflows only by running them (slow, costly, and the rare branches never run).

## 12. A plugin, not a template repository

**Decision.** Ship as a Claude Code plugin with its own marketplace file, installable in one line, and compose with Superpowers (the method inside each step) and OpenSpec (the change-folder format).

**Why.** A template is forked once and drifts. A plugin updates, namespaces its commands and agents, and can be removed cleanly.

**Lost.** A template (drift), a bigger all-in-one kit (other kits already do method and catalogue well).
