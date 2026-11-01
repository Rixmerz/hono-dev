# Routing — reference (Hono 4.x)

Sources, all read in `hono@4.13.16` (`npm pack hono@4.13.16`, extracted in an empty
directory): `dist/hono-base.js`, `dist/types/hono-base.d.ts`, `dist/utils/url.js`,
`dist/router.js`, `dist/hono.js`, `dist/types/helper/route/index.d.ts`,
`dist/middleware/mount`; `@hono/zod-openapi@1.6.3` `dist/index.d.mts`. Behaviour claims
marked *probe* were run against the installed package with Vitest 5.0.5 on Node 26 and
TypeScript 6.0.3 (`app.request(...)`, then `app.routes`).

## 1. The table

`class Hono` keeps `routes: RouterRoute[]` and a `router` (`hono-base.js:25-31`). Every
route method goes through `#addRoute(method, path, handler, baseRoutePath?)`
(`hono-base.js:241-250`):

```js
path = mergePath(this._basePath, path);
const r = { basePath: ..., path, method, handler };
this.router.add(method, path, [handler, r]);
this.routes.push(r);
```

- `get post put delete options patch query` are generated from `METHODS` (`router.js:17-25`);
  each call appends **one entry per handler**, so `app.get('/x', a, b)` is two entries.
- `app.on(method | method[], path | path[], ...handlers)` loops paths then methods.
- `app.use(path?, ...handlers)`: no string first argument means path `*` and the first
  argument is the first handler; each handler becomes an `ALL` entry.
- `app.all(path, ...)` is the same machinery with method `ALL`.

*probe*: `new Hono().route('/p', child)` with `child.get('/a')` gives `app.routes` =
`['GET /p/a']`.

## 2. `route()`, `basePath()`, `mount()`

```js
route(path, app) {
  const subApp = this.basePath(path);
  app.routes.map((r) => {
    let handler;
    if (app.errorHandler === errorHandler) handler = r.handler;
    else { handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res; ... }
    subApp.#addRoute(r.method, r.path, handler, r.basePath);
  });
  return this;
}
```

(`hono-base.js:106-122`.)

- It iterates `app.routes` **now**. Entries the child gets later are not in the parent
  (*probe*: `child.get('/late')` after `parent.route('/p', child)` → `/p/late` is 404).
- `r.path` already contains the child's own `basePath`, then `#addRoute` merges the
  parent's `_basePath` plus the `route()` prefix (*probe*: child `basePath('/cms')`, then
  `/admin`, then `/v1` → `GET /v1/admin/cms/pages/:id`).
- A child with a custom `onError` has every copied handler wrapped by it **at copy time**
  (*probe*: `onError` set before `route()` → the child handler answers; set after → the
  parent's default `Internal Server Error`). `notFound` is not copied.
- `route()` returns `this` (the parent), so `new Hono().route('/a', x).route('/b', y)` is a
  valid chain for RPC types.

`basePath(path)` (`hono-base.js:76-83` `#clone`, `:132-136`): the clone has `routes = this.routes`
(same array), the same router, and `_basePath = mergePath(this._basePath, path)`. Routes
added through the clone land in the original's table (*probe*: `app.routes[0].path` is
`/api/x`).

`app.mount(path, handler, options?)` registers one `ALL` entry at
`mergePath(path, '*')` (`hono-base.js:210-239`), rewrites the request so the handler sees
the path without the prefix (*probe*: `/ext/a/b` → handler sees `/a/b`). It is marked
`@deprecated`, removed in v5; use `app.all('/ext/*', mount(handler))` from `hono/mount`
(also *probe*d: same table entry, same rewrite).

## 3. `mergePath`

`dist/utils/url.js` `mergePath(base, sub, ...rest)`, documented in the file:

```
mergePath('/api', '/users')  // '/api/users'
mergePath('/api/', '/users') // '/api/users'
mergePath('/api', '/')       // '/api'
mergePath('/api/', '/')      // '/api/'
```

A sub-app route registered at `/` under `route('/v1/contacts', ...)` is therefore
`/v1/contacts`, and a trailing-slash prefix keeps its slash. This is the arithmetic the
tools reuse (`mcp/core/match.ts` imports hono's own router; no path math is rewritten).

## 4. Matching

- `new Hono()` builds `SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] })`
  (`hono.js:23`). 4.13 makes `RegExpRouter` throw `UnsupportedPathError` while a route is
  registered; `SmartRouter` then falls through to `TrieRouter` (release notes, v4.13.0).
- A request runs the matched entries in table order through `compose` (`compose.js`): the
  first handler that returns a response without `next()` ends the chain. If the table has
  exactly one match, the handler is called directly (`hono-base.js:256-298`, `#dispatch`).
- Same method and path twice: the first wins (*probe*: `first`).
- Param before static: the param handler wins (*probe*: `/users/:id` then `/users/me` →
  `param`; swapped → `static`).
- `strict` (default `true`) distinguishes `/x` from `/x/` (*probe*: `/x/` → 404);
  `strict: false` swaps `getPath` for `getPathNoStrict` and serves both (`hono-base.js:74`).

- The router freezes at the first match: `MESSAGE_MATCHER_IS_ALREADY_BUILT` (`dist/router.js:29`,
  "Can not add a route since the matcher is already built.") is thrown by `add` afterwards
  (*probe*).

## 5. Path syntax

`:name`, `:name?`, `:name{regex}`, `*`. `checkOptionalParameter` (`dist/utils/url.js`),
called from each router's `add` (`router/trie-router/router.js:8`), expands a trailing `?` into two registrations. `c.req.param('id')` / `c.req.param()` read the
captured values; a `param` validator validates them (`hono-validation`).

## 6. Helpers that tell you where you are

`hono/route` (`dist/types/helper/route/index.d.ts`): `matchedRoutes(c)`, `routePath(c, index?)`,
`baseRoutePath(c, index?)`, `basePath(c, index?)`. *probe*: a handler registered with
`.get('/:id')` on a child mounted at `/v1/things` returns `routePath(c)` =
`/v1/things/:id` and `baseRoutePath(c)` = `/v1/things`. The older `c.req.matchedRoutes` and
`c.req.routePath` getters are `@deprecated` (`dist/types/request.d.ts:250,278`).

## 7. `OpenAPIHono` (`@hono/zod-openapi@1.6.3`)

`class OpenAPIHono extends Hono`, overrides `route()` (two overloads) and `basePath()`
to return `OpenAPIHono`, and adds `.openapi(routeConfig, handler, hook?)`, `.openapiRoutes([...])`,
`.doc(path, config)`, `.doc31(...)`, `getOpenAPIDocument(...)`. `.openapi()` registers the
route in the Hono table **and** in `openAPIRegistry`; mounting follows the same `route()`
copy-at-call rule. `createRoute({ method, path, ... })` paths use `/users/{id}`; the Hono
path is converted to `/users/:id` (`ConvertPathType` in the same `.d.mts`).

## 8. Report shape the tools give

`hono_routes` and `hono_route` return `RouteEntry` records: `id`, `method`, `fullPath`,
`localPath`, `app`, `file`, `line`, `mountChain[]` (`{ app, prefix, file, line }` from root to
the defining app), `reachable`, `pathNonLiteral`, `kind` (`'route' | 'mount'`), `params[]`,
`chain[]`, `unreached[]`, `confidence` (`'extracted' | 'inferred'`). A route registered on an
instance that no root mounts has `root: null` and `reachable: false` (R004). A mount edge
whose prefix is not a literal is `inferred` and the route is flagged `pathNonLiteral` (R005).

## Validator IDs

R001–R007, P001 — see `../../_shared/references/rules.md`.
