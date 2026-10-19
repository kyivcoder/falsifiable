# Architecture

falsifiable has four layers. The first two are deterministic code that runs whatever the model decides; the last two are the agents and the words they read.

```
 you ── approve the proposal · answer decisions · review and merge the pull request
  │
  ▼
 head agent (your Claude Code session)
  │  /falsifiable:propose  → <specs>/changes/<id>/ on branch change/<id> → draft pull request
  │  /falsifiable:ship <id> → one workflow run per stage; the head reads every brief
  ▼
 plan ──────────────► build ──────────────────► verify ───────────────────► hand over
 planner              one builder per lane       verifier (blind to code)     draft PR → ready
 (+ scouts)           branch lane/<id>/<lane>    reviewer (+ second model)    you merge
   │                  in its own worktree             │
   │ tasks.md              ▲                           │
   │                       └──── typed defects ────────┘  at most 2 fix rounds, then you decide
   ▼
 state between stages: the change folder and the lane branches, never chat memory

 ─────────────────────────────────────────────────────────────────────────────────────────
 guard hook: every Bash, file write and MCP call, in the head and in every agent
 role fences: the same hook, keyed on which agent is calling
```

## Layer 1: the guard (`lib/guard/`, `scripts/hook.mjs`)

A PreToolUse hook on Bash, file writes, file reads and every MCP tool. It is a pure engine (`evaluate(request, config)`) behind a thin adapter that reads Claude Code's hook payload. It parses shell input before judging it, blocks with exit code 2 and a message that says what to do instead, and fails closed on input it cannot read or on its own crash. Rules come in packs (git, github, database, deploy, paths, secrets) that a project switches on in its config. See [guard.md](guard.md).

## Layer 2: the workflows (`workflows/`)

Claude Code workflow scripts: plain JavaScript that starts agents and checks their results. `ship-stage.js` runs one stage of a change; `review-run.js` reviews any pull request. The `ship` and `review` skills load the config and start them. Every agent result is validated against a JSON Schema. The scripts enforce what a schema cannot:

- no file can belong to two lanes (glob overlap), and a plan has at most `maxLanes` lanes;
- every scenario maps to one proof (`product`, `unit` or `review`) and a lane serves it;
- a bug fix starts from a failing reproduction;
- a lane that owns a sensitive path waits for your decision before any builder starts;
- a lane report stays inside its owned paths and shows each new test failing before it passes;
- at most `maxAgentsPerRun` agents per run and `maxFixRounds` fix rounds, then a decision;
- the verifier only ever drives a local app.

Workflow scripts cannot read files, so the ship skill passes the resolved config in the run's arguments. The scripts are tested against a fake agent runtime (`test/workflows/runtime.mjs`) that keeps the real runtime's refusals: no clock, no randomness, no imports, schema-checked results.

## Layer 3: the agents (`agents/`)

| Agent | Writes | Returns |
|---|---|---|
| `falsifiable:scout` | nothing | facts with file:line or URL evidence |
| `falsifiable:planner` | the change's `tasks.md` | a plan: lanes with disjoint owned paths, a proof for every scenario, open questions |
| `falsifiable:builder` | its lane's paths, on its lane branch, in its own worktree | a lane report: changed files, red and green test runs, checks with exit codes |
| `falsifiable:verifier` | `.verify/` | a verdict per scenario (PASS, FAIL, BLOCKED) with evidence, and regressions |
| `falsifiable:reviewer` | nothing | findings P0 to P3, each tied to a rule; whether the diff matches the lane reports |

The "Writes" column is enforced by the hook's role fences, not only stated in each agent's instructions. The fences are allowlists. The verifier may read only the change's specs, `.verify/` and `verify.readPaths`, may run only requests to the local app and `verify.commands`, and may use only the MCP servers in `verify.mcpServers`. The reviewer and the scout may run only read-only programs.

## Layer 4: the knowledge (your repository)

- `AGENTS.md`: the map of the repository and its rules. Each rule ends with the tag of what enforces it; `scripts/check-rules.mjs` keeps that true.
- `.claude/review-checklist.md`: what the reviewer walks; `[review:…]` tags resolve here.
- `.claude/falsifiable.json`: the policy: protected branches and paths, local database hosts, domains, sensitive areas, limits, how the verifier reaches the app.
- `<specs>/`: OpenSpec living specs and change folders.

## Data flow of one change

1. `/falsifiable:propose` writes the change folder (proposal, spec deltas with scenarios) and opens a draft pull request. You approve it there.
2. `/falsifiable:ship <id>` loads the config and runs the **plan** stage: up to two scouts answer questions, the planner writes `tasks.md` and returns a plan. The script rejects a bad plan; a sensitive lane comes back to you as a decision.
3. **build** starts one builder per lane, at most `maxParallelBuilders` at a time, each in its own worktree on `lane/<id>/<lane>`. The script checks each lane report. The head merges the lanes in plan order with `scripts/merge-lanes.mjs`; a conflict comes back as a blocked lane.
4. **verify** runs the verifier on the product scenarios and the reviewer on the diff, in parallel. Failed scenarios and P0/P1 findings become typed defects, each assigned to the lane that owns it.
5. **fix** sends each defect back to its lane's builder; verify runs again. After `maxFixRounds` rounds the defects come to you.
6. **hand over**: the change is archived into the living specs, the draft pull request is marked ready with the scenario results and the checks that could not run, and you review and merge.
