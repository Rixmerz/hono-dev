# Testing — reference (Hono 4.x)

Sources: `hono@4.13.16` `dist/hono-base.js` (`request`, `fetch`), `dist/helper/testing/index.js`
and its `.d.ts`, `dist/types/middleware/method-not-allowed/index.d.ts`;
`hono.dev/docs/getting-started/cloudflare-workers` (testing section, bindings). *probe*
marks behaviour run in an empty scratch directory with Vitest 5.0.5 on Node 26 against hono
4.13.16, except the Deno run, which used hono 4.12.0 because Deno's default minimum
dependency age (24 hours) refused 4.13.16 the day it was published; `request` and
`testClient` are unchanged between the two.

## 1. `app.request`

```js
request = (input, requestInit, Env, executionCtx) => {
  if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
  input = input.toString();
  return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
};
```

(`hono-base.js:315-320`.) So:

- A string that starts with `http://` or `https://` is used as is; anything else is appended
  to `http://localhost`, with `mergePath("/", input)` adding a missing leading slash
  (*probe*: `'/ping'`, `'ping'`, `'http://localhost/ping'` and `new Request(...)` → 200).
- `fetch(request, env, executionCtx)` is the real entrypoint; `request` only builds the
  `Request`. `HEAD` is answered by running the `GET` route (`#dispatch`; *probe*: 200).
- With no third argument `c.env` is `undefined` (*probe*), so `c.env.KEY` throws.
- `c.executionCtx` throws `This context has no ExecutionContext` when the fourth argument is
  missing; the router turns that into a 500 (*probe*). A stub
  `{ waitUntil: vi.fn(), passThroughOnException() {}, props: {} }` satisfies Workers-style code
  (*probe*: `waitUntil` called once).
- A wrong method on an existing path is 404 (*probe*), not 405; `methodNotAllowed({ app })` from
  `hono/method-not-allowed` (4.13) changes that.

## 2. `testClient`

```ts
export declare const testClient: <T extends Hono<any, Schema, string>>(
  app: T, Env?: ExtractEnv<T>["Bindings"] | {}, executionCtx?: ExecutionContext,
  options?: Omit<ClientRequestOptions, "fetch">) => UnionToIntersection<Client<T, "http://localhost">>;
```

Implementation (`dist/helper/testing/index.js`): `hc("http://localhost", { ...options, fetch:
(input, init) => app.request(input, init, Env, executionCtx) })`. Consequences:

- It has the typed surface of `hc` and the same requirement: a chained app (`hono-rpc`).
- `Env` has the app's `Bindings` type (*probe*: `testClient(app, { API_KEY: 'zz' }).env.$get()`
  → `zz`).
- `options` can carry `headers` (for example an `Authorization` header applied to every call).

## 3. Vitest on Node

```ts
import { describe, it, expect } from 'vitest'
import { app } from '../src/app.ts'

describe('GET /v1/contacts/:id', () => {
  it('returns the contact', async () => {
    const res = await app.request('/v1/contacts/42', { headers: { authorization: 'Bearer test' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: '42' })
  })
})
```

- Run with `vitest run`. The default include globs match `*.test.ts` / `*.spec.ts`; a project
  that sets `include` (the contract's `vitest.config.ts` uses `mcp/tests/**/*.test.ts`) only runs
  files inside it.
- Imports use the explicit `.ts` extension under Node's type stripping; `import type` for
  types (`verbatimModuleSyntax`).
- No sleeps: await the `Response`; for background work scheduled with `waitUntil`, collect the
  promises in the stub and `await Promise.all(...)`.

## 4. Deno

```ts
import { assertEquals } from '@std/assert'
import { testClient } from 'hono/testing'
import { app } from './app.ts'

Deno.test('GET /hello via app.request', async () => {
  const res = await app.request('/hello')
  assertEquals(res.status, 200)
})
Deno.test('GET /hello via testClient', async () => {
  const res = await testClient(app).hello.$get()
  assertEquals(await res.text(), 'hi')
})
```

*Probe* (`deno test`, `deno.json` imports `hono` → `npm:hono@4.12.0`, `hono/testing` →
`npm:hono@4.12.0/testing`, `@std/assert` → `jsr:@std/assert@1`): `2 passed | 0 failed`.
The import map needs an entry for each `hono/<subpath>` used.

## 5. Bindings on Workers

`new Hono<{ Bindings: { MY_BUCKET: R2Bucket; USERNAME: string } }>()` types `c.env`
(hono.dev, Cloudflare Workers page, "Bindings"). In tests pass a plain object with fakes as
the third argument; no Workers runtime is needed for routing, middleware and validation tests.
Tests of Durable Objects, KV or R2 behaviour themselves need the platform's own test tooling
and are out of scope for this skill.

## 6. Reading a test from the tools

`hono_impact` returns `tests[]` (the test files that import the changed files, directly or
through the graph) and `suggestedChecks[]`. C004 (info, slow) lists route modules with no test
that references their paths; `hono_validate` skips it when `fast` is true.

## Validator IDs

C004, P001 — see `../../_shared/references/rules.md`.
