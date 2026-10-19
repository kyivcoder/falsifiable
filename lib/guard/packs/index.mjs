// The guard's rule packs, in the order the engine runs them. Each pack is
// {name, emits, line?, command?, edit?, mcp?, runsOnHelp?}:
//
//   line(ctx)               once per Bash call, before its simple commands
//   command(cmd, ctx)       each simple command {argv, assigns, redirects, dir}
//   edit({path, content}, ctx)
//   mcp({tool, server, name, input}, ctx)
//
// Every rule returns null or a hit {rule, why, instead}; `emits` lists the rule
// ids a pack can report (test/guard/rule-ids.test.mjs reads them from source).
import { pack as database } from './database.mjs';
import { pack as deploy } from './deploy.mjs';
import { pack as git } from './git.mjs';
import { pack as github } from './github.mjs';
import { pack as paths } from './paths.mjs';
import { pack as secrets } from './secrets.mjs';

export const PACK_LIST = Object.freeze([paths, database, deploy, git, github, secrets]);
