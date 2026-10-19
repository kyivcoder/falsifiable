#!/usr/bin/env node
//
// The falsifiable PreToolUse hook: the role fences first, then the guard.
//
//   node scripts/hook.mjs < payload.json
//
// Claude Code runs it before every Bash, file, Read, Grep, Glob and MCP tool
// call (hooks/hooks.json), inside subagents too. It reads the hook payload from
// stdin and the project config from $CLAUDE_PROJECT_DIR (or the payload's
// cwd). A block prints "falsifiable guard blocked: <rule>: <why>. <instead>."
// to stderr and exits 2, which Claude Code shows the model as the tool error.
// A payload it cannot read, or a crash, also exits 2: the guard fails closed.
// Otherwise it exits 0 and prints nothing. Read, Grep and Glob go only to the
// fences. An invalid config never weakens the guard: the defaults apply, and
// every block says so.
//
// Tests: node --test test/guard/hook.test.mjs
import { execFileSync } from 'node:child_process';

import { loadConfig } from '../lib/config.mjs';
import { blockMessage, evaluate, malformed } from '../lib/guard/engine.mjs';
import { fence } from '../lib/guard/fence.mjs';

const BRANCH_TIMEOUT_MS = 3000;
const FENCE_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);

/** `git <args>` from the guard's own environment, trimmed, or null when it fails. */
function tryGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: BRANCH_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

/**
 * The branch checked out at a git location: its name, undefined when the folder
 * is not a repository (git would refuse the push, so there is nothing to
 * protect), or null when it is a repository whose branch cannot be read (a
 * detached HEAD, or an unresolvable folder) and the push must fail closed.
 */
function branchAt({ dir, gitDir }) {
  if (gitDir === null || (gitDir === undefined && (dir === null || dir === undefined))) return null;
  const base = gitDir ? ['--git-dir', gitDir] : ['-C', dir || process.cwd()];
  if (tryGit([...base, 'rev-parse', '--is-inside-work-tree']) === null) return undefined;
  const branch = tryGit([...base, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  return branch === null || branch === '' ? null : branch;
}

const EDIT_TOOLS = {
  Write: (i) => ({ path: str(i.file_path), content: str(i.content) }),
  Edit: (i) => ({ path: str(i.file_path), content: str(i.new_string) }),
  MultiEdit: (i) => ({
    path: str(i.file_path),
    content: Array.isArray(i.edits) ? i.edits.map((e) => (isObject(e) ? str(e.new_string) ?? '' : '')).join('\n') : undefined,
  }),
  NotebookEdit: (i) => ({ path: str(i.notebook_path), content: str(i.new_source) ?? '' }),
};

/** The guard request for a payload: {request}, {request: null} for a tool the guard does not check, or {error}. */
function toRequest(payload, env) {
  const tool = payload.tool_name;
  const input = payload.tool_input;
  const cwd = str(payload.cwd);
  if (tool === 'Bash') {
    const command = str(input.command);
    if (command === undefined) return { error: 'tool_input.command is missing' };
    return { request: { kind: 'bash', command, cwd, branchOf: branchAt, env } };
  }
  if (tool in EDIT_TOOLS) {
    const { path, content } = EDIT_TOOLS[tool](input);
    if (path === undefined) return { error: `the ${tool} file path is missing` };
    if (content === undefined) return { error: `the ${tool} content is missing` };
    return { request: { kind: 'edit', path, content, env } };
  }
  if (tool.startsWith('mcp__')) return { request: { kind: 'mcp', tool, input, env } };
  return { request: null };
}

/** The block message for one payload under `config`, or null when the call may go ahead. */
function decide(payload, config, projectDir, env) {
  if (!isObject(payload)) return malformed('the hook payload is not a JSON object').message;
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || tool === '') return malformed('tool_name is missing').message;
  const input = payload.tool_input;
  if (!isObject(input)) return malformed(`tool_input for ${tool} is not an object`).message;
  const fenced = fence(
    { tool, input, agentType: str(payload.agent_type), cwd: str(payload.cwd), scratchpadDir: str(payload.scratchpad_dir), projectDir },
    config,
  );
  if (!fenced.allow) return fenced.message;
  if (FENCE_ONLY_TOOLS.has(tool)) return null;
  const { request, error } = toRequest(payload, env);
  if (error) return malformed(error).message;
  if (request === null) return null;
  const result = evaluate(request, config);
  return result.allow ? null : result.message;
}

/** All of stdin as text. */
async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/** Prints a block message for Claude Code and sets exit code 2. */
function block(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

/** Reads the payload and the config, decides, and reports. */
async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return block(blockMessage('malformed-input', 'stdin is not valid JSON', 'The guard fails closed; retry the tool call, and tell the user if this keeps happening'));
  }
  const env = process.env;
  const projectDir = env.CLAUDE_PROJECT_DIR || (isObject(payload) && str(payload.cwd)) || process.cwd();
  const { config, problems, fallback } = loadConfig(projectDir);
  const message = decide(payload, config, projectDir, env);
  if (message === null) {
    process.exitCode = 0;
    return undefined;
  }
  const note = fallback ? ` (The falsifiable config is invalid, so the defaults apply: ${problems[0]}.)` : '';
  return block(`${message}${note}`);
}

main().catch((error) => {
  block(blockMessage('internal-error', `the guard crashed (${error?.message ?? error})`, 'The guard fails closed; tell the user'));
});
