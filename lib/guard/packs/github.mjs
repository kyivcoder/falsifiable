// The github pack: agents never merge a pull request, and never change
// repository settings, branch protection, rulesets or secrets, whether through
// gh, the GitHub API or a GitHub MCP tool.
//
// Tests: node --test test/guard/engine.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { block, positionals } from '../args.mjs';

const GH_VALUE_OPTS = ['-R', '--repo', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q', '--jq'];
const MERGE_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;
const ADMIN_MUTATIONS = /\b(create|update|delete)(BranchProtectionRule|RepositoryRuleset)\b/;
const REPO_ADMIN = ['edit', 'delete', 'rename', 'archive', 'unarchive'];
const READ_ONLY_TOOL = /^(list|get|search|read|view|fetch|describe|check|status|logs?|whoami|docs?|help|authenticate|complete[_-]authentication)([_-]|$)/i;

/** A gh api call's endpoint (no leading slash), HTTP verb and full text. */
export function ghApiRequest(args) {
  let method = null;
  let hasFields = false;
  let endpoint = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '-X' || a === '--method') method = args[(k += 1)];
    else if (a.startsWith('--method=')) method = a.slice('--method='.length);
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
      hasFields = true;
      k += 1;
    } else if (/^(-[fF].|--field=|--raw-field=|--input=)/.test(a)) hasFields = true;
    else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(a)) k += 1;
    else if (!a.startsWith('-') && endpoint === null) endpoint = a;
  }
  return {
    endpoint: String(endpoint ?? '').replace(/^\/+/, ''),
    verb: String(method ?? (hasFields ? 'POST' : 'GET')).toUpperCase(),
    text: args.join(' '),
    argv: args,
  };
}

/** A gh command's group and action (`pr merge`), and for `gh api` the request; null for other programs. */
export function ghCall(argv) {
  if (argv[0] !== 'gh') return null;
  const [group, action] = positionals(argv, GH_VALUE_OPTS);
  return { group, action, api: group === 'api' ? ghApiRequest(argv.slice(argv.indexOf('api') + 1)) : null };
}

const merge = () => block('gh-merge', 'agents never merge pull requests; a person reviews and merges', 'Leave the pull request open and report it as ready for review');
const admin = (what) => block('gh-admin', `${what} changes repository settings, branch protection, rulesets or secrets`, 'Ask the user to make this change');

const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);
const MAX_BODY_BYTES = 256 * 1024;

/** The file a gh field value or --input points at (`@file`, or a bare filename for --input), or null for an inline value. */
const fieldFile = (value) => {
  const at = value.indexOf('@');
  const marker = /^[-\w.]+=@/.test(value) ? value.slice(value.indexOf('=') + 1) : value;
  return marker.startsWith('@') ? marker.slice(1) : at === 0 ? value.slice(1) : null;
};

/** The GraphQL body to judge: the inline text, plus any body files read; {unknown:true} when a body cannot be read. */
function graphqlBody(argv, dir) {
  let text = argv.join(' ');
  const files = [];
  let unknown = false;
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k];
    let spec;
    if (a === '--input') spec = argv[(k += 1)];
    else if (a.startsWith('--input=')) spec = a.slice('--input='.length);
    else if (FIELD_FLAGS.has(a)) spec = fieldFile(argv[(k += 1)] ?? '');
    else if (/^-[fF]./.test(a)) spec = fieldFile(a.slice(2));
    else if (/^--(field|raw-field)=/.test(a)) spec = fieldFile(a.slice(a.indexOf('=') + 1));
    else continue;
    if (a === '--input' || a.startsWith('--input=')) {
      if (spec === undefined || spec === '-') unknown = true;
      else files.push(spec);
    } else if (spec === '-') unknown = true;
    else if (spec) files.push(spec);
  }
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : dir ? path.resolve(dir, file) : null;
    if (abs === null) {
      unknown = true;
      continue;
    }
    try {
      text += ' ' + readFileSync(abs, 'utf8').slice(0, MAX_BODY_BYTES);
    } catch {
      unknown = true;
    }
  }
  return { text, unknown };
}

/** gh api merges and admin writes, REST or GraphQL. */
function apiRule(api, dir) {
  const { endpoint, verb } = api;
  if (endpoint === 'graphql') {
    const { text, unknown } = graphqlBody(api.argv, dir);
    if (MERGE_MUTATIONS.test(text)) return merge();
    if (ADMIN_MUTATIONS.test(text)) return admin('this GraphQL mutation');
    if (unknown) return merge();
    return null;
  }
  if (verb === 'GET' || verb === 'HEAD') return null;
  if (/\/pulls\/[^/]+\/merge\/?$/.test(endpoint) || /\/merges\/?$/.test(endpoint)) return merge();
  if (/\/branches\/[^/]+\/protection|\/rulesets(\/|$)|\/secrets(\/|$)/.test(endpoint)) return admin(`gh api ${verb} ${endpoint}`);
  if (/^repos\/[^/]+\/[^/]+\/?$/.test(endpoint)) return admin(`gh api ${verb} ${endpoint}`);
  return null;
}

/** gh pr merge, gh secret, gh repo admin commands and gh api. */
function ghCommand(cmd) {
  const call = ghCall(cmd.argv);
  if (call === null) return null;
  const { group, action, api } = call;
  if (group === 'pr' && action === 'merge') return merge();
  if (group === 'secret') return admin(`gh secret ${action ?? ''}`.trim());
  if (group === 'repo' && REPO_ADMIN.includes(action)) return admin(`gh repo ${action}`);
  return api ? apiRule(api, cmd.dir) : null;
}

/** GitHub MCP tools that merge or change protection, rulesets or secrets. */
function githubTool({ server, name }) {
  if (!/github/i.test(server) || READ_ONLY_TOOL.test(name)) return null;
  if (/merge/i.test(name)) return merge();
  if (/(protection|ruleset|secret)/i.test(name)) return admin(name);
  return null;
}

export const pack = Object.freeze({
  name: 'github',
  emits: Object.freeze(['gh-merge', 'gh-admin']),
  command: Object.freeze([ghCommand]),
  mcp: Object.freeze([githubTool]),
});
