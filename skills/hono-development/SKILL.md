---
name: hono-development
description: >-
  The working loop for any change in a Hono 4.x project (Node, Deno, Bun or Cloudflare
  Workers): detect the project, find the route by its full composed path, see which
  middleware and validators guard it, check the RPC type and the tests, make the minimal
  change, validate. Load it before the first edit to an app, routes, middleware or
  validator file, whenever a task mentions Hono, app.route, c.req.valid, hc, AppType,
  wrangler or one of the hono MCP tools, and when writing a brief for a vise subagent that will touch a
  Hono repo. It also settles what the LSP, the hono MCP tools and the project's own type
  check and tests each answer. Call hono_project first, then hono_route or hono_trace, and
  hono_validate after the edit.
user-invocable: false
paths: "src/**,deno.json,deno.jsonc,package.json,wrangler.toml,wrangler.json,wrangler.jsonc"
---

# hono-development — the loop

The `hono` MCP answers questions about a Hono project; it never edits it. Every tool is a
read-only query (only `hono_graph_export` writes, and only under
`<workspace>/.hono-dev/graph.json` or the path you give it). Claude Code, or a vise agent, makes
the change with Edit/Write; this skill says what to ask before and what to run after.

References: `../_shared/references/tools.md` (all 12 tools, arguments),
`../_shared/references/versions.md` (4.x minors, runtimes, Deno to Node),
`../_shared/references/rules.md` (validator catalogue),
`references/sources.md` (what was checked against hono 4.13.16, and how).

## `workspace` is required on every call

`workspace` is the absolute path of the Hono project root: the directory that holds
`package.json` or `deno.json`. There is no cwd or environment fallback (same contract as
livespec).

- The SessionStart hook prints it when it detects Hono; otherwise run `pwd`.
- A monorepo: pass the package that holds the app, not the repo root
  (`hono_project` lists `workspaceMembers`).
- A non-Hono workspace answers every tool except `hono_project` with `ok: false` and the
  detection evidence; read it rather than retrying.
- The same questions are available in CI as `hono-mcp <command> /abs/path --json`
  (`project`, `routes`, `route`, `middleware`, `validators`, `rpc`, `trace`, `deps`, `impact`,
  `validate`, `export`, `reindex`, `rules`).

## Before touching anything: the loop

Run it in order. Each step names the call; skip a step only when an earlier answer
already covered it.

| # | Question | Call |
|---|---|---|
| 0 | Which Hono, which runtime, where is the entry? | `hono_project(workspace="/abs/path")` — `honoVersion`, `runtime`, `deployTargets`, `entry` |
| 1 | Which route owns the behaviour, under its full path? | `hono_route(workspace="/abs/path", method="GET", path="/v1/contacts/:id")`; for a URL, `hono_trace(workspace="/abs/path", path="/v1/contacts/42", method="GET")`; for a neighbourhood, `hono_routes(workspace="/abs/path", prefix="/v1/contacts")` |
| 2 | Which middleware guards it, in what order, and is any of it unreached? | `hono_middleware(workspace="/abs/path", method="GET", path="/v1/contacts/42")`; `chain[]` and `unreached[]` of `hono_route` |
| 3 | Which validators does it have, and which routes have none? | `hono_validators(workspace="/abs/path", prefix="/v1/contacts")`, `hono_validators(workspace="/abs/path", missing_only=true)` |
| 4 | What does the file I will touch drag in, and who imports it? | `hono_dependencies(workspace="/abs/path", file="src/routes/v1/contacts.ts", direction="importers")` |
| 5 | Does the client type depend on it? | `hono_rpc(workspace="/abs/path")` |
| 6 | Does what I am about to write already exist? | `hono_routes(workspace="/abs/path", file="src/routes/v1/contacts.ts")`, the module's export list, livespec `search_similar` when mounted |
| 7 | Make the minimal change | one file where possible; keep the route, validator and middleware shape the file already uses |
| 8 | Validate | `hono_validate(workspace="/abs/path", files=[...])`, then the project's type check, then its tests |

Before a multi-file change or a brief, add `hono_impact(workspace="/abs/path",
files=[...])` (or `base="main"`) and run its `suggestedChecks`. After the edit,
`hono_reindex(workspace="/abs/path")` if the index was not refreshed (the PostToolUse hook
does it for TypeScript files, `package.json`, `deno.json` and `wrangler.*`).

## Who answers what

| Need | Use | Not |
|---|---|---|
| a symbol's definition, references, implementations, a file outline, an inferred type | the `LSP` tool (TypeScript language server; `deno lsp` for Deno projects) | grep |
| the **full** path of a route, which mounts it passed, which middleware wraps it, which validators guard it, whether a middleware is unreached | the hono MCP tools | the LSP (no notion of tables or mounts) |
| type errors | `tsc --noEmit` (Node/Bun/Workers) or `deno check`, with the project's own flags | the `LSP` tool, which exposes navigation, not diagnostics |
| tests | the project's runner (`vitest run`, `deno test`) | `hono_validate` |
| call graph by symbol, dead code, Specs | livespec | the hono MCP tools (file and route level only) |

`hono_validate` is a structural check over the composed table; it does not replace the type
checker or the tests. `fast=true` skips the slow rules (A004 import cycles, C004 untested
route modules); a file listed in `summary.unverified[]` was not checked.

## Why a route can look different in two tools

livespec indexes symbols and stores a mounted route under the path its handler was registered
with, `/:id`. This plugin evaluates the `route()` and `basePath()` calls and reports the
composed path, `/v1/contacts/:id`. Both are right about their own question. Use
`hono_routes` and `hono_route` for any statement about a URL, and `hono_graph_export` to give
livespec the full path as a node attribute. See `hono-routing`.

## Hono at a glance, one line each

- Each `Hono` instance owns an ordered table. A request runs every matching entry in order;
  the first that responds without `next()` ends it (`hono-middleware`).
- `parent.route(prefix, child)` copies the child's entries **as they are at that call**
  (`hono-routing`). `basePath()` shares the table.
- Validators are middleware; read their result with `c.req.valid(target)` (`hono-validation`).
- The RPC client is typed by `typeof app`, which only carries chained routes (`hono-rpc`).
- Test with `app.request()` or `testClient`, importing the app, not the listener
  (`hono-testing`).
- Runtime layer: `serve(...)` from `@hono/node-server`, `Deno.serve(app.fetch)`,
  `export default app` for Bun and Workers (`versions.md`).

## Minimal change and validation

1. Prefer editing the file the loop pointed at over adding one; prefer a new route on an
   existing sub-app over a new sub-app.
2. Keep the route, handler and validator shape the file already uses; the repo's convention
   wins.
3. Validate in this order and paste the real output in the report:
   - `hono_validate(workspace="/abs/path", files=["src/routes/v1/contacts.ts"])` — `ok: true`
     means no `error`; a rule in `summary.unverified[]` did not run.
   - the project's type check (`tsc --noEmit`, `deno check`).
   - the project's tests; read the test **count**, not only the colour.
   - `hono_trace` on the URL you changed and compare `steps[]`.

## Traps that cross every skill

| Trap | Caught by |
|---|---|
| asserting or logging a mounted route by its local path (`/:id`) | `hono_route` returns `fullPath` |
| route added to a sub-app after `route()` mounted it: never served | R003 |
| `use()` after the routes or mounts it should cover | M001, M002 |
| more specific mount registered before the parent that carries auth | `unreached[]`, `reached:false` |
| `cors()` after auth: browser preflight answered 401 | M007 |
| POST/PUT/PATCH reading the body with no validator | V001 |
| exported app type from a non-chained instance | P001 |
| DB client used in a route handler instead of a service | A001 |
| import cycle between route modules | A004 |
| `process.env` on Workers, `Deno.env` on Node, `c.env` on Node | C001 |
| two Hono copies (`npm:hono` and `jsr:@hono/hono`) | C002 |
| a deprecated Hono API (`app.mount`, the `c.req.routePath` getter, ...) | C003 |
| secrets read from env without validation | S003 |

## Briefing a vise subagent

vise's `backend-typescript` agent preloads `engineering-baseline`, its `*-rules` skill and
`ponytail`; it does **not** load plugin skills on its own. The orchestrator's brief must
therefore:

1. Name the skill as the first instruction:
   `Load the hono-dev:hono-routing skill before your first edit` (or `hono-dev:hono-middleware`,
   `hono-dev:hono-validation`, `hono-dev:hono-rpc`, `hono-dev:hono-testing`;
   `hono-dev:hono-development` when the task spans several).
2. Give `workspace=/abs/path` verbatim.
3. Paste facts, not prose: the `hono_route` chain and the `hono_impact` list as `path:line`
   items, e.g. `src/app.ts:307 mounts google-calendar before integrations; the auth step is in
   unreached[] for GET /v1/integrations/google-calendar/events`,
   `src/routes/v1/contacts.ts:41 POST /v1/contacts/import has no json validator (V001)`.
4. State the validation the agent must run and report verbatim: `hono_validate`, the type
   check, the tests.

A brief that only says "it is a Hono project" leaves the agent guessing the mount prefix and
reading local paths; these four lines are what make it a Hono agent.

## Neighbours

- livespec: symbols and call graph. `hono_graph_export` writes `.hono-dev/graph.json`
  (Graphify node-link format) for livespec's external-graph ingest; `/hono-dev:init` points at the
  livespec snippet to add. Route attributes, validators and middleware order stay in the hono MCP tools.
- All other state (index cache, dirty marker, hook warnings) lives outside the workspace; the
  only file this plugin may write inside it is the exported graph, so add `.hono-dev/` to
  `.gitignore` unless the team versions `graph.json`.

## Precedence

The project's existing conventions outrank this skill (rung 3 of `engineering-baseline`,
above any `*-rules` skill and `ponytail`); the user's explicit request and safety outrank
both. When a repo's folder layout, mount order or naming disagrees with this skill, the
repo wins, and a deliberate ordering (a public route mounted before a guarded parent) is
reported, not "fixed".
