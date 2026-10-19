# How falsifiable relates to other kits

falsifiable is not a skills library and not a development method. It is the enforcement layer around a delivery loop: the parts that must hold whatever the model decides. It is meant to run next to a method kit, not instead of one.

This page was checked against each project's repository in October 2026. If something here is out of date, please open an issue.

## The short version

| Kit | Core idea | What it enforces at run time |
|---|---|---|
| [Superpowers](https://github.com/obra/superpowers) | A development method as skills that trigger on their own: brainstorm, plan, test-driven development, systematic debugging, verification before completion | Nothing by design; its one hook loads the method at session start |
| [Everything Claude Code](https://github.com/affaan-m/ECC) | A large catalogue of agents, skills, rules and hooks, plus a learning loop that turns observed tool use into "instincts" | Some hooks block (skipping git hooks, editing lint configs); its delivery rules are prose |
| [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) | A brainstorm → plan → work → review → compound loop, with parallel workers that own files exclusively and a cross-model reviewer | No hooks; ownership and review are instructions to the model |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Change folders (proposal, design, tasks, spec deltas with scenarios) archived into living specs | `openspec validate` |
| [spec-kit](https://github.com/github/spec-kit) | Spec-driven templates: constitution, specify, plan, tasks, implement | Nothing at run time |
| [claude-code-hooks](https://github.com/karanb192/claude-code-hooks), [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) | Tested command guards: git safety (push to main, `gh pr merge`), and packs of destructive operations | Their hooks |

## How they fit together

- **Superpowers** is the method inside each step. When it is installed, falsifiable's builder uses its test-driven development skill, the planner its debugging skill for bug fixes, and `/falsifiable:propose` its brainstorming skill. falsifiable adds what a method cannot: checks that hold when the model does not follow it.
- **OpenSpec** is the format. A change is an OpenSpec change folder, and its scenarios are the contract the planner, the builders and the verifier work from. The OpenSpec CLI is optional.
- **Command guards** overlap with falsifiable's guard. The difference in emphasis: falsifiable asks "is the target production?" (a non-local database host, a deploy, a protected branch) rather than "is the command destructive?", because a read on production is still an incident for an agent. It also fences the plugin's own roles.
- **Compound Engineering** and falsifiable share the shape of parallel workers with exclusive file ownership and a second-model review. falsifiable checks the ownership in code before any builder starts, and checks each builder's report against the real diff.

## What falsifiable adds

I found no packaged equivalent of these in October 2026:

1. **A rule without an enforcer fails.** Every rule in `AGENTS.md` ends with a tag naming what enforces it (`[hook:…]`, `[lint:…]`, `[check:…]`, `[test:…]`, `[review:…]`), and `check-rules` fails on a rule without one or a tag that resolves to nothing.
2. **A verifier that is blind to the code by construction.** The plugin's hook gives the verifier agent an allowlist: it may read the change's scenarios and nothing of the code, the plan, the design or the diff, and it may use only requests to the local app, the commands the project names and the browser servers it names. It tests the running app against the spec's scenarios, as a user would.
3. **Tested orchestration.** The workflows run in unit tests against a fake agent runtime with schema-checked results, so a blocked lane, a third fix round or a non-local verifier URL is proven without paying for agents.
4. **Evidence checked twice.** A builder must report each new test's red run and green run; the workflow checks the report's shape and lane, and the reviewer checks it against the diff.

## Honest limits

The threat model is a capable agent that makes mistakes, not hostile code ([SECURITY.md](../SECURITY.md)).

- The guard parses shell commands; it does not sandbox programs. A script that opens a database connection itself is invisible to it. Run agents with an OS sandbox as well when that matters.
- The role fences cover Claude Code's tools. A builder's lane scope is checked after the fact (by the workflow and the reviewer), not prevented while it works.
- The verifier is only as good as the scenarios. A scenario that says nothing a user can observe cannot be verified blind.
