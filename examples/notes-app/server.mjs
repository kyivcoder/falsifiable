// The notes app: a small HTTP server with an in-memory store and no dependencies.
//
//   npm start      listens on http://localhost:3000 (set PORT to change it)
//   npm test       test/notes.test.mjs starts its own server on a free port
//
// Routes: GET /health, GET /api/notes, POST /api/notes, and GET / for the page
// in public/index.html. Notes live in memory, so a restart clears them.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MAX_TEXT_CHARS = 280;
export const MAX_BODY_BYTES = 10 * 1024;
const DEFAULT_PORT = 3000;
const PAGE = new URL('./public/index.html', import.meta.url);

/** Why a parsed request body is not a valid new note, or null when it is. */
export function noteProblem(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  if (typeof body.text !== 'string') return 'text is required and must be a string';
  const text = body.text.trim();
  if (text === '') return 'text must not be empty';
  if (text.length > MAX_TEXT_CHARS) return `text must be at most ${MAX_TEXT_CHARS} characters`;
  return null;
}

/** An in-memory store; list() returns the newest note first. */
export function createStore() {
  const notes = [];
  let nextId = 1;
  return {
    list: () => [...notes],
    add(text) {
      const note = { id: nextId, text, createdAt: new Date().toISOString() };
      nextId += 1;
      notes.unshift(note);
      return note;
    },
  };
}

/** Writes a JSON response. */
function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const notAllowed = (res, allow) => send(res, 405, { error: `use ${allow}` }, { allow });

/** The request body as text, or null when it is larger than MAX_BODY_BYTES. The body is always read to the end. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function addNote(req, res, store) {
  const raw = await readBody(req);
  if (raw === null) return send(res, 413, { error: `the body must be at most ${MAX_BODY_BYTES} bytes` });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'the body must be valid JSON' });
  }
  const problem = noteProblem(body);
  if (problem) return send(res, 400, { error: problem });
  return send(res, 201, { note: store.add(body.text.trim()) });
}

async function sendPage(res) {
  const html = await readFile(PAGE);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
  res.end(html);
}

/** The request handler for one store. */
export function createApp(store = createStore()) {
  return async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/health') return req.method === 'GET' ? send(res, 200, { status: 'ok' }) : notAllowed(res, 'GET');
      if (pathname === '/api/notes') {
        if (req.method === 'GET') return send(res, 200, { notes: store.list() });
        if (req.method === 'POST') return await addNote(req, res, store);
        return notAllowed(res, 'GET, POST');
      }
      if (pathname === '/' || pathname === '/index.html') return req.method === 'GET' ? await sendPage(res) : notAllowed(res, 'GET');
      return send(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'something went wrong; try again' });
      else res.destroy();
    }
  };
}

/** An HTTP server with its own empty store. */
export const createServer = (store) => http.createServer(createApp(store));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createServer().listen(port, () => console.log(`notes app on http://localhost:${port}`));
}
