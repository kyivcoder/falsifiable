---
name: ship
description: Ship an approved change through plan, build, verify and fix, one workflow run per stage, then hand it over as a draft pull request for the user to review and merge.
argument-hint: <change-id> [fix]
disable-model-invocation: true
---

# Ship a change

The arguments: $ARGUMENTS

You are the head: the only one who talks to the user. Each stage is one run of the `falsifiable:ship-stage` workflow. Between runs the state is the change folder and the lane branches, never your memory of the chat. Report every stage to the user from its brief: the status and headline, at most one decision with your recommendation, the evidence, how many agents ran, and the next step.

## 1. Load the config

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` from the repository root.

- If it exits 1, show the user the problems it prints and stop. The user fixes `.claude/falsifiable.json`; never work around it.
- Otherwise its JSON output is `config`. Every run gets it.

## 2. Find the change

- `<id>` is the first argument. The change folder is `<config.delivery.specsDir>/changes/<id>/`, with `proposal.md` and spec deltas under `specs/`. If it is missing, or the user has not approved the proposal, stop and say so.
- `base` is the change branch the proposal was opened on, usually `change/<id>`. The lanes start from it and merge into it. It is never `config.delivery.baseBranch` or a protected branch, and the workflow refuses one that is.
- `kind` is `fix` when the second argument is `fix` or the proposal describes a bug; otherwise `feature`. A fix plan starts from a failing reproduction.

## 3. Run a stage

Call the Workflow tool with `name: "falsifiable:ship-stage"` and `args` as a JSON object, not a string:

- First run, the `plan` stage: `{id, stage: "plan", base, kind, config}`. Add `scoutQuestions` (at most `config.delivery.limits.maxScouts`) when the plan needs facts first.
- Every later run: the previous brief's `next.args`, with `config` added. Change nothing else, except what this section says.

Then act on the brief's `status`:

- `planned`: run `next.args` (the `build` stage).
- `needs-decision`: ask the user `decision.question` with its options and your recommendation. Write the answer and the user's reason under a "Decisions" heading in the change's `design.md`, and commit it on `base`. Add `{about: decision.about, answer}` to `next.args.decisions` (start the list if there is none) and run it. A lane in "agent guardrails" also needs a session the user started with `<config.guard.unlockEnv>=1`; say so when you ask.
- `built`: on `base`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-lanes.mjs" <id> <lane>...` with the lanes the note names, in that order. A conflict or a missing branch stops it: report that lane as blocked and ask the user whether to re-plan. Never resolve a lane conflict yourself. A merged lane whose worktree could not be removed stops it too: tell the user the path it names. After a clean merge, make sure the app runs (section 4), then run `next.args` (the `verify` stage).
- `needs-fix`: run `next.args` (the `fix` stage). When it comes back `built`, merge again and verify again. The workflow counts the rounds and asks the user after `config.delivery.limits.maxFixRounds`. If the user chooses one more round, run `fix` with `round` equal to that limit and their guidance in each defect's `fix`.
- `blocked`: report the evidence and what would unblock it, then stop. Fix the cause (the args, the plan, the app) and run `next.args` again; a failed build re-runs only the lanes it names (section 3a first). A lane is accepted only with a passing run of its domain's gate in its checks; a lane that could not run the gate comes back blocked, so fix what stopped it. Never edit the args to get past a check.
- `verified`: hand over (section 5).

## 3a. Before a failed lane runs again

A builder that failed can leave its worktree behind with the lane branch checked out, and the next builder of that lane cannot then check the branch out. Before you re-run the lane:

1. Find it with `git worktree list --porcelain`: the entry whose branch is `refs/heads/lane/<id>/<lane>`.
2. Remove it with `git worktree remove <path>` only when that path is under `.claude/worktrees/` of this repository. Never pass --force, and never remove any other worktree.
3. If git refuses (the worktree holds uncommitted work) or the path is elsewhere, stop and tell the user the path; the user decides what happens to that work.

## 4. Before verify: the app runs locally

The verifier drives the app at `config.verify.baseUrl` and never starts or stops it.

1. Check that the base URL and every `config.verify.health` URL answer, for example `curl -fsS -o /dev/null -w "%{http_code}" <url>`.
2. If one does not, ask the user to start the app from `base` with local settings. Or start it yourself in the background, only with the command the project documents for local development (its README or `AGENTS.md`), and only with local settings: a local database, test accounts, no live keys. Never with production credentials. If the settings file holds any, stop and ask the user.
3. Check again before you run verify. The variables named in `config.verify.credentialEnv` must be set in the environment Claude Code started with; if one is missing, tell the user before verify.

## 5. Hand over

1. If the project uses the OpenSpec CLI (`openspec` is installed or in its dev dependencies), run `openspec archive <id> --yes` and commit the result on `base` as the last commit.
2. Push `base` with `git push -u origin <base>`. Never push `config.delivery.baseBranch`.
3. Open the pull request as a draft, or update the draft the proposal opened (`gh pr create --draft --base <config.delivery.baseBranch> --head <base>`, or `gh pr edit`). Its body says:
   - what changes for users, in plain words;
   - each scenario with its result (PASS, FAIL or BLOCKED) and its evidence;
   - the checks that ran with their results, and each one that did not, as "Not run: X because Y";
   - the decisions the user made, and the follow-ups.
4. Mark it ready with `gh pr ready` only after every stage passed: the plan was approved, every lane built, verify came back `verified` and no defect is open. Otherwise leave it a draft and say why.
5. Give the user the hand-over brief with the pull request link. Never merge: the user reviews and merges.

## Rules

- One stage per run. Never run two stages at once or skip one.
- Never claim production behaviour from a local run. Say "works locally" and what would prove it in production.
- When the guard blocks a command, fix the cause; never work around it.
- After a context reset, resume from the change folder (its `tasks.md` holds the plan), the lane branches and the last brief's `next.args` if you still have it. Otherwise run the unfinished stage again. Never redo finished work.
