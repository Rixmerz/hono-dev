# RPC — reference (Hono 4.x)

Sources, read in `hono@4.13.16`: `dist/types/client/{client,types,index,utils}.d.ts`,
`dist/types/hono-base.d.ts` (`route`, `basePath` return types), `dist/types/helper/testing/index.d.ts`;
`@hono/zod-openapi@1.6.3` `dist/index.d.mts` (`OpenAPIHono`); release notes `v4.3.0`, `v4.9.0`,
`v4.10.0`, `v4.11.0`, `v4.12.0`. *probe* marks a compile result from `tsc --noEmit` (TypeScript
6.0.3, `strict`, `module: nodenext`) in an empty scratch directory, using `@ts-expect-error`
lines so a fixed type would fail the build.

## 1. Where the client's types come from

```ts
export declare const hc: <T extends Hono<any, any, any>, Prefix extends string = string>(
  baseUrl: Prefix, options?: ClientRequestOptions) => UnionToIntersection<Client<T, Prefix>>;
```

`T` is any `Hono` with its schema generic `S`. The schema is accumulated by the return types
declared in `hono-base.d.ts`:

- `get | post | put | delete | options | patch | query | all` (`HandlerInterface`) return the
  instance type with the route added to `S`.
- `route<SubPath, SubEnv, SubSchema, ...>(path, app): Hono<E, MergeSchemaPath<SubSchema, MergePath<BasePath, SubPath>> | S, BasePath, CurrentPath>`:
  the sub-app's schema, with its paths prefixed, joins the parent's.
- `basePath<SubPath>(path): Hono<E, S, MergePath<BasePath, SubPath>, MergePath<BasePath, SubPath>>`.

Runtime and types are separate: `route()` mutates the parent and returns `this`, but only
the **declared return type** carries the new routes. A statement that ignores the result
keeps the variable's old type. *Probe*:

```ts
const app2 = new Hono()
app2.route('/v1/contacts', contacts)
hc<typeof app2>('http://localhost').v1   // error: property 'v1' does not exist
```

and a chained `new Hono().route('/v1/contacts', contacts)` gives
`client.v1.contacts[':id'].$get(...)` and `.import.$post(...)`.

## 2. The client surface (`client/types.d.ts`)

- Methods: `$get $post $put $delete $options $patch $query`; `$all` is expanded into every
  standard method by `ExpandAllMethod`.
- Each method takes `(args, options?)`, `args` being the endpoint's `input`
  (`{ param, query, json, form, header, cookie }` as validators declared them); when the input
  has required keys the argument is required.
- `$url(arg?)` returns a typed `URL` (`TypedURL`) when the base URL is a literal (4.11);
  `$path(arg?)` returns the path string (4.12), `/v1/contacts/9` for `:id` = `'9'`
  (*probe*: type `'/v1/contacts/9'`). `$ws()` exists for endpoints whose output format is `ws`.
- Responses are `ClientResponse<T, Status, Format>`: `ok` and `status` narrow the union;
  `json()` is `Promise<T>` when the format is `json`.
- `ClientRequestOptions`: `fetch`, `webSocket`, `init` (highest priority, can overwrite `body`,
  `method`, `headers`), `buildSearchParams`, `headers` (object or function, possibly async).
- From `hono/client`: `hc`, `parseResponse`, `DetailedError`, `InferRequestType`,
  `InferResponseType`, `ApplyGlobalResponse`, `ClientResponse`, `ClientRequest`,
  `ClientRequestOptions`, `PickResponseByStatusCode`, `Fetch` (`client/index.d.ts:5`).
- `parseResponse(client.x.$get())` parses by content type and throws `DetailedError` when
  the response is not ok (4.9).

## 3. Why status codes matter

Handlers return `TypedResponse<body, status, format>`. `c.json({ id }, 200)` and
`c.json({ n }, 201)` give two members of the union; `c.json(x)` without a status leaves `res.status` as the wide `ContentfulStatusCode` (*probe*:
assigning it to `200` is error TS2322), so narrowing on `res.status` only works when the handler
spells the status.
Since 4.10, a response returned by an earlier handler in the same chain is part of the route's
type, so a guard that answers `c.json({ error: 'forbidden' }, 403)` shows on the client.
`ApplyGlobalResponse<typeof app, { 401: { json: {...} } }>` (4.12) is applied by hand: it adds
responses that every route can produce (for example a global 500 from `onError`) to the client
type, which is then passed to `hc<...>`.

## 4. Validators feed the input

`zValidator('json', schema)` (and `vValidator`, `sValidator`, `validator`) contribute the
`in` side of the handler's input type: `$post({ json })`. *Probe*: a schema of
`z.object({ rows: z.array(z.string()) })` makes `$post({ json: { rows: 1 } })` fail to compile.
`json` and `form` are not valid for GET routes (`ValidationTargetByMethod`), so those inputs
can only exist on non-GET methods.

## 5. Monorepo shape

```ts
// server/src/app.ts
export const app = new Hono().route('/v1', v1)     // chained
export type AppType = typeof app
// web/src/api.ts
import type { AppType } from '../../server/src/app.ts'   // type-only: no server code in the bundle
export const api = hc<AppType>(import.meta.env.VITE_API_URL)
```

The runtime listener (`serve(...)`, `Deno.serve(...)`) belongs in a different file from the
exported app so type imports do not pull it in.

## 6. In tests

`testClient(app, env?, executionCtx?, options?)` from `hono/testing` is `hc('http://localhost',
{ fetch: (input, init) => app.request(input, init, env, executionCtx) })`
(`dist/helper/testing/index.js`): the same typed surface with no network. See `hono-testing`.

## 7. What the tools report

`hono_rpc` returns `RpcInfo`: `appTypes[]` with `name`, `file`, `line`, `target` (the AppId the
type refers to or `null`), `chained` (is the target the result of an unbroken chain) and
`routeCount`; `clients[]` with `file`, `line`, `typeArg` (the text inside `hc<...>`),
`appType` (the resolved exported name or `null`), `baseUrl`. A `chained: false` entry is
P001; a client with `appType: null` is P002. `hono_impact` lists `rpcTypes[]` for a change that
reaches an app type.

## Validator IDs

P001, P002, V004 — see `../../_shared/references/rules.md`.
