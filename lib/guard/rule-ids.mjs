// Every rule id the guard hook can report, with the pack that owns it.
//
// This list is the contract between the guard (which must emit only these ids,
// test/guard/rule-ids.test.mjs), the rule checker (a [hook:<id>] tag resolves
// here) and docs/guard.md (which documents each one).

export const RULES = Object.freeze([
  { id: 'git-no-verify', pack: 'git', summary: 'skipping git hooks: --no-verify, commit -n, HUSKY=0, SKIP_* bypass variables, core.hooksPath changes' },
  { id: 'git-push-protected', pack: 'git', summary: 'any push to a protected branch, including a bare push while on one and MCP commits to one' },
  { id: 'git-force-push-protected', pack: 'git', summary: 'force-pushing, mirroring or deleting a protected branch' },
  { id: 'gh-merge', pack: 'github', summary: 'merging a pull request through gh, the GitHub API or an MCP tool' },
  { id: 'gh-admin', pack: 'github', summary: 'changing repository settings, branch protection, rulesets or secrets' },
  { id: 'db-remote-shell', pack: 'database', summary: 'a database shell or dump tool pointed at a host that is not local' },
  { id: 'db-remote-migrate', pack: 'database', summary: 'schema pushes, migrations or raw execution against a database that is not local' },
  { id: 'db-supabase-cli', pack: 'database', summary: 'Supabase CLI commands that change a linked project' },
  { id: 'db-mcp-write', pack: 'database', summary: 'database MCP tools that change a project (migrations, branches, deploys)' },
  { id: 'db-mcp-sql-write', pack: 'database', summary: 'SQL through an MCP tool that is not read-only' },
  { id: 'deploy-railway', pack: 'deploy', summary: 'Railway commands other than read-only status, logs and listings' },
  { id: 'deploy-vercel', pack: 'deploy', summary: 'Vercel production deploys, promotions, rollbacks, env, domains and aliases' },
  { id: 'deploy-terraform', pack: 'deploy', summary: 'terraform, tofu or terragrunt apply and destroy' },
  { id: 'deploy-mcp', pack: 'deploy', summary: 'deploy-platform MCP tools other than reads, and any tool that exposes variables or secrets' },
  { id: 'protected-path', pack: 'paths', summary: 'writing a protected path with a file tool, an MCP file tool or a shell command, also through a symlink' },
  { id: 'harness-change', pack: 'paths', summary: 'changing Claude Code plugins, MCP servers or settings with the claude CLI' },
  { id: 'secret-in-file', pack: 'secrets', summary: 'new file content that holds what looks like a real credential' },
  { id: 'fence-write', pack: 'fence', summary: 'a role agent writing, or changing the repository, outside what its role allows' },
  { id: 'fence-read', pack: 'fence', summary: 'the verifier reading anything but the change specs, .verify/ and verify.readPaths' },
  { id: 'fence-diff', pack: 'fence', summary: 'the verifier looking at the diff or the history' },
  { id: 'fence-tool', pack: 'fence', summary: 'a role agent using a tool, program or MCP server its role does not allow' },
  { id: 'malformed-input', pack: 'core', summary: 'a hook payload that cannot be read; the guard fails closed' },
  { id: 'internal-error', pack: 'core', summary: 'the guard itself crashed; it fails closed' },
]);

export const BUILT_IN_RULE_IDS = Object.freeze(RULES.map((rule) => rule.id));

/** Every id a [hook:<id>] tag may name for this config: the built-in rules plus guard.blockCommands. */
export function ruleIds(config) {
  const custom = (config?.guard?.blockCommands ?? []).map((command) => command.id);
  return [...BUILT_IN_RULE_IDS, ...custom];
}
