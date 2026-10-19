// The deploy pack: agents inspect deploy platforms but never deploy, change
// infrastructure or read secrets. Railway, Vercel and Terraform (also tofu and
// terragrunt) from the shell, and the Railway and Vercel MCP tools.
//
// Tests: node --test test/guard/engine.test.mjs
import { block, flagValue, hasFlag, positionals } from '../args.mjs';

const RAILWAY_SAFE = new Set(['status', 'logs', 'log', 'whoami', 'list', 'help', 'docs', 'version', 'completion', 'open', 'login', 'logout', 'link', 'unlink']);
const RAILWAY_VALUE_OPTS = ['-s', '--service', '-e', '--environment', '-p', '--project', '-d', '--deployment', '-n', '--lines'];

/** Railway commands other than the read-only ones. */
function railway({ argv }) {
  if (argv[0] !== 'railway') return null;
  if (hasFlag(argv, '--help', '-h', '--version', '-V')) return null;
  const [sub = '', second = ''] = positionals(argv, RAILWAY_VALUE_OPTS);
  if (sub === '' || RAILWAY_SAFE.has(sub)) return null;
  if (sub === 'deployment' && ['list', 'ls'].includes(second)) return null;
  if (sub === 'service' && ['status', 'logs', 'list'].includes(second)) return null;
  const why = ['variables', 'variable', 'vars'].includes(sub)
    ? 'railway variables prints or changes production secrets'
    : `railway ${sub} deploys, changes or opens a shell on production infrastructure`;
  return block('deploy-railway', why, 'Inspect with railway status, railway logs or railway deployment list; deploys and infrastructure changes are for the user');
}

const VERCEL_BLOCKED = new Set(['env', 'promote', 'rollback', 'alias', 'aliases', 'remove', 'rm', 'domains', 'domain', 'dns', 'certs', 'cert', 'pull', 'redeploy', 'secrets', 'secret']);
const VERCEL_VALUE_OPTS = ['--scope', '-S', '--token', '-t', '-A', '--local-config', '-Q', '--global-config', '--cwd', '--target', '-e', '--env', '-b', '--build-env', '-m', '--meta', '--regions', '--archive'];

/** Vercel production deploys and production configuration commands. */
function vercel({ argv }) {
  if (argv[0] !== 'vercel' && argv[0] !== 'vc') return null;
  const target = flagValue(argv, '--target');
  const prod = hasFlag(argv, '--prod', '--production') || ['production', 'prod'].includes(String(target).toLowerCase());
  const [sub = 'deploy', second = ''] = positionals(argv, VERCEL_VALUE_OPTS);
  const removesProject = ['project', 'projects'].includes(sub) && ['rm', 'remove'].includes(second);
  if (!prod && !VERCEL_BLOCKED.has(sub) && !removesProject) return null;
  const why = prod ? 'this deploys to Vercel production' : `vercel ${sub} changes production configuration, domains or secrets`;
  return block('deploy-vercel', why, 'Preview deploys (vercel deploy without --prod), vercel ls and vercel inspect are fine; production is for the user');
}

const TERRAFORM_BINS = new Set(['terraform', 'tofu', 'terragrunt']);

/** terraform, tofu and terragrunt apply and destroy. */
function terraform({ argv }) {
  if (!TERRAFORM_BINS.has(argv[0])) return null;
  const sub = positionals(argv).slice(0, 3).find((p) => p === 'apply' || p === 'destroy');
  if (!sub) return null;
  return block('deploy-terraform', `${argv[0]} ${sub} changes real infrastructure`, `Run ${argv[0]} plan and share the plan; the user applies it`);
}

const SECRET_TOOL = /(variable|secret|(^|[_-])env($|[_-]))/i;
const WRITE_VERB = /(^|[_-])(deploy|redeploy|create|delete|remove|update|set|restart|up|down|rollback|promote|link|add|run|exec|shell|ssh|connect)($|[_-])/i;
const READ_VERB = /(^|[_-])(list|get|search|read|view|fetch|describe|check|status|logs?|whoami|docs?|help|authenticate|authentication)($|[_-])/i;

/** Railway and Vercel MCP tools other than plain reads. */
function deployTool({ server, name }) {
  if (!/railway|vercel/i.test(server)) return null;
  if (!SECRET_TOOL.test(name) && !WRITE_VERB.test(name) && READ_VERB.test(name)) return null;
  return block(
    'deploy-mcp',
    `the MCP tool ${name} deploys, changes infrastructure or exposes environment secrets`,
    'Use the read-only tools (list, get, logs, status) to inspect; deploys and secrets are for the user',
  );
}

export const pack = Object.freeze({
  name: 'deploy',
  emits: Object.freeze(['deploy-railway', 'deploy-vercel', 'deploy-terraform', 'deploy-mcp']),
  command: Object.freeze([railway, vercel, terraform]),
  mcp: Object.freeze([deployTool]),
});
