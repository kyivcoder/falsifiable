# The guard

The guard is one Claude Code `PreToolUse` hook, `scripts/hook.mjs`, registered in `hooks/hooks.json`. It runs before every Bash, Write, Edit, MultiEdit, NotebookEdit, Read, Grep, Glob, WebFetch, WebSearch and MCP tool call, in the main session and inside every subagent. It does two jobs:

- **The guard** blocks calls that reach production, skip git hooks, merge pull requests, change protected paths, change the harness or write secrets. It applies to every agent, the main session included.
- **The role fences** keep each `falsifiable:<role>` agent to what its role may read, write and run: the verifier only drives the running app, the reviewer and the scout only read, the planner writes only the plan.

A block exits with code 2 and prints one line to stderr, which Claude Code shows the model as the tool error:

```
falsifiable guard blocked: git-push-protected: this push reaches the protected branch main; agents never push to a protected branch. Push a feature branch (git push -u origin <branch>) and open a pull request.
```

Every message names the rule, says why, and says what to do instead.

## Threat model

The guard is built for a **capable agent that makes mistakes** and, when one route is blocked, tries another — which is what coding agents actually do. It is **not a sandbox against hostile code**. A program the agent writes and runs can open its own connections and the guard cannot see inside it.

What follows from that:

- The guard blocks the **command shapes** agents use, read best-effort from the command line. Every bypass we find becomes a must-block case in `test/guard/cases.mjs`, so the set only grows.
- The role fences are **allow-lists**: a role can use only what its job needs, so a new trick is refused by default rather than needing a new rule.
- Anything that must hold against hostile code belongs to the platform, which the guard complements, not replaces: an **OS sandbox** for code execution, **branch protection** on the remote, and **database roles** for the data. A broken config can only *add* protection, never remove it.

## What it is not

- **It reads commands; it does not run them.** Shell parsing is best effort. It sees through `;`, `&&`, `|`, `$(...)`, backticks, `bash -c`, `eval`, heredocs, `cd`, and the wrappers `env`, `sudo`, `timeout`, `xargs`, `nohup`, `npx`, `pnpm exec`, `yarn`, `bun`, `dotenv`, `doppler run`, `op run`, `infisical` and `docker exec`. A script that opens a database or calls an API itself (`node migrate.js`) is invisible to it.
- **It does not know your production.** It knows which hosts are local (`guard.localHosts`) and treats every other database host as production. It holds no credentials and asks no server anything.
- **It is not a permission system.** Claude Code's own permission rules still apply; the guard adds rules permissions cannot express, such as "push, but never to `main`".

## How it decides

For each tool call the hook:

1. Reads the payload from stdin. A payload it cannot read blocks with `malformed-input`.
2. Loads `.claude/falsifiable.json` from `$CLAUDE_PROJECT_DIR` (or the payload's `cwd`). **A broken file only adds protection:** the defaults apply, plus the file's own valid protective lists (protected branches and paths, blocked commands); lists that grant access are ignored until it is fixed. Every block then ends with `(The falsifiable config is invalid, so the defaults apply: <first problem>.)`.
3. Runs the role fence when the caller is a `falsifiable:<role>` agent. Read, Grep, Glob, WebFetch and WebSearch stop here.
4. Runs the guard: every enabled pack's rules, then `guard.blockCommands`.
5. Exits 0 and prints nothing when nothing blocked. A crash blocks with `internal-error`, and `hooks.json` sets `"onFailure": "block"` so a timeout does too.

A Bash command is split into simple commands, each unwrapped and judged on its own. `git checkout main && git push` is followed through, and a push's branch is the one checked out **where that command runs** (`-C`, `--git-dir`/`GIT_DIR`, the folder reached by `cd`); a folder whose branch the guard cannot read makes a bare or `HEAD` push count as protected. A command given `--help` as its last word only prints help and passes, but where its output is redirected still counts. An unquoted heredoc body is read: a shell runs the whole body, and `$(...)` or backticks anywhere in it run as commands; a quoted heredoc (`<<'EOF'`) stays inert.

## Rules

| Rule id | Blocks | Pack |
| --- | --- | --- |
| `git-no-verify` | skipping git hooks: `--no-verify` (and prefixes), `commit -n`, `SKIP`/`SKIP_*HOOK*`/`HUSKY=0`/`LEFTHOOK=0`/`OVERCOMMIT_DISABLE`, and `core.hooksPath` set (via `git config`, `-c`, `--config-env`, or `GIT_CONFIG_*`) anywhere but the root of a protected hooks folder. A bypass counts when the command sets it; a session the user started with the hooks off is the user's choice | git |
| `git-push-protected` | any push that reaches a protected branch: by name, `HEAD`/`@`, `:main` deletes, `--all`, a wildcard refspec that can match one, a `remote.<x>.push` or `push.default=matching` config, a bare push on a protected or unreadable branch; `gh api` ref moves; GitHub MCP commits to a protected or default branch. `--dry-run` passes | git |
| `git-force-push-protected` | `--force`, `-f`, `--force-with-lease`, `+refspec` or `--mirror` reaching a protected branch | git |
| `gh-merge` | `gh pr merge`, `gh api` merges, auto-merge and merge GraphQL mutations (read from a `--input`/`-F query=@file` body too, or blocked when that body cannot be read), GitHub MCP merge tools | github |
| `gh-admin` | `gh secret`, `gh repo edit/delete/rename/archive`, `gh api` or GraphQL writes to branch protection, rulesets, secrets or repo settings, GitHub MCP tools that change them | github |
| `db-remote-shell` | `psql`, `pgcli`, `pg_dump`, `pg_restore` and friends pointed at a host that is not local — including `hostaddr`, host lists, a `service`/`PGSERVICE`, and `PGHOST`/`PGHOSTADDR` from the environment — at an unresolvable target, or given `PGPASSWORD` | database |
| `db-remote-migrate` | Prisma `migrate deploy/reset/dev/resolve`, `db push/execute`, unless every URL in the command (and `DATABASE_URL`/`DIRECT_URL` in its environment) is local | database |
| `db-supabase-cli` | Supabase CLI commands that change or read out a linked project | database |
| `db-mcp-write` | Supabase MCP tools that change a project (migrations, functions, branches, pause/restore) | database |
| `db-mcp-sql-write` | `execute_sql` that is not read-only — write keywords and side-effect functions count, even when quoted (`"setval"`) | database |
| `deploy-railway` | every `railway` command except status, logs, listings, whoami, link and help; `railway variables` too | deploy |
| `deploy-vercel` | `vercel --prod`, `--target production`, `env`, `promote`, `rollback`, `alias`, `rm`, `domains`, `dns`, `certs`, `pull`, `redeploy` | deploy |
| `deploy-terraform` | `terraform`, `tofu`, `terragrunt` `apply` and `destroy` | deploy |
| `deploy-mcp` | Railway and Vercel MCP tools other than reads, and any that expose variables or secrets | deploy |
| `protected-path` | changing a protected path with a file tool, an MCP file tool (a write-verb name with a path field), or the shell (redirect, `tee`, `cp`/`cp -t`, `mv`, `rm`, `ln`, `tar -x -C`, `sed -i`, `dd of=`, `git restore`/`checkout`/`rm`/`mv`/`apply`), a folder that holds one, a reaching glob, or a symlink that lands on one | paths |
| `harness-change` | `claude plugin disable/uninstall/remove`, `marketplace remove`, `mcp add/remove/add-json`, `config set/add/remove` | paths |
| `secret-in-file` | new file content that holds what looks like a real credential; placeholders and obvious fakes pass | secrets |
| `fence-write` | a role agent writing, or changing the repository, outside what its role allows | fence |
| `fence-read` | the verifier reading or searching outside the change specs, `.verify/` and `verify.readPaths` | fence |
| `fence-diff` | the verifier looking at the diff or the history | fence |
| `fence-tool` | a role agent running a program, MCP server or web tool its role does not allow | fence |
| `malformed-input` | a payload or tool call the hook cannot read | core |
| `internal-error` | the hook itself crashed | core |

`lib/guard/rule-ids.mjs` is the registry; `test/guard/rule-ids.test.mjs` reads every `block('<id>')` from the sources and fails when an id is emitted but unregistered, or registered but never emitted.

## Protected paths

A protected glob is matched against a target **relative to the root of the git worktree that holds it** (at any depth inside it), so a checkout under a folder named like a protected glob is judged by its own layout; a target outside every worktree is matched by its absolute path. A write is judged as written, where a symlink really lands, and through a symlink made earlier in the same command line. `$VAR` references in a target are resolved from the shell variables set earlier in that command. Comparison ignores case.

Default `protectedPaths`: `.github/workflows/**`, `.githooks/**`, `.husky/**`. These built-ins are always added and no config can remove them: `.claude/settings.json`, `.claude/settings.local.json`, `.claude/falsifiable.json`, `.claude/hooks/**`, `.claude/plugins/**`, `.mcp.json`, `.git/config`, `.git/config.worktree`, `.git/hooks/**`.

## Configuration

Everything lives in `.claude/falsifiable.json`; `schema/config.schema.json` is the full shape. The guard reads `guard.packs` (which packs run), `guard.protectedBranches`, `guard.localHosts`, `guard.protectedPaths`, `guard.unlockEnv`, and `guard.blockCommands` (extra commands to block, matched on the words of each simple command after unwrapping). `--help` and a pack left out of `packs` turn a rule off; `blockCommands` run even with every pack off.

## Role fences

Only `falsifiable:<role>` agent types are fenced; the main session, other agents and the builder pass. The fences are allow-lists:

| Role | May write | May read | May run |
| --- | --- | --- | --- |
| planner | `<specsDir>/changes/*/tasks.md` | anything | anything (never changes the repo through git) |
| verifier | `.verify/**` | the change specs (`<specsDir>/changes/**/specs/**`), `.verify/**`, and `verify.readPaths` | `curl`/`wget` to the local app, a few housekeeping commands, and `verify.commands`; MCP only from `verify.mcpServers`; never the diff, the history or the web |
| reviewer, scout | nothing | anything | read-only git and gh, a fixed set of read-only programs, and `review.secondOpinion`; MCP only with a read-shaped name |

Every role may also write to `/dev/null` and its scratchpad from the shell. The verifier's `verify.readPaths`, `verify.commands`, `verify.mcpServers` and the reviewer's `review.secondOpinion` widen these allow-lists; they are ignored while the config is broken. Fences are enforced in the hook, keyed on the payload's `agent_type`, because Claude Code ignores `hooks` in plugin agent frontmatter.

## Unlocking protected paths

Agents cannot change the guard's policy, the harness settings, the MCP servers or CI. When a person wants an agent to make such a change, they start the session with the unlock variable set to `1`:

```sh
FALSIFIABLE_UNLOCK=1 claude
```

Only the session's own environment counts — an unlock set inside a command, or exported in one, does not unlock anything. A session started this way can change protected paths for its whole life, so end it once the change is made. The unlock lifts no other rule. The variable name is `guard.unlockEnv` (default `FALSIFIABLE_UNLOCK`).

## Limits

The guard reads command shapes, so some forms it cannot resolve. It is honest about them rather than pretending otherwise:

- **Code it cannot see.** A program the agent writes and runs (`node x.js`, `python x.py`, a compiled binary) can reach production on its own. Use an OS sandbox.
- **A program name from a substitution.** `$GIT push origin main` is caught — an unresolvable `$VAR` program is judged as each guarded program would be. `$(which git) push origin main`, where the name comes from a command substitution, is not: the inner `which git` is seen, but the outer words are not attributed to git.
- **A deploy tool behind a variable.** `$X up` is not matched against the deploy tools, which are blocked by name; a literal `railway up` is.
- **An archive without `-C`.** `tar -x -C <dir>` is judged by its target folder; a `tar -x` with no `-C` that unpacks a protected path into the current folder is not read from the tarball.
- **A heredoc fed to a program the guard does not unwrap.** A body piped to `bash`/`sh`/`zsh`, or its `$(...)`, is read; a body consumed by another interpreter is not.
- **Best-effort shell reading.** Deeply nested quoting, unusual expansions and exotic redirections may be read imperfectly; the guard errs toward finding a command rather than missing one.
- **The verifier's browser.** MCP servers named in `verify.mcpServers` are allowed by name; the URLs a browser server opens are not checked the way the verifier's `curl` is.
- **Known open variants.** Independent reviews of this version found further command forms the parser misses. They are tracked privately and each becomes a must-block case when it is fixed. If you find one, report it as [SECURITY.md](../SECURITY.md) describes.

## Running the tests

```sh
node --test "test/guard/*.test.mjs"          # everything below
node --test test/guard/engine.test.mjs       # the case table against the engine
node --test test/guard/hook.test.mjs         # the same table end to end through scripts/hook.mjs
node --test test/guard/fence.test.mjs        # role fences against throwaway repositories and worktrees
node --test test/guard/paths.test.mjs        # protected paths and symlinks in a real worktree
node --test test/guard/shell.test.mjs        # the shell reader
node --test test/guard/rule-ids.test.mjs     # emitted ids match the registry
node scripts/mutants.mjs                      # every planted mutant is caught by a test
```

`test/guard/cases.mjs` is the shared case table: what must block, with which rule id, and what must pass. A new rule starts there, with its blocked and allowed cases, before any code. Secret-shaped fixtures are assembled at runtime, so the file holds none.
