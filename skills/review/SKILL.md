---
name: review
description: Review a pull request or a branch through three reviewer lenses and one refuter, using the project's review checklist and its optional second model, and report the findings that survive.
argument-hint: <pull-request-number | git-range> [change-id]
disable-model-invocation: true
---

# Review a pull request or a branch

The target: $ARGUMENTS

Three reviewers read the diff, each through one lens (correctness and safety, whether the tests prove behaviour, scope). Then one refuter tests every P0 and P1 against the code, and only the findings it cannot knock down are reported. The workflow does this; you prepare its arguments and report its brief to the user.

## 1. Load the config

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` from the repository root.

- If it exits 1, show the user the problems it prints and stop. The user fixes `.claude/falsifiable.json`; never work around it.
- Otherwise its JSON output is `config`: it names the checklist (`review.checklist`), the second-opinion command (`review.secondOpinion`) and the base branch.

## 2. Read the target

- A pull request number (`42` or `#42`) becomes `{pr}`; a git range (`origin/main...change/x`) becomes `{range}`. With neither, the workflow reviews `origin/<config.delivery.baseBranch>...HEAD`.
- When the target is a change (a branch `change/<id>`, or the user names one), add its `id`: the lenses then read its spec, and its change folder is not counted as a mismatch.
- When you have the lane reports of a ship run for that change, add them as `reports`; the lenses check the diff against them.

## 3. Run the review

Call the Workflow tool with `name: "falsifiable:review-run"` and `args` as a JSON object, not a string: `{pr}` or `{range}`, plus `id` and `reports` when you have them, and `config`.

## 4. Report

Give the user the brief:

- the status and headline;
- each finding that survived, P0 first, with its file and line, its checklist item, the problem and the fix;
- each refuted finding with the refuter's reason, in one line;
- how many agents ran.

When the brief says a lens returned nothing, the review is incomplete: say so, and offer to run it again.

## Rules

- A review changes nothing. Never edit, commit, push or merge because of it; the user decides what to fix.
- When the guard blocks a command, fix the cause; never work around it.
