---
name: hono-rpc
description: >-
  How Hono's RPC mode works in a 4.x project: hc<AppType>() from hono/client, why the
  exported app type only carries routes that were registered in one chain and mounted with
  the result of route() kept, exporting the type, typed params/json/query on the client,
  $url/$path, parseResponse, InferRequestType/InferResponseType, and the hc client in tests.
  Use when adding or exporting an AppType, writing or fixing an hc client, when the client
  shows no routes or any, or when a task mentions hc, RPC, AppType, typeof app or a typed
  client. Query hono_rpc and hono_routes before editing.
user-invocable: false
paths: "src/app.ts,src/index.ts,src/routes/**,src/client/**"
---

# hono-rpc

The `hc` client has no schema file. Its types are whatever TypeScript infers from
`typeof app`, and `typeof app` only knows the routes that were registered through the
**return value** of each call. A route added by a statement on an already-declared variable
is invisible to the client, and nothing fails at runtime. Ask what the app type contains
before you write a client call.

References: `references/rpc.md`, `../_shared/references/versions.md`.

## Before touching anything

| Question | Call |
|---|---|
| Which app types are exported, are they chained, how many routes do they carry? | `hono_rpc(workspace="/abs/path")` — `appTypes[]`: `name`, `file`, `line`, `target`, `chained`, `routeCount` |
| Which `hc` clients exist and which type do they pass? | the same call — `clients[]`: `file`, `line`, `typeArg`, `appType`, `baseUrl` |
| Does the route I want on the client exist, with which validators? | `hono_route(workspace="/abs/path", method="POST", path="/v1/contacts/import")` — `validators[]`, `file`, `line` |
| Which routes does an app type cover (compare with its `routeCount`)? | `hono_routes(workspace="/abs/path", app="src/app.ts#app")` |
| What else imports the file that exports the type? | `hono_dependencies(workspace="/abs/path", file="src/app.ts", direction="importers")` |
| What breaks if I change a response shape? | `hono_impact(workspace="/abs/path", files=["src/routes/v1/contacts.ts"])` — `rpcTypes[]` lists the app types affected |
| Which Hono version (client features differ by minor)? | `hono_project(workspace="/abs/path")` |

## Decision rules

### One chain, kept result (hono 4.13.16 types; *probe* = `tsc` with TypeScript 6.0.3)

```ts
const contacts = new Hono()
  .get('/:id', (c) => c.json({ id: c.req.param('id') }, 200))
  .post('/import', zValidator('json', importSchema), (c) => c.json({ n: 1 }, 201))

export const app = new Hono().route('/v1/contacts', contacts)   // result is the app
export type AppType = typeof app
```

- Each `.get()/.post()/.route()` returns a **new type** that adds its route to the schema
  generic. `typeof app` is complete only if `app` is the value of the whole chain.
- Not chained: `const app = new Hono(); app.get('/x', h)` leaves `typeof app` with an empty
  schema. *Probe*: `hc<typeof app>(url).x` is a type error. The same happens for
  `const app = new Hono(); app.route('/v1/contacts', contacts)`: the result of `route()` is
  thrown away. That is P001.
- A sub-app that is mounted must itself be chained, or its routes never reach the parent type.
- `basePath()` returns a typed instance too, so `new Hono().basePath('/api').get(...)` is fine;
  the prefix is part of the type (*probe*: `basePath('/cms')` under `route('/v1', ...)` types as
  `client.v1.cms.pages[':id']`).
- `OpenAPIHono` keeps the chain: `.openapi()`, `.route()`, `.basePath()` return `OpenAPIHono`
  carrying the schema.

### Export the type, not the value

`export type AppType = typeof app`, and in the consumer
`import type { AppType } from '../server/src/app.ts'` (`verbatimModuleSyntax` requires
`import type`). Importing the app value into a client bundle drags the server in. If the
client imports a type name that is not exported, or passes a name that resolves to
something that is not an app type, that is P002.

### Calling it

```ts
import { hc } from 'hono/client'
import type { AppType } from './app.ts'

const client = hc<AppType>('http://localhost:3000')
const res = await client.v1.contacts[':id'].$get({ param: { id: '42' } })
if (res.ok) { const body = await res.json() }
```

- Path segments become properties; `:id` is `[':id']`; methods are `$get`, `$post`, `$put`,
  `$patch`, `$delete`, `$options`, `$query` (4.13), and `$all` expands to every method.
- Request args are typed from validators: `{ param, query, json, form, header, cookie }`
  (*probe*: `$post({ json: { rows: 1 } })` fails to compile when the schema wants `string[]`).
- Response typing needs the status in the handler: `c.json(body, 201)`. Without it `res.status`
  is the wide `ContentfulStatusCode` (*probe*: not assignable to `200`) and narrowing on it
  does nothing. `res.json()` is the union of the declared bodies; narrow with `res.status`.
- `$url()` (typed, 4.11) and `$path()` (a path string, 4.12) build URLs
  (*probe*: `$path({ param: { id: '9' } })` has type `'/v1/contacts/9'`).
- `parseResponse(client.x.$get())` from `hono/client` (4.9) parses the body and throws a
  `DetailedError` on a non-ok response.
- `InferRequestType<typeof client.v1.contacts.import.$post>` and
  `InferResponseType<typeof ..., 201>` extract the types (both exported from `hono/client`).
- Headers and fetch: `hc<AppType>(url, { headers, fetch, init })`; an auth header goes in
  `headers` (a function is allowed), not into each call.

### The full path again

The client path is the composed path. `new Hono().route('/v1/contacts', contacts)` gives
`client.v1.contacts`, never `client[':id']`. If `hono_routes` shows `/v1/contacts/:id` and the
client does not have `.v1.contacts[':id']`, the type is losing a link in the chain.

## Minimal change

1. `hono_rpc` first. If `chained` is `false` or `routeCount` is lower than
   `hono_routes(app=...)` returns, fix the chain before touching a client.
2. Chain the route onto the existing builder; keep the status in `c.json(body, status)`.
3. Export `AppType` from the file that already exports the app, once.
4. Add or update the client call; let TypeScript prove it (`tsc --noEmit`), do not cast.
5. Validate: `hono_validate(workspace="/abs/path", categories=["rpc"], files=[...])`, then
   `hono_rpc(workspace="/abs/path")` again and compare `routeCount`.

## Traps

| Trap | ID |
|---|---|
| exported app type from a non-chained instance: the client sees no routes | P001 |
| `hc<T>()` where `T` is not an exported app type | P002 |
| `app.route(...)` as a statement, result unused | P001 |
| a json/form validator on a GET route: the client has no way to send it | V004 |
| client imports the app value instead of the type | bundle drags server code |

## Precedence

The project's existing conventions outrank this skill; the user's request and safety
outrank both (`engineering-baseline`). If the repo already exposes its client types through
a different module or package layout, follow it, and report a P001 or P002 finding rather
than restructuring the exports.
