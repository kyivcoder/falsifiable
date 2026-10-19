# Security

falsifiable's guard is a safety layer for coding agents, so a way around it is a security bug.

## Threat model

falsifiable is built for a capable agent that makes mistakes and, when one route is blocked, tries another. That is how coding agents actually behave: asked to ship, an agent that cannot `git push origin main` may try `git push origin HEAD:main`, or the same push inside `bash -c`. The guard is meant to stop all of those.

It is not a sandbox against hostile code. A program the agent writes and runs can open its own network connections and files, and a hook that reads commands cannot see inside it. So:

- The guard blocks the command shapes agents use, and every bypass that is found becomes a case that must block in the test table.
- The role fences are allowlists: a role can use only the tools and programs its job needs, so an unlisted shape is refused rather than missed.
- Anything that must hold even against hostile code belongs in the platform's own controls as well: an OS sandbox for the agent, branch protection on the remote, database roles without production access. falsifiable complements them; it does not replace them.

## Reporting

Please report a bypass privately through GitHub's "Report a vulnerability" button on this repository, not in a public issue. Include the exact tool call (the command, the file path or the MCP tool and its input) and the config, if any.

## What counts

- A command, file write or MCP call that the documented rules say is blocked, but that passes.
- A way for an agent to change the guard's policy, its hooks, git's hooks or the harness settings from inside a session that was not unlocked.
- A crash or timeout that lets a tool call through (the hook is meant to fail closed).
- A role agent using a tool, program or path its fence does not allow.

## What does not

- Programs the agent runs that open connections or files themselves (a script that connects to a database). The guard reads commands; it is not a sandbox.
- Anything a person does in a session they started with the unlock variable.
