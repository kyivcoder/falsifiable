---
name: propose
description: Turn an idea into an OpenSpec change folder (proposal and spec deltas with scenarios) and a draft pull request that the user approves before anything is built.
argument-hint: "<the idea in one sentence>"
disable-model-invocation: true
---

# Propose a change

Turn an idea into a change folder and a draft pull request. The user approves the proposal on that pull request, and only then does `/falsifiable:ship <id>` build it. This skill writes no product code.

The idea: $ARGUMENTS

## 1. Read the project config

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. Keep `delivery.specsDir` (below: `<specs>`), `delivery.baseBranch` (`<base>`) and `delivery.sensitivePaths`. If it exits 1, show the user the problems it prints and stop.

## 2. Understand the idea

If the `superpowers:brainstorming` skill is available, use it as the method, with three changes:

- The written design is the change folder (step 4), not a document anywhere else.
- Approval is the user's comment on the draft pull request, not a reply in chat.
- Stop where it would hand over to writing a plan. The planner writes the plan during `/falsifiable:ship`.

Without it, read the code the idea touches, then ask only the questions whose answers change what gets built: who sees the change, what they see when it works, what happens when input is empty, invalid or fails, and what is out of scope. Ask them in one message, five at most. Settle the rest yourself and list those calls in the pull request body.

Stop and ask when the idea needs authority you do not have: spending money, touching production, a public claim, or a path under `delivery.sensitivePaths`.

A bug gets a folder too. Its Why gives the steps to reproduce it, and the scenario that fails today comes first.

## 3. Branch

- Pick the id: short kebab-case that names the outcome, such as `add-note-tags`. It must not match a folder in `<specs>/changes/` or an existing branch.
- Run `git fetch origin <base>`, then `git switch -c change/<id> origin/<base>`. If the checkout holds uncommitted work, make a worktree for the branch instead and leave that work exactly as it is.

## 4. Write the change folder

Write `<specs>/changes/<id>/`. When the project has the OpenSpec CLI (step 5), `openspec new change <id>` creates the folder, and `openspec instructions <proposal|specs|design> --change <id>` prints each file's template and the project's rules. Follow them.

- `proposal.md`, always: **Why** (the problem as a user sees it, with the evidence), **What Changes**, **Capabilities** (new and modified, by name), **Impact** (the areas it touches, and any contract several parts rely on).
- `specs/<capability>/spec.md`, one per capability in the proposal: `## ADDED Requirements`, `## MODIFIED Requirements` or `## REMOVED Requirements`. Each requirement is `### Requirement: <name>` with SHALL text, then one or more `#### Scenario: <name>` blocks of `- **WHEN** …` and `- **THEN** …` bullets, with `- **AND** …` for extra outcomes.
- `design.md`, only when the change is cross-cutting or risky: context, goals and non-goals, decisions with the alternatives that lost, risks, open questions.
- Never `tasks.md`. The planner writes it.

What the templates do not say:

- **Scenarios are the contract.** The planner maps each one to a proof: `product` (checked in the running app by a verifier that never sees the code), `unit` (a named test, written red first) or `review`. A product scenario is what a user sees in the page or gets from the API. "The function returns X" is not one.
- **Every SHALL has a scenario**, or nothing proves it. A change to a screen also gets scenarios for its loading, empty and error states.
- **Behaviour comes from the code.** Describe today's behaviour only from code you read for this change. If the capability has no living spec in `<specs>/specs/` yet, add one that states today's behaviour.
- **MODIFIED replaces the whole requirement** when the change is archived. Copy the entire block from the living spec, then edit it.
- **Name the sensitive paths.** If the change touches a path under `delivery.sensitivePaths`, say so in Impact. The plan will stop for the user's decision.
- **Nothing that belongs in the pull request goes in a file**: no approvals, sign-offs, chat quotes, names of people or history.

## 5. Validate

When the project uses OpenSpec (a `<specs>/config.yaml`, or `@fission-ai/openspec` in its package.json), run:

```bash
OPENSPEC_TELEMETRY=0 npx @fission-ai/openspec@1.14.3 validate <id> --strict --no-interactive
```

It must pass. Fix the folder; never drop a scenario or soften a requirement to get green. Without OpenSpec, check by hand that every requirement has SHALL text and at least one scenario with WHEN and THEN, and say in the pull request that the CLI did not run.

## 6. Commit the folder alone

```bash
git add <specs>/changes/<id>
git commit -m "docs(<id>): propose <what changes, in a few words>"
```

The first commit on the branch holds only the change folder, so the user reviews the proposal before any code exists.

## 7. Open the draft pull request

```bash
git push -u origin change/<id>
gh pr create --draft --base <base> --title "<what changes for users>" --body-file <body.md>
```

Write the body to a temporary file outside the repository, with these sections:

- **What changes for users**: two or three plain sentences.
- **Proposal**: links to `proposal.md`, and `design.md` when there is one, on the branch.
- **Scenarios**: each scenario's name and the proof you expect for it.
- **Calls made without asking**: each choice you settled, so the user can check it.
- **Approval**: "Comment on this pull request to approve. Nothing is built before that."

When the user asks for changes on the pull request, edit the folder, validate again, commit and push. The pull request conversation is the record; never copy the user's words into the files.

## 8. Report

Tell the user that the proposal is ready and what it will do, in their terms. Name the one decision that is theirs: approving it, or the one open question that blocks it. Give the validation result and the pull request link. The next step is `/falsifiable:ship <id>`, once they have approved.
