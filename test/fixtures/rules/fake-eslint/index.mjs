// A stand-in for a project's ESLint, for test/check-rules.test.mjs.
//
// The tests link it in as <project>/node_modules/eslint. It implements the two
// methods check-rules calls, with flat-config meaning: entries apply in order to
// the files their `files` globs match, an entry with only `ignores` ignores
// paths, and severities come back as numbers, as ESLint returns them.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { matches } from '../../../../lib/glob.mjs';

const LEVELS = { off: 0, warn: 1, error: 2 };

/** The numeric severity of a rule entry: 'error', 2 and ['error', options] all give 2. */
const level = (entry) => {
  const value = Array.isArray(entry) ? entry[0] : entry;
  return typeof value === 'number' ? value : LEVELS[value];
};

/** The file's path relative to cwd, with forward slashes. */
const relativeTo = (cwd, file) => path.relative(cwd, file).split(path.sep).join('/');

export class ESLint {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.entries = import(pathToFileURL(path.join(cwd, 'eslint.config.mjs')).href).then((module) => module.default);
  }

  async isPathIgnored(file) {
    const rel = relativeTo(this.cwd, file);
    return (await this.entries).some((entry) => entry.ignores && !entry.files && entry.ignores.some((glob) => matches(glob, rel)));
  }

  async calculateConfigForFile(file) {
    const rel = relativeTo(this.cwd, file);
    const rules = {};
    for (const entry of await this.entries) {
      if (entry.files ? !entry.files.some((glob) => matches(glob, rel)) : !entry.rules) continue;
      for (const [name, value] of Object.entries(entry.rules ?? {})) rules[name] = [level(value)];
    }
    return { rules };
  }
}
