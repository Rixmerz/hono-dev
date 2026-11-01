---
name: hono-testing
description: >-
  How to test a Hono 4.x app without a server: app.request() with a path, URL or Request,
  bindings and ExecutionContext as the third and fourth arguments, testClient from
  hono/testing for typed calls, Vitest on Node 24, Deno.test with @std/assert, testing
  mounted routes by their full path, middleware order, validators and error handlers, and
  keeping the app separate from the listener. Use when writing or fixing a *.test.ts for a
  route, middleware or validator, when a test gets 404 for a mounted route, or when a task
  mentions app.request, testClient, Vitest or Deno.test. Query hono_routes and hono_trace
  before writing the test.
user-invocable: false
paths: "**/*.test.ts,**/*_test.ts,**/__tests__/**"
---

# hono-testing

A Hono app is a function from `Request` to `Response`. A test calls that function and
asserts on the `Response`; no port, no `fetch`, no child process. The work is choosing the
right entrypoint and the right URL: the **full** path, through every mount. Ask first.

References: `references/testing.md`, `../_shared/references/versions.md`.

## Before touching anything

| Question | Call |
|---|---|
| Which URL do I request? (the composed path, not the sub-app's local one) | `hono_route(workspace="/abs/path", method="GET", path="/v1/contacts/:id")` — `fullPath`, `file`, `line` |
| Which middleware must the request pass, and which are unreached? | `hono_trace(workspace="/abs/path", path="/v1/contacts/42", method="GET")` — `steps[]`, `reached`, `params` |
| Which routes under this prefix have no test yet? | `hono_routes(workspace="/abs/path", prefix="/v1/contacts")`, then `hono_validate(workspace="/abs/path", categories=["conventions"], files=["src/routes/v1/contacts.ts"])` (C004) |
| Which tests cover the file I changed? | `hono_impact(workspace="/abs/path", files=["src/routes/v1/contacts.ts"])` — `tests[]`, `suggestedChecks[]` |
| Which module exports the app (so I import it, not the listener)? | `hono_project(workspace="/abs/path")` — `entry.file`, `entry.app`, `runtime` |
| Which bindings/env does the route read? | `hono_route(workspace="/abs/path", method="GET", path="/v1/contacts/:id")` — `handler.envReads[]` |
| Is the app type chained, so `testClient` is typed? | `hono_rpc(workspace="/abs/path")` |

## Decision rules

### Import the app, never the listener

Test `app.ts` (the composed app, `export const app` or `export default app`), not the file
that calls `serve(...)`, `Deno.serve(...)` or `Bun.serve(...)`. If the app and the listener
share a file, split them first: importing the listener opens a port and the suite does not
exit.

### `app.request` (hono 4.13.16: `dist/hono-base.js` `request`)

```ts
const res = await app.request('/v1/contacts/42')                       // GET
const res = await app.request('/v1/contacts', { method: 'POST', body: JSON.stringify(body),
                                                headers: { 'content-type': 'application/json' } })
const res = await app.request('/v1/x', {}, { API_KEY: 'k' }, executionCtx)   // env, ctx
```

- First argument: a path (`/x` or `x`), a full URL, or a `Request` (*probe*: all four forms
  → 200). Second: `RequestInit`. Third: the bindings object (`c.env`). Fourth: an
  `ExecutionContext`.
- Mounted routes are requested by the **composed** path: a sub-app route registered as
  `/:id` and mounted at `/v1/contacts` is `/v1/contacts/42`. Ask `hono_route`, do not guess.
- A route that reads `c.executionCtx` with no fourth argument throws
  `This context has no ExecutionContext` and answers 500 (*probe*); pass a stub with
  `waitUntil` for Workers-style code.
- JSON bodies need `content-type: application/json`, or a json validator sees `{}` and
  answers 400 (`hono-validation`). Auth goes in `headers`.
- Always assert the status first, then the body: `expect(res.status).toBe(200)`,
  `await res.json()`.

### `testClient` (`hono/testing`)

`testClient(app, env?, executionCtx?, options?)` is `hc('http://localhost', { fetch })`
where `fetch` calls `app.request(...)` (`dist/helper/testing/index.js`). Same typed surface
as `hono-rpc`, so it needs a **chained** app: `testClient(app).v1.contacts[':id'].$get({ param: { id: '42' } })`
(*probe*: env passed as the second argument reaches `c.env`). On an unchained app the client has
no routes (P001). Use `app.request` when you need a raw header, a malformed body or a
non-JSON `content-type`; use `testClient` when the typed input is the point.

### Runners

- **Node 24 + Vitest** (`vitest run`): `import { describe, it, expect } from 'vitest'`. Files must
  match the runner's include globs (`**/*.test.ts` by default) or the suite stays green while
  reporting nothing: note the test count before and after adding a file.
- **Deno**: `Deno.test('GET /hello', async () => { const res = await app.request('/hello');
  assertEquals(res.status, 200) })` with `@std/assert`; `testClient` from `hono/testing`
  works the same (*probe*: `deno test`, both forms pass on hono 4.12.0).
- Same assertions in both: the test body is runtime-agnostic. Only the import line and the
  runner command change (migration notes in `versions.md`).

### What to cover per kind of change

| Change | Test |
|---|---|
| route | 200 path, 404 for a missing id, a wrong method (*probe*: `POST` to a GET-only route → 404; `methodNotAllowed()` from `hono/method-not-allowed`, 4.13, changes that) |
| validator | valid input, invalid input (400 or the hook's status), missing `content-type` |
| middleware | allowed and denied request; a request on a path **outside** its scope; order against a neighbour |
| mounted sub-app | one request by the full path; one that should *not* pass a guard registered after it (`hono_trace` `reached:false`) |
| error handler | a route that throws `HTTPException` and one that throws `Error` |

Fake the outside world at the seam, not inside Hono: pass bindings as the third argument or
inject a service through `c.set` in a test-only middleware; do not mock `hono`.

## Minimal change

1. `hono_route` the target, copy the sibling test's setup (app import, helpers, auth header).
2. Write the test first and watch it fail for the right reason (`expect(...).toBe(...)` on the
   status), then change the code.
3. One `describe` per route module, one `it` per behaviour; each test builds its own request
   and data, no shared mutable state.
4. Run the project's runner (`vitest run`, or `deno test`) and read the count; then
   `hono_validate(workspace="/abs/path", categories=["conventions"], files=[...])`.

## Traps

| Trap | Effect |
|---|---|
| requesting a sub-app route by its local path (`/:id`) on the root app | 404; use the composed path |
| importing the listener file | the suite hangs on an open port |
| test file outside the runner's include globs | green suite, zero tests |
| `app.request` for env-dependent code with no third argument | `c.env` is `undefined` (*probe*), so `c.env.X` throws |
| route module with no test referencing its paths | C004 |
| `testClient` on a non-chained app | no routes on the client (P001) |
| asserting only `res.ok` | a 201 vs 200 regression passes |

## Precedence

The project's existing conventions outrank this skill (test runner, folder, naming); the
user's request and safety outrank both (`engineering-baseline`). If the repo tests with
another runner, follow it; `app.request` is the same call in all of them.
