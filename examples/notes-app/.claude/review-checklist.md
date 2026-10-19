# Review checklist

The reviewer walks these items for every change, and each `[review:<slug>]` tag in `AGENTS.md` names one of them. An item is one line: the slug in backticks, a colon, then what to check.

### Delivery
- `diff-matches-reports`: the changed files, commits and tests match the lane reports, and the api lane stayed in `server.mjs` and `test/`, the web lane in `public/`.
- `scope`: the diff does what the approved change says and nothing else; a narrowed scope is an open question at the top of the pull request.
- `lane-plan`: the request and response shapes both lanes rely on are written in the plan before either lane starts, and only the api lane changes them.
- `evidence`: the pull request lists the checks that ran with their results and the ones that could not run with the reason.
- `weakened-checks`: no skipped or focused test, no deleted assertion, no loosened status code or message check.

### Safety
- `secrets`: no secret or personal data in a committed file, a fixture, a log line or a command line.
- `production`: nothing runs against a deployed copy of the app; the verifier drives only `http://localhost:3000`.
- `boundary-validation`: every field of a request body is checked in `server.mjs` before it reaches the store, and a bad one gets a 400 with a message.
- `no-dependencies`: `package.json` has no dependencies; the server uses Node built-ins and the page uses plain browser APIs, with no build step.
- `safe-rendering`: the page writes note text with `textContent`, never `innerHTML`, so a note cannot inject markup.

### Tests
- `tests-prove`: each new test fails without the change (its red run is in the lane report) and asserts the response, not a stub.
- `integration-test`: a change to a route or a response shape has a test in `test/` that starts the real server.
