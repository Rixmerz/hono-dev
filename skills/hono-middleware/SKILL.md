---
name: hono-middleware
description: >-
  How middleware composes in a Hono 4.x project: the per-instance ordered table, global
  app.use versus scoped use(path), registration order against routes and against route()
  mounts, await next(), the ordering trap where a more specific mount registered before its
  parent's auth is never guarded, cors before auth, error handlers, built-ins and typed
  c.set/c.get. Use when editing app.ts or anything that calls .use(), adding auth, CORS, CSRF,
  body limits or logging, or when a middleware does not run, runs twice, or a route is
  unexpectedly public. Query hono_middleware and hono_trace before editing.
user-invocable: false
paths: "src/middleware/**,src/app.ts,src/index.ts,src/routes/**"
---

# hono-middleware

Middleware in Hono is not a folder convention; it is an entry in a table, and an entry only
guards what comes **after** it and matches its path. The question is never "does it run" but
"for which full paths, in which position, and does it call `next()`". Ask before editing.

References: `references/middleware.md`, `../_shared/references/versions.md`.

## Before touching anything

| Question | Call |
|---|---|
| Which middleware guards this exact request, in order? | `hono_middleware(workspace="/abs/path", method="POST", path="/v1/contacts/import")` — the chain for that request |
| Every middleware registration in the project | `hono_middleware(workspace="/abs/path")` — each has `name`, `source`, `kind`, `isAuth`, `registeredAfterRoutes[]` |
| Did it actually run for this URL, or is it unreached? | `hono_trace(workspace="/abs/path", path="/v1/integrations/google-calendar/events", method="GET")` — `steps[]` with `reached: false` |
| Chain per route, not just per request | `hono_routes(workspace="/abs/path", prefix="/v1/integrations", include_middleware=true)` — `chain[]` and `unreached[]` |
| Everything about one route before I edit it | `hono_route(workspace="/abs/path", method="GET", path="/v1/integrations/google-calendar/events")` |
| What breaks if I touch the file that registers it? | `hono_impact(workspace="/abs/path", files=["src/app.ts"])` |
| Which Hono, which runtime? | `hono_project(workspace="/abs/path")` |

## Decision rules

### Order is the table order (hono 4.13.16: `dist/hono-base.js`, `dist/compose.js`)

- `app.use(mw)` registers `ALL *`; `app.use('/admin/*', mw)` registers `ALL /admin/*`. Both
  are entries like any route, and a request runs every matching entry in table order.
- The first entry that returns a response without calling `next()` ends the request. A
  matching middleware **after** that entry is unreached: *probe*, `app.get('/x', h)` then
  `app.use('/x', mw)` → `mw` never ran. `hono_trace` shows it as `reached: false`.
- On one instance, register middleware **before** the routes it targets (M001).
- `parent.route('/v1', child)` copies the child's entries as they are now, in place. A
  `parent.use('*', mw)` written after that `route()` call does not cover the copied routes
  (*probe*; M002). Write global `use()` calls first.
- A mount's own middleware (a `use('*', ...)` inside the child) becomes
  `ALL /v1/<prefix>/*` in the parent's table at the position of the mount.

### The ordering trap: a specific mount before its parent

```ts
v1.route('/integrations/google-calendar', googleCalendarRoutes)   // first
v1.route('/integrations', integrationRoutes)                      // later; has use('*', auth)
```

Resulting table (*probe* on 4.13.16):

```
GET /v1/integrations/google-calendar/events
ALL /v1/integrations/*          <- the auth entry
GET /v1/integrations/list
```

`/v1/integrations/google-calendar/events` answers from the first entry and ends there; the
`ALL /v1/integrations/*` auth entry sits after it and is never reached (*probe*: no auth header
set on `google-calendar`, set on `list`). `hono_route` reports that auth step in the
route's `unreached[]` and leaves it out of `chain[]`; `hono_trace` marks it `reached:false`.

This is a feature when the routes must be public (an OAuth callback), and a hole when they
should not be. Decide which it is before changing anything:

1. Read the comment next to the mounts. If the order is deliberate, leave it and make that
   visible: keep the comment; S002 can report those routes (they lack the auth most of the mount
   carries), and that finding is the known, accepted one.
2. If it is accidental, move the more specific `route()` **after** the guarded parent, or
   guard the specific sub-app on its own (`use('*', auth)` inside it).
3. Never "fix" it by reordering without `hono_trace` on one URL in each sub-app before and
   after; the public routes are exactly the ones that break.

### `await next()`

- A middleware must `await next()` or `return next()`. Without it the downstream handler may
  still run, but nothing after it can see the response: *probe*, `next();` followed by
  `c.header(...)` → 200 and the header is missing (M005). A middleware that neither calls
  `next()` nor returns a response ends in `Context is not finalized.` (the message goes on: "Did you forget to return a
  Response object or await next()?") and a 500 (*probe*; M004).
- `next()` twice throws `next() called multiple times` (`dist/compose.js`).
- Code after `await next()` runs on the way back out; use it for headers, timing, logging.
- To stop the request return a response (`return c.json({ error: 'unauthorized' }, 401)`);
  throw `HTTPException` (`hono/http-exception`) to route it into `onError`.

### CORS before auth

A browser preflight (`OPTIONS`) carries no `Authorization` header. *Probe*: with `cors()`
first, the preflight answers `204`; with the auth middleware first, the same request answers
`401` and the browser reports a CORS failure (M007). Order: `cors()`, then auth.

`cors()` defaults to `origin: '*'` (`dist/middleware/cors/index.js`). `origin: '*'` or a
reflecting origin function together with `credentials: true` is S001: browsers refuse a
wildcard with credentials, and a reflecting function opens every origin to credentialed calls.
List the origins.

### Errors

- `app.onError((err, c) => ...)` and `app.notFound((c) => ...)` are per instance. The root
  should have both (A002, A003).
- A child's `onError` is applied to its handlers **when `route()` runs**: set it before
  mounting (*probe*: set after → `Internal Server Error` from the parent).
- Do not answer with `err.message`, `err.stack` or the raw error (S005); `HTTPException`
  carries its own response through `getResponse()`.

### Built-ins and helpers (names read from `dist/types/middleware/`)

`basic-auth bearer-auth body-limit cache combine compress context-storage cors csrf etag
ip-restriction jsx-renderer jwk jwt language logger method-not-allowed method-override mount
powered-by pretty-json request-id secure-headers serve-static timeout timing trailing-slash`,
imported as `hono/<name>`. Reach for them before writing your own. `hono/combine` exports
`some`, `every`, `except` to compose them. `createMiddleware` from `hono/factory` types a
reusable middleware. Typed per-request state: `new Hono<{ Variables: { user: User } }>()`,
`c.set('user', u)`, `c.get('user')`.

Security-bearing options: a literal secret in `jwt`, `bearerAuth` or `basicAuth` options is
S004; cookie or session auth with state-changing routes and no `csrf()` is S006;
a route that reads `formData` or `parseBody` without `bodyLimit()` is S007.

## Minimal change

1. `hono_middleware(path=...)` for one URL inside the scope and one outside; note `chain[]`.
2. Put the registration on the narrowest instance that covers every route you mean: inside the
   sub-app for a mount, in `app.ts` before the `route()` calls for a global.
3. Prefer a built-in over a hand-written equivalent; prefer extending an existing `use()` over a
   second registration of the same middleware (M006).
4. Validate: `hono_validate(workspace="/abs/path", categories=["middleware", "security"],
   files=["src/app.ts"])`, then the project's type check and tests, then `hono_trace` the same
   two URLs and compare `chain[]` and `reached`.

## Traps

| Trap | ID |
|---|---|
| `use()` after the routes it targets on the same instance | M001 |
| parent `use()` after the `route()` mount it would cover | M002 |
| scoped `use('/x/*')` whose path matches no route | M003 |
| inline middleware that never calls `next()` | M004 |
| `next()` without `await` or `return` | M005 |
| the same middleware twice in one route's chain | M006 |
| `cors()` after an auth middleware over the same paths | M007 |
| `cors` origin `*` or reflected with `credentials: true` | S001 |
| literal secret in `jwt`/`bearerAuth`/`basicAuth` options | S004 |
| cookie auth, state-changing routes, no `csrf()` | S006 |
| `onError` answering with the error message or stack | S005 |
| a route public on a mount where most routes are guarded | S002 |
| root app with no `onError` | A002 |

## Precedence

The project's existing conventions outrank this skill; the user's request and safety
outrank both (`engineering-baseline`). Auth and authz are safety: deny by default, and never
loosen an existing guard, or reorder mounts, to satisfy a preference stated here.
