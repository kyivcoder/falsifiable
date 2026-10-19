// API tests for the notes app. Run: npm test
//
// Each test starts its own server, with an empty store, on a free port.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_BODY_BYTES, MAX_TEXT_CHARS, createServer } from '../server.mjs';

/** Starts a server on a free local port; it closes when the test ends. */
async function start(t) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (base, body) =>
  fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const listNotes = async (base) => (await (await fetch(`${base}/api/notes`)).json()).notes;

test('GET /health answers ok', async (t) => {
  const response = await fetch(`${await start(t)}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('a new server has no notes', async (t) => {
  const response = await fetch(`${await start(t)}/api/notes`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), { notes: [] });
});

test('POST /api/notes stores a note with its text trimmed and returns it', async (t) => {
  const base = await start(t);
  const response = await post(base, { text: '  Buy milk  ' });
  assert.equal(response.status, 201);
  const { note } = await response.json();
  assert.equal(note.id, 1);
  assert.equal(note.text, 'Buy milk');
  assert.ok(!Number.isNaN(Date.parse(note.createdAt)), 'createdAt is a timestamp');
  assert.deepEqual(await listNotes(base), [note]);
});

test('the list is newest first', async (t) => {
  const base = await start(t);
  await post(base, { text: 'first' });
  await post(base, { text: 'second' });
  assert.deepEqual((await listNotes(base)).map((note) => note.text), ['second', 'first']);
});

test(`a note may be ${MAX_TEXT_CHARS} characters long`, async (t) => {
  const response = await post(await start(t), { text: 'a'.repeat(MAX_TEXT_CHARS) });
  assert.equal(response.status, 201);
});

test('an invalid note is refused with 400 and a message, and nothing is stored', async (t) => {
  const base = await start(t);
  const cases = [
    ['{ not json', /valid JSON/],
    [[], /JSON object/],
    [{}, /text is required/],
    [{ text: 42 }, /text is required and must be a string/],
    [{ text: '   ' }, /must not be empty/],
    [{ text: 'a'.repeat(MAX_TEXT_CHARS + 1) }, new RegExp(`at most ${MAX_TEXT_CHARS} characters`)],
  ];
  for (const [body, message] of cases) {
    const response = await post(base, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, message);
  }
  assert.deepEqual(await listNotes(base), []);
});

test('a body larger than the limit is refused with 413', async (t) => {
  const base = await start(t);
  const response = await post(base, { text: 'a'.repeat(MAX_BODY_BYTES) });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, new RegExp(`at most ${MAX_BODY_BYTES} bytes`));
  assert.deepEqual(await listNotes(base), []);
});

test('GET / serves the page', async (t) => {
  const response = await fetch(`${await start(t)}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /<form id="add-note"/);
  assert.match(html, /<ul id="notes"/);
});

test('the page names its own empty icon, so a browser never asks for /favicon.ico', async (t) => {
  const html = await (await fetch(`${await start(t)}/`)).text();
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<link rel="icon" href="data:,">/);
});

test('an unknown path is 404 and a wrong method is 405 with the allowed ones', async (t) => {
  const base = await start(t);
  assert.equal((await fetch(`${base}/nowhere`)).status, 404);
  const response = await fetch(`${base}/api/notes`, { method: 'DELETE' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});
