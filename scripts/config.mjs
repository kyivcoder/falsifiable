#!/usr/bin/env node
//
// Prints the resolved project config, or what is wrong with it.
//
//   node scripts/config.mjs [projectDir]            the resolved config as JSON
//   node scripts/config.mjs --check [projectDir]    "ok", or one problem per line
//
// projectDir defaults to the current folder. The skills run this before a
// workflow, because a workflow script cannot read files: the resolved config
// travels in the workflow's args. Exit codes: 0 valid (or no file: the
// defaults apply), 1 invalid, 2 bad usage.
import { CONFIG_FILE, loadConfig } from '../lib/config.mjs';

const argv = process.argv.slice(2);
const check = argv[0] === '--check';
const rest = check ? argv.slice(1) : argv;
if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) {
  process.stderr.write('usage: node scripts/config.mjs [--check] [projectDir]\n');
  process.exit(2);
}

const { config, problems, found } = loadConfig(rest[0] ?? process.cwd());
if (problems.length) {
  process.stderr.write(`${CONFIG_FILE} is invalid; until it is fixed the defaults apply:\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
  process.exit(1);
}
if (check) process.stdout.write(found ? 'ok\n' : `ok (no ${CONFIG_FILE}; the defaults apply)\n`);
else process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
