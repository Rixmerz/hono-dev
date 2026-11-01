# Hono 4.x — one-page cheat-sheet

Source: `hono@4.13.16` (`npm pack hono@4.13.16`: `dist/hono-base.js`, `dist/types/**`),
the GitHub release notes of `honojs/hono` for `v4.0.0` to `v4.13.0`
(`gh api repos/honojs/hono/releases/tags/<tag>`), `hono.dev/docs/getting-started/{nodejs,bun,deno,cloudflare-workers}`,
and the packed tarballs of the validator packages listed below. Nothing here comes from
memory. Run `hono_project(workspace="/abs/path")` first: `honoVersion` and `runtime` say which
rows apply. The 4.x line is the supported target; the installed package is the authority
when it disagrees with a summary written here.

## 4.x minors that change what you write

| Minor (release date) | What it changed for application code |
|---|---|
| 4.0 (2024-02-09) | baseline of this line |
| 4.1 (2024-03-11) | WebSocket helper (`upgradeWebSocket`); `hc` works on WebSocket endpoints |
| 4.2 (2024-04-02) | JWT algorithms 3 → 13; method-override middleware |
| 4.3 (2024-05-03) | RPC: `c.text()` is a `TypedResponse`; every JSON primitive is inferred |
| 4.4 (2024-05-27) | published on JSR as `@hono/hono` (the source of C002 two-copies trouble) |
| 4.5 (2024-07-16) | built-in middleware count reaches 20 (ip-restriction, cache, combine among them) |
| 4.6 (2024-09-11) | `contextStorage()` middleware (`AsyncLocalStorage`) |
| 4.7 (2025-02-07) | Standard Schema validator is born (`@hono/standard-validator`); proxy helper; language and JWK middleware |
| 4.8 (2025-06-17) | route helper (`hono/route`: `routePath`, `baseRoutePath`, `matchedRoutes`); zod v4 support in `@hono/zod-validator`; in 4.13.16 the `c.req.matchedRoutes` / `c.req.routePath` getters are `@deprecated` in favour of it |
| 4.9 (2025-08-07) | `parseResponse` and `DetailedError` from `hono/client` |
| 4.10 (2025-10-16) | middleware type fix: an RPC client now sees the responses of earlier handlers in a chain; `cloneRawRequest` |
| 4.11 (2025-12-13) | typed `$url()` on the client; `tryGetContext`; custom `buildSearchParams`; pathless `.use()` typed correctly in a chain |
| 4.12 (2026-02-19) | `$path()` on the client; `ApplyGlobalResponse`; TrieRouter 1.5x–2x faster |
| 4.13 (2026-08-03) | first-class HTTP `QUERY` method (`app.query()`, in the `METHODS` list); `methodNotAllowed` middleware; `RegExpRouter` throws `UnsupportedPathError` at registration time |

Two facts confirmed in 4.13.16's own source that the tools rely on:

- `METHODS` is `get, post, put, delete, options, patch, query`; `all` and `on` are separate
  (`dist/router.js:17-25`, `dist/hono-base.js:38-58`).
- The default router is `SmartRouter` over `RegExpRouter` then `TrieRouter`
  (`dist/hono.js:23`). A route the RegExpRouter cannot take is retried on the TrieRouter.

### `@deprecated` in 4.13.16 (read from the `.d.ts` files, candidates for C003)

| API | Replacement | Where |
|---|---|---|
| `app.mount(path, handler)` | `app.all('/p/*', mount(handler))` with `mount` from `hono/mount`; removed in v5 | `dist/types/hono-base.d.ts:155` |
| `app.fire()` | `fire` from `hono/service-worker` (itself deprecated: install `@hono/service-worker`) | `hono-base.d.ts:215` |
| `c.req.matchedRoutes`, `c.req.routePath` | `matchedRoutes(c)`, `routePath(c)` from `hono/route` | `dist/types/request.d.ts:250,278` |
| `hono/vercel`, `hono/netlify`, `hono/lambda-edge`, `hono/service-worker`, and the `hono/deno` and `hono/cloudflare-workers` adapter helpers | the `@hono/*` packages; removal in v5 | `dist/types/adapter/**` |
| bearer-auth `noAuthenticationHeaderMessage`, `invalidAuthenticationHeaderMessage`, `invalidTokenMessage` | `noAuthenticationHeader.message`, `invalidAuthenticationHeader.message`, `invalidToken.message` | `dist/types/middleware/bearer-auth/index.d.ts:17-26` |

The authoritative list the validator uses is the one in `rules.md` (C003); this table is
what was read, not a promise about what C003 flags.

## Packages the skills assume (peer ranges read from the tarballs)

| Package | Version checked | Peers | Entry |
|---|---|---|---|
| `@hono/zod-validator` | 0.9.1 | `hono >=4.11.2`, `zod ^3.25.0 \|\| ^4.0.0` | `zValidator(target, schema, hook?)` |
| `@hono/valibot-validator` | 0.6.2 | `hono >=3.9.0`, `valibot ^1.0.0` | `vValidator(target, schema, hook?)` |
| `@hono/standard-validator` | 0.4.1 | `hono >=4.11.2`, `@standard-schema/spec ^1.0.0` | `sValidator(target, schema, hook?)` |
| `@hono/zod-openapi` | 1.6.3 | `hono >=4.10.0`, `zod ^4.0.0` | `OpenAPIHono`, `createRoute`, `.openapi()` |
| `@hono/node-server` | 2.1.5 | `hono ^4 \|\| ^5.0.0-0`; Node `>=20` | `serve({ fetch, port })` |

`hono/validator` (`validator(target, fn)`) ships inside `hono` itself and needs no package.

## Runtimes: how the app is exposed

| Runtime | Entry shape (hono.dev getting-started pages) | Env access | Detected by `hono_project` as |
|---|---|---|---|
| Node | `serve({ fetch: app.fetch, port: 3000 })` from `@hono/node-server` | `process.env` | `runtime: 'node'`, `entry.serve: 'node-server'` |
| Deno | `Deno.serve(app.fetch)` or `Deno.serve({ port: 8787 }, app.fetch)` | `Deno.env.get()` | `runtime: 'deno'`, `serve: 'deno-serve'` |
| Bun | `export default app`, or `export default { port: 3000, fetch: app.fetch }` | `Bun.env`, `process.env` | `runtime: 'bun'`, `serve: 'bun-serve'` or `'export-default'` |
| Cloudflare Workers | `export default app` | bindings on `c.env` (typed through `new Hono<{ Bindings: B }>()`) | `runtime: 'cloudflare-workers'`, `serve: 'export-default'` |

`env(c)` from `hono/adapter` reads the right place per runtime; `getRuntimeKey()` returns
`'node' | 'deno' | 'bun' | 'workerd' | 'fastly' | 'edge-light' | 'other'`
(`dist/types/helper/adapter/index.d.ts`). A hard-coded `process.env` on Workers, `Deno.env`
on Node or `c.env` on Node is C001.

## Deno → Node migration notes

The target of this plugin's author is Deno code moving to Node 24. Ask `hono_project`
for the current state, then work through this list; every item is a change to the
runtime layer, none touches the route table.

| Deno | Node 24 | Check |
|---|---|---|
| `deno.json` `imports`: `"hono": "npm:hono@4"` | `package.json` dependency `"hono"`, pinned the way the repo pins | `hono_project` → `honoVersion.declared` / `resolved`, `configFiles` |
| `jsr:@hono/hono` next to `npm:hono` | one copy only, the npm one; two copies break `instanceof` and types | C002 |
| `Deno.serve({ port, signal }, app.fetch)` | `serve({ fetch: app.fetch, port })` from `@hono/node-server`; it returns the `node:http` server, closing it is yours | `hono_project` → `entry` |
| `Deno.env.get('X')` | `process.env.X`, validated once at start | C001, S003 |
| `Deno.test` + `jsr:@std/assert` | Vitest (`vitest run`); `app.request` and `testClient` are unchanged | `hono-testing` |
| import map aliases (`"@/": "./src/"`) | package.json `imports` (`"#/*"`) or relative paths; Node does not read tsconfig `paths` | `hono_dependencies` shows unresolved specifiers |
| `.ts` extension in every import (Deno requires it) | same, and Node's type stripping also needs `import type` and erasable syntax only (no `enum`, `namespace`, parameter properties) | `tsc --noEmit` with `erasableSyntaxOnly` |
| `deno.json` `tasks` | `package.json` `scripts` | `hono_project` → `configFiles` |
| `hono/deno`, `serveStatic` from `hono/deno` | `serveStatic` from `@hono/node-server/serve-static` | deprecated-adapter table above |

Move the runtime layer last: keep `app.ts` (the composed app) free of `Deno.*`, `process.*`
and `serve(...)`, and put the listener in a separate `main.ts` / `index.ts`. The same
`app.ts` then runs under `app.request` in tests on either runtime.
After the move, `hono_reindex(workspace="/abs/path", force=true)` and compare
`hono_routes(workspace="/abs/path")` before and after: the table must be identical.
