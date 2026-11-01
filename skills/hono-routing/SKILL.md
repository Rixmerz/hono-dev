---
name: hono-routing
description: >-
  How to reason about routes in a Hono 4.x project: the full composed path across
  app.route() and basePath() mounts (/v1/contacts/:id, never the local /:id), per-instance
  route tables and registration order, why a mounted route shows as /:id in tools that read
  one file, duplicate and shadowed routes, path syntax (:id, :id?, regex, wildcard), strict
  mode, and chaining. Use when adding, moving or renaming a route or a sub-app mount, when
  a URL returns 404 or hits the wrong handler, or when a task mentions route, endpoint,
  sub-app, mount or basePath. Query hono_routes, hono_route and hono_trace before editing.
user-invocable: false
paths: "src/routes/**,src/app.ts,src/index.ts"
---

# hono-routing

A route is not a line in a file; it is an entry in a table that only exists once every
`route()` call has run. The mistakes are rarely in the handler: they are in the prefix, in
the order the mounts were written, or in a route added to a sub-app after it was mounted.
Ask first.

References: `references/routing.md`, `../_shared/references/versions.md`.

## Before touching anything

| Question | Call |
|---|---|
| Which Hono, which runtime, where is the entry? | `hono_project(workspace="/abs/path")` |
| What is the full path of this route, and through which mounts? | `hono_route(workspace="/abs/path", method="GET", path="/v1/contacts/:id")` — `fullPath`, `localPath`, `mountChain[]`, `file`, `line` |
| Which routes live under a prefix, or in one file? | `hono_routes(workspace="/abs/path", prefix="/v1/contacts")` or `hono_routes(workspace="/abs/path", file="src/routes/v1/contacts.ts")` |
| Which handler serves this URL, in which order? | `hono_trace(workspace="/abs/path", path="/v1/integrations/google-calendar/events", method="GET")` — `steps[]` with `reached`, `allowedMethods`, `notFound` |
| Is the path I want already taken or shadowed? | the same trace, before writing the route (R001, R002) |
| Which routes did a single sub-app contribute? | `hono_routes(workspace="/abs/path", app="src/routes/v1/contacts.ts#contactRoutes")` (AppId = `file#localName`) |
| What breaks if I move or rename it? | `hono_impact(workspace="/abs/path", files=["src/routes/v1/contacts.ts"])`; `hono_dependencies(workspace="/abs/path", file="src/routes/v1/contacts.ts", direction="importers")` |

## Decision rules

### The composed path (hono 4.13.16: `dist/hono-base.js`, `dist/utils/url.js` `mergePath`)

Every `Hono` instance owns an ordered table (`app.routes`). A path is the `mergePath` of
every prefix between the table's owner and the entry.

| Construct | Effect on the table |
|---|---|
| `app.get('/x', h)` | one entry `GET /x` per method and path; `app.on(['GET','POST'], ['/a','/b'], h)` adds one per method and path |
| `app.use(mw)` / `app.use('/p/*', mw)` | an `ALL` entry; no path means `*` |
| `parent.route('/v1', child)` | copies the child's entries **as they are at that call** into the parent, at that position, path `/v1` + entry path |
| `app.basePath('/api')` | returns a new instance that **shares the same table** and prefixes what it adds |
| `app.mount('/p', fetch)` | one `ALL /p/*` entry (deprecated; `app.all('/p/*', mount(fetch))` from `hono/mount`) |

Probe on 4.13.16 (`new Hono().basePath('/cms')` child → `.route('/admin', child)` →
`.route('/v1', admin)`): the root table holds `GET /v1/admin/cms/pages/:id`. Prefixes and
base paths add up in order, so the answer to "what is the URL" is the sum of the mount chain,
which `hono_route` reports in `mountChain`.

### Why another tool shows `/:id`

A tool that indexes one file or one symbol (livespec stores `contactRoutes.get('/:id')`) sees
the **local** path the handler was registered with. The full path exists only when the file is
joined to every `route()` call above it, which is exactly the evaluation `hono_routes` performs.
Report and assert the `fullPath`; treat the local path as an implementation detail of the
sub-app. `hono_graph_export` writes both the full and the local path on every route node, so
the two can be linked.

### Registration order is behaviour

- ESM runs an imported module's top-level code before the importer's, depth-first in import
  order. A sub-app's `.get(...)` calls therefore run before the parent's `route()` call, unless
  the route is added later by code that runs after the mount.
- `route()` copies at call time. A route added to the child afterwards is **not served**
  through the parent (probe: `/p/late` → 404). That is R003; its mirror is R004, a Hono
  instance with routes that nobody mounts or serves.
- A request runs every matching entry in table order; the first entry that returns a response
  without calling `next()` ends it. For the same method and path the first wins (probe:
  two `app.get('/x')` → `first`): R001.
- `/users/:id` registered before `/users/me` answers `/users/me` with the param handler
  (probe); register the static route first (R002).
- The same sub-app mounted at two prefixes produces two copies of every route (R007).
- Once the first request has been matched the router is built: adding a route after that throws
  `Can not add a route since the matcher is already built.` (*probe*: `app.doc(...)` called after
  `app.request(...)`). Register everything at module load, never inside a handler.

### Path syntax

- `:id`, `:id?` (optional), `:id{[0-9]+}` (regex), `*` (wildcard). `strict` defaults to `true`:
  `/x` and `/x/` are different (probe: `/x/` → 404); `new Hono({ strict: false })` accepts both.
- A path that is not a literal (a variable, a template) cannot be resolved statically: R005.
  A missing leading slash, a double slash or a trailing-slash twin is R006.
- Methods on an instance: `get post put delete options patch query` (`query` since 4.13),
  `all`, `on`. `routePath(c)` and `baseRoutePath(c)` from `hono/route` return
  `/v1/things/:id` and `/v1/things` inside a handler: a quick check that a mount landed
  where you think.

### Chain when the client types matter

If anything calls `hc<AppType>()`, register routes in one chain
(`new Hono().get(...).post(...)`) so `typeof app` carries them. See `hono-rpc` (P001).

## Minimal change

1. `hono_route` or `hono_trace` the URL you will add or change. If it already resolves, you
   are about to duplicate or shadow it (R001, R002).
2. Add the route to the sub-app that already owns the prefix; copy the export shape and the
   `Hono<AppEnv>` generic of a sibling rather than writing one from memory.
3. If you add a new sub-app, mount it from the file that already holds the sibling mounts and
   place it where the middleware you need already applies (`hono-middleware`).
4. Add every route **before** the `route()` call that exposes the sub-app runs.
5. Validate: `hono_validate(workspace="/abs/path", categories=["routes"], files=[...])`, the
   project's own type check and tests, then `hono_trace` the new URL once more and compare
   `fullPath` and `steps[]`.

## Traps

| Trap | ID |
|---|---|
| Same method and full path registered twice in one table | R001 |
| Param or wildcard handler registered before a static sibling | R002 |
| Routes added to a sub-app after it was mounted | R003 |
| Hono instance with routes that is never mounted nor served | R004 |
| Route path built from a variable or template | R005 |
| Missing leading slash, `//`, trailing-slash duplicate | R006 |
| One sub-app mounted at two prefixes | R007 |
| Exported app type taken from a non-chained instance | P001 |
| A mounted route asserted by its local path (`/:id`) instead of `/v1/contacts/:id` | use `hono_route` |

## Precedence

The project's existing conventions outrank this skill; the user's request and safety
outrank both (`engineering-baseline`). If the repo names its route modules, mounts its
sub-apps or orders them in a way this skill would not, follow the repo, and when order is
deliberate (see `hono-middleware`, the google-calendar mount) leave it and say so.
