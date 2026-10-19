# Notes app

A notes app with no dependencies: a Node HTTP server, an in-memory store and one page. It is the example project for falsifiable: it carries one proposed change, `add-note-tags`, ready to ship.

## Map

- `server.mjs`: the routes (`GET /health`, `GET /api/notes`, `POST /api/notes`, `GET /` for the page), the request checks and the in-memory store.
- `public/index.html`: the page that lists notes and adds one, in plain HTML and browser JavaScript.
- `test/notes.test.mjs`: API tests; each test starts its own server on a free port.
- `openspec/specs/`: what the app does today. `openspec/changes/`: approved changes in flight.
- `.claude/falsifiable.json`: the two domains (`api` for the server and tests, `web` for the page), their gates, and how the verifier reaches the app. It marks `auth/` as a sensitive area as an example: the app has no sign-in today, so a change that adds one waits for the user's decision before any builder starts.
- `.claude/review-checklist.md`: what the reviewer checks; the `[review:…]` tags below name its items.
- `.github/workflows/ci.yml`: runs `npm test` on every pull request, so the `[check:test]` rule below has something that runs it. Copied out as its own repository, the example's CI runs as is.

## Commands

```bash
npm start   # http://localhost:3000; set PORT to change it
npm test    # the API tests
```

## Rules
<!-- rules -->

### Boundaries
- Never push to `main`; push a branch and open a pull request. [hook:git-push-protected]
- Never merge a pull request; the user merges. [hook:gh-merge]
- Never skip the git hooks. [hook:git-no-verify]
- Never publish this package; it is a private example. [hook:npm-publish]
- Never edit `.claude/falsifiable.json`; ask the user to change it. [hook:protected-path]

### Code
- The server uses Node built-ins only and the page plain browser APIs: no dependencies, no build step. [review:no-dependencies]
- The API checks every field of a request body and answers a bad one with 400 and a message that says what is wrong. [test:test/notes.test.mjs]
- Note text reaches the page through `textContent`, never `innerHTML`. [review:safe-rendering]

### Delivery
- `npm test` passes before a lane reports done; it is the gate of both domains. [check:test]
- The diff does what the approved change says, and nothing else. [review:scope]
- A new test fails without the change, and the lane report shows its red run. [review:tests-prove]
- A change to a route or a response shape comes with a test that starts the real server. [review:integration-test]
