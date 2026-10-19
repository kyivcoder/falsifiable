// The secrets pack: no real-looking credential lands in a file through a file
// tool. The scanner (../secrets.mjs) lets placeholders, local database URLs and
// obvious fakes through, and names the kind of secret, never its value.
//
// Tests: node --test test/guard/engine.test.mjs
import { block } from '../args.mjs';
import { findSecret } from '../secrets.mjs';

/** A file tool write whose new content holds a real-looking credential. */
function secretInFile(edit, ctx) {
  const secret = findSecret(typeof edit.content === 'string' ? edit.content : '', edit.path, { localHosts: ctx.guard.localHosts });
  if (!secret) return null;
  return block(
    'secret-in-file',
    `the new content holds what looks like a real ${secret.label}`,
    'Read it from an environment variable and keep real values out of the repository; use an obvious placeholder in examples and tests',
  );
}

export const pack = Object.freeze({
  name: 'secrets',
  emits: Object.freeze(['secret-in-file']),
  edit: Object.freeze([secretInFile]),
});
