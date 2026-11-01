# Middleware — reference (Hono 4.x)

Sources, read in `hono@4.13.16` (`npm pack hono@4.13.16` in an empty directory):
`dist/compose.js`, `dist/hono-base.js`, `dist/middleware/cors/index.js`,
`dist/types/middleware/*/index.d.ts`, `dist/types/helper/factory/index.d.ts`,
`dist/types/http-exception.d.ts`. Claims marked *probe* were run with Vitest 5.0.5 on
Node 26 against that package (`app.request(...)`). The ordering case reproduces
`xpteam-backend/src/app.ts:307-308` with two small sub-apps.

## 1. What a middleware is

`MiddlewareHandler = (c, next) => Promise<Response | void>`. Registering one is
`app.use(path?, ...handlers)`: each handler becomes an `ALL` entry in the instance's table
(`hono-base.js:61-68`; no string first argument means path `*`). There is no separate middleware
stack; a handler and a middleware differ only by whether they call `next()`.

## 2. `compose` (`dist/compose.js`)

```js
async function dispatch(i) {
  if (i <= index) throw new Error("next() called multiple times");
  index = i;
  ...
  if (handler) try { res = await handler(context, () => dispatch(i + 1)); }
  catch (err) { if (err instanceof Error && onError) { context.error = err; res = await onError(err, context); isError = true; } else throw err; }
  else if (context.finalized === false && onNotFound) res = await onNotFound(context);
  if (res && (context.finalized === false || isError)) context.res = res;
  return context;
}
```

- Each matched entry gets `next = () => dispatch(i + 1)`. Past the last entry, if nothing
  has finalized the context, `notFound` runs.
- `res` is only taken when the context is not yet finalized (or on an error): the **first**
  response wins; a later middleware that returns a different `Response` after `await next()`
  does not replace it unless it uses `c.res = ...`.
- `#dispatch` (`hono-base.js:256-298`) throws `Context is not finalized.` ("Did you forget to
  return a Response object or await next()?") when the composed chain ends without a
  response. *probe*: `app.use('*', async () => {})` then a `get('/x')` → status 500 and that
  message on stderr (M004).
- *probe*, un-awaited `next()`: `app.use('*', async (c, next) => { next(); c.header('x-after','1') })`
  → status 200 for `GET /x`, but the header is `null` on the response (M005).

## 3. Order experiments (all *probe*)

| Setup | Observed |
|---|---|
| `app.get('/x', h)` then `app.use('*', mw)` | `mw` header absent: mw never ran for `/x` |
| `parent.route('/c', child)` then `parent.use('*', mw)` | `/c/a` has no `mw` header |
| `v1.route('/integrations/google-calendar', gcal)` then `v1.route('/integrations', integrations)` with `integrations.use('*', mw)` | table `GET /v1/integrations/google-calendar/events`, `ALL /v1/integrations/*`, `GET /v1/integrations/list`; `mw` header absent on `google-calendar/events`, present on `list` |
| `cors()` then auth, `OPTIONS /x` with `Origin` and `Access-Control-Request-Method` | 204 |
| auth then `cors()`, same request | 401 |
| child `onError` set before `parent.route()` | child handler answers |
| child `onError` set after `parent.route()` | parent default `Internal Server Error` |

Why the third row happens: `route()` appends the child's entries in order at the moment it
is called (`hono-base.js:106-122`), so the entry `ALL /v1/integrations/*` lands after every
entry of the earlier mount. The more specific mount returns a response and `compose` never
dispatches the later entry. What `hono_route` returns for that route: `chain[]` without the
auth step, `unreached[]` containing it. `hono_trace` lists the same step with
`reached: false`.

## 4. Error handling

- Default handler (`hono-base.js:9-21`): an error with `getResponse` (an `HTTPException`)
  answers its own response; anything else is `console.error(err)` and a plain
  `Internal Server Error` 500. Default not-found: `404 Not Found`.
- `app.onError(handler)` and `app.notFound(handler)` set the instance's handlers. A parent
  `onError` does not apply to a mounted child whose own `onError` is set before `route()`.
- `HTTPException(status?, { res?, message?, cause? })` from `hono/http-exception`;
  `status` defaults to 500; `getResponse()` rebuilds `res` with the exception's status, or answers
  `message` as the body (`dist/http-exception.js`).

## 5. Built-in middleware (directory names of `dist/types/middleware`)

`basic-auth`, `bearer-auth`, `body-limit`, `cache`, `combine`, `compress`,
`context-storage`, `cors`, `csrf`, `etag`, `ip-restriction`, `jsx-renderer`, `jwk`, `jwt`,
`language`, `logger`, `method-not-allowed`, `method-override`, `mount`, `powered-by`,
`pretty-json`, `request-id`, `secure-headers`, `serve-static`, `timeout`, `timing`,
`trailing-slash`. Each is exported as `hono/<name>` (`package.json` `exports`).

Signatures read from the `.d.ts`:

- `cors(options?: CORSOptions)`: `origin?: string | string[] | (origin, c) => ...`,
  `allowMethods`, `allowHeaders`, `maxAge`, `credentials`, `exposeHeaders`. Defaults:
  `origin '*'`, `allowMethods ['GET','HEAD','PUT','POST','DELETE','PATCH','QUERY']`.
- `csrf(options?: { origin?, secFetchSite? })`.
- `methodNotAllowed({ app, onMethodNotAllowed? })` from `hono/method-not-allowed` (4.13): answers 405
  with the allowed methods instead of the default 404 (`onMethodNotAllowed(c, allowedMethods)`).
- `bodyLimit({ maxSize: number, onError? })`.
- `bearerAuth({ token, realm?, prefix?, headerName?, hashFunction?, noAuthenticationHeader?,
  invalidAuthenticationHeader?, invalidToken?, ... })`. The `*Message` options are
  `@deprecated` in favour of the objects with `.message`.
- `some(...mw | condition)`, `every(...)`, `except(conditionOrPaths, ...mw)` from `hono/combine`.
- `mount(applicationHandler, options?)` from `hono/mount`, registered with `app.all('/p/*', ...)`.

## 6. Writing one

```ts
import { createMiddleware } from 'hono/factory'

type Env = { Variables: { requestId: string } }

export const requestIdMiddleware = createMiddleware<Env>(async (c, next) => {
  c.set('requestId', crypto.randomUUID())
  await next()
  c.header('x-request-id', c.get('requestId'))
})
```

`createMiddleware` and `createFactory` live in `dist/types/helper/factory/index.d.ts`.
Typed state is declared once on the app's generic (`new Hono<Env>()`) and on each sub-app that
reads it; a mismatch is a type error, not a runtime one. Prefer the project's existing
`AppEnv` type over a new one.

## Validator IDs

M001–M007, S001, S002, S004, S005, S006, S007, A002, A003 — see
`../../_shared/references/rules.md`.
