# 0002. Simulate hono-base composition instead of reading the source text

Status: accepted

## Context

The route table a Hono app serves is built at run time by `hono-base.js`, and the path a handler
answers on is not the path written beside it: `route()` mounts a child under a prefix, `basePath()`
prefixes an instance, and middleware applies by registration order. Reading `app.get("/:id", ...)`
in a sub-app file therefore gives the wrong answer for `/v1/contacts/:id`.

## Decision

`mcp/core/compose.ts` simulates the app. Every instance owns an ordered table, exactly like
`app.routes`:

- registrations append to the table; a method call with a path registers one entry per handler
  argument, not one per call (`inline + route-scope validators + handler`);
- `route(prefix, child)` copies the child's entries **as they are at call time**, so anything the
  child registers afterwards is never served by the parent;
- `basePath()` shares the parent's table;
- modules are evaluated in ESM import order.

The consequence is the proof case in `fixtures/hono-mounted`: a sub-app mounted before a broader
prefix is copied before that prefix's `use("*", auth)`, so it never reaches that middleware.

## Consequences

- `hono_routes`, `hono_trace` and the validators read the simulated table, so they report the full
  composed path and the steps that never run (`unreached`).
- A `RouteEntry` stands for several table entries; tests that compare against the real app use
  `expandedTable()` in `mcp/tests/_helpers.ts`.
- `mcp/tests/core/oracle.test.ts` runs the fixtures through the real `hono` and compares, so the
  simulation is checked against the framework, not against itself.
- When a new Hono release changes `hono-base.js`, the oracle test is where it shows.
