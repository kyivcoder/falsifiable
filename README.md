# falsifiable

**Claude Code agents that ship your specs, where every promise is a check that can fail.**

Coding agents write good code and make bad promises. "Tests pass" for a test that never failed. "I didn't touch production" until the day they did. "It works" without opening the app. falsifiable is a Claude Code plugin that turns each of those promises into a check, and the check fails when the promise isn't true.

The plugin holds itself to the same rule: each claim below names the test, check or eval that proves it, and [a recorded run](docs/walkthrough.md) shows a real change going through every stage.

```text
/plugin marketplace add kyivcoder/falsifiable
/plugin install falsifiable@falsifiable
```

## What you get

- **A guard that keeps agents out of production.** One hook sees every shell command, file write and MCP call, in your session and in every subagent. It parses commands before judging them (through `bash -c`, `env`, `npx`, pipes and `$(…)`), then blocks pushes to protected branches, merges, databases that aren't local, deploys, edits to its own policy, and secrets written into files. It fails closed. [The rules](docs/guard.md).
- **Parallel lanes that can't collide.** `/falsifiable:ship` has a planner split an approved change into lanes that own disjoint files, and rejects any overlap before a builder starts. Each builder works test-first in its own git worktree and must show every new test failing before it passes.
- **A verifier that has never seen the code.** It tests the running app against the spec's scenarios. The hook gives it an allowlist: the change's scenarios, its own notes folder, requests to the local app, and the browser servers your config names. The source, the plan and the diff stay closed to it, so it judges what a user sees, not what the builder meant.
- **A reviewer with a second model.** Fresh context, your checklist, and optionally any read-only CLI (Codex, for example) as a second opinion. It also checks the builders' reports against the real diff.
- **Rules with an enforcer, or the check fails.** Each rule in `AGENTS.md` ends with the tag of what enforces it: `[hook:…]`, `[lint:…]`, `[check:…]`, `[test:…]` or `[review:…]`. `check-rules` fails on a rule without one, on a tag that points at nothing, and on a check that no CI workflow or git hook runs.
- **You keep the merge.** A lane that touches a sensitive path waits for your decision. After two fix rounds the open defects come to you. The plugin opens a draft pull request and never merges.

## How a change flows

```text
/falsifiable:propose ──► change folder + draft PR ──► you approve
/falsifiable:ship <id>
   plan ──────► build ─────────────► verify ──────────────────► hand over
   planner      a builder per lane   verifier (blind to code)   draft PR → ready
                own worktree         reviewer (+ second model)  you merge
                     ▲                    │
                     └── typed defects ───┘   at most 2 fix rounds, then you decide

guard + role fences: on every tool call, in every agent
```

Each stage is one workflow run. Between runs, the state is the change folder and the lane branches, never chat memory. A failed stage re-runs on its own, and you read every hand-off. Details: [architecture](docs/architecture.md), and [the decisions behind it](docs/decisions.md).

## Quick start

1. Install the plugin (above). The guard works straight away, with no config: every pack on, `main` and `master` protected, and only local databases (`localhost`, `127.0.0.1`, `::1`, Unix sockets) allowed.
2. In your repository, run `/falsifiable:init`. It writes a review checklist and a rules section in `AGENTS.md`, and drafts `.claude/falsifiable.json` from your folders and test commands. The config is guarded, so agents can't loosen it: start the session with `FALSIFIABLE_UNLOCK=1 claude` to let init write it.
3. `/falsifiable:propose notes can carry tags` writes an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change folder whose scenarios are the contract, and opens a draft pull request for you to approve.
4. `/falsifiable:ship <id>` runs plan, build, verify and any fix rounds, then hands the pull request back to you.

`examples/notes-app/` is a small project with a config, a rulebook and one proposed change, ready to ship.

## How it is proven

| Claim | Proof |
|---|---|
| The guard blocks what [docs/guard.md](docs/guard.md) lists, and lets ordinary work through | `test/guard/`: 1,242 tests, including a table of commands that must block and commands that must pass, each also run through the real hook process |
| Each role stays inside its allowlist | `test/guard/fence.test.mjs` |
| The workflows refuse overlapping lanes, a lane outside its domain, a report without a red run or without a passing gate, a non-local verifier, a blown agent budget and a third fix round | `test/workflows/`: 298 tests against a fake workflow runtime that validates every agent result |
| The tests can fail | `npm run mutants`: 80 planted bugs, one invariant each, run against a scratch copy; every one must turn its tests red |
| Every rule in this repository has an enforcer, and every check rule names a check CI runs | `npm run check:rules` on this repo's own [AGENTS.md](AGENTS.md) |
| Inside real Claude Code sessions, the hook blocks a push to `main` and a remote database shell, stays out of ordinary work, and fences the verifier from product source | `claude plugin eval`: four cases, each run with the plugin and without it; [latest results](docs/testing.md#latest-results) |
| One real change goes through plan, two test-first lanes, merge, a blind verifier in a real browser and review | [The walkthrough](docs/walkthrough.md): a recorded run on the example that ends `verified`, and what an earlier run taught |
| The plugin is well formed | `claude plugin validate --strict` |

`npm test` runs every unit test (1,677, in under a minute) on Node 22 or later. There is nothing to install: the project has no dependencies. More on the test layers in [docs/testing.md](docs/testing.md).

## How it relates to other kits

falsifiable is the enforcement layer, not a method or a catalogue. It runs next to [Superpowers](https://github.com/obra/superpowers): when that's installed, the builders use its test-driven development skill, and `propose` uses its brainstorming. It uses the OpenSpec change-folder format. Next to Everything Claude Code, Compound Engineering, spec-kit and the command-guard hooks, two things here have no packaged equivalent that I could find: the check that fails on a rule without an enforcer, and a verifier that is blind to the code by construction. The full comparison, with honest limits: [docs/comparison.md](docs/comparison.md).

## Threat model and limits

falsifiable is built for a capable agent that makes mistakes and, when one route is blocked, tries another. It is not a sandbox against hostile code. [SECURITY.md](SECURITY.md) has the full model; in short:

- The guard reads commands; it does not sandbox programs. A script that opens a database connection itself is invisible to it. Keep an OS sandbox, branch protection and database roles in place as well.
- Every bypass found becomes a case that must block, in the guard's test table.
- The role fences are allowlists, so a shape nobody thought of is refused, not missed.
- A builder's lane scope is checked after it works (by the workflow and the reviewer), not prevented while it works.
- The verifier is only as good as the scenarios. A scenario that describes nothing a user can observe can't be verified blind.

## Where it comes from

This is the delivery system of a production SaaS that one engineer built with Claude Code agents, made generic and published: 758 merged pull requests in 2026, 220 of them in August (counted on GitHub on 18 October 2026). The product stays private; the process is here.

## License

MIT, by Vladyslav Yefimenko. Reports of a way around the guard: [SECURITY.md](SECURITY.md).
