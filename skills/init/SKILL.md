---
name: init
description: Set up falsifiable in this repository - a review checklist, an enforced rules section in AGENTS.md and a drafted .claude/falsifiable.json, all read from the real repository - then run the plugin's config and rule checks.
disable-model-invocation: true
---

# Set up falsifiable in this repository

Write the three files the plugin reads, from what the repository really has, then prove them with the plugin's own checks. Never write a command, a path or a URL you have not seen in the repository.

## 1. Inspect the repository

Read before you write anything:

- **Languages and tools**: `package.json` and its workspaces, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, the lockfiles.
- **Commands**: the scripts in `package.json`, the targets in a `Makefile`, and what CI runs (`.github/workflows/*.yml` or another CI config). A command counts only if you saw it defined.
- **Folders**: the layout from `git ls-files`, and where product source, tests, migrations, auth, billing or payments, and infrastructure live.
- **A server**: a start or dev script, its port, and a health route (search the routes for `health`).
- **Test instruments**: a browser test runner (Playwright, Cypress) with its page objects and fixtures, and the browser MCP servers in `.mcp.json`.
- **What exists already**: `AGENTS.md`, `CLAUDE.md`, `.claude/falsifiable.json`, `.claude/review-checklist.md`, an OpenSpec folder, and whether ESLint is installed.
- **The default branch**: `git symbolic-ref --short refs/remotes/origin/HEAD`, or ask the user.

## 2. Draft `.claude/falsifiable.json`

Read `${CLAUDE_PLUGIN_ROOT}/schema/config.schema.json` for what each key means. Write only the keys whose default is wrong for this project:

- `guard.protectedBranches` and `delivery.baseBranch`: the default branch.
- `delivery.domains`: one per real area (for example `api`, `web`, `infra`). Each has `owns` (globs of folders that exist; domains do not overlap), `proof` (how a change there is proven, in one sentence the builder reads), `gate` (a test command you saw that covers it) and `escalate` (what a builder stops and reports instead of doing).
- `delivery.sensitivePaths`: auth, billing or payments, migrations and infrastructure, only where such folders exist. Each one must lie inside some domain's `owns`, or the config check fails.
- `delivery.specsDir`: the OpenSpec folder, if the project has one.
- `guard.localHosts`: add a host only when the local setup runs its database somewhere other than localhost.
- `verify`, only when there is a server. The verifier tests the running app without seeing the code, and its fence is an allowlist: it reads only the change's spec files, `.verify/` and `readPaths`, runs only curl to the local app and `commands`, and uses only the MCP servers in `mcpServers`. Give it what its job needs and nothing more:
  - `baseUrl` (a local address), `health` (a URL that answers once the app is up) and `instruments` (how to exercise the app, in one sentence).
  - `readPaths`: test instruments it must read, such as the page objects or fixtures of a browser test suite. Never product source, plans or designs. Leave it empty when curl and a browser are enough.
  - `commands`: the words that start each test command it may run, such as `["npx", "playwright", "test"]`, only for a runner the project has installed. Never a build, install, git or deploy command.
  - `mcpServers`: the browser MCP servers it may use, by name or part of one. The default (`chrome`, `playwright`) suits most projects; narrow it to the server the project has.
  - `credentialEnv`: the names of test sign-in variables. Never write a value.

If the file exists, change only what is wrong or missing, and show the user the diff.

The guard protects this file. If the write is blocked, do not look for another way to write it. Show the user the whole file in a code block, and tell them to save it themselves, or to start one session with the unlock variable set to 1 and run `/falsifiable:init` again. The variable's name is `guard.unlockEnv` in the config in force: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` prints it. When that exits 1 instead, the file's own name applies if every problem is an unowned sensitive path; otherwise the default, `FALSIFIABLE_UNLOCK`, does. Give the user the exact command, for example `FALSIFIABLE_UNLOCK=1 claude`, and say that the unlocked session can change every protected path. Then carry on with the next step.

## 3. Write `.claude/review-checklist.md`

Start from `${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md`, and write it to the path in `review.checklist` if the config moves it. Keep the slugs. Rewrite each check in this project's terms (its folders, its test layers, where input enters) and drop an item only when it cannot apply. Add an item for a convention you saw in the code that only a reviewer can judge. If a checklist exists, keep every slug a rule already tags.

## 4. Add the rules section to `AGENTS.md`

- No `AGENTS.md`: create one with a short map (what the project is, its folders, its commands), then the rules section.
- An `AGENTS.md` without the `<!-- rules -->` marker: append the rules section at the end. Never rewrite, move or delete what is there. Rules written elsewhere in the file stay as they are; tell the user which ones could move into the section once each has an enforcer.
- A marked section already: add only the starter rules it lacks.

Start from `${CLAUDE_PLUGIN_ROOT}/templates/agents-rules.md` and make every tag resolve in this project:

- Keep a `[hook:…]` rule only when it applies here, for example no database rule in a project without a database.
- Add a `[check:<name>]` rule for each real gate (tests, lint, typecheck), naming a script or make target that a CI workflow or a git hook runs. A gate nothing runs gets no check rule; tell the user to add it to CI.
- Add a `[test:<path>]` rule only for a test file that exists and goes red when the rule breaks.
- Use `[lint:<rule>]` only when ESLint is installed and the rule is at "error".
- Every `[review:<slug>]` names a slug in the checklist from step 3.

## 5. Prove it

Run both checks from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --check
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-rules.mjs"
```

Fix your own files until both pass. Never weaken a rule to get green: give it a real enforcer, or take it out and tell the user it has none. If the config write was blocked, the config check runs on the defaults; say so.

## 6. Report

Tell the user, in plain words:

- the files you wrote or changed, and any write that was blocked;
- the result of each check, with its output;
- what you inferred and they should confirm: the domains, the sensitive paths, the verify URLs;
- the rules that could not get an enforcer;
- the next step: `/falsifiable:propose <idea>` for the first change.
