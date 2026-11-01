# hono-mounted: expected results

The fixture is a Hono 4 app with a mounted tree. Its proof case is the mount order in
`src/routes/v1/index.ts`: `/integrations/google-calendar` is mounted **before** `/integrations`,
and `/integrations` registers `use("*", authMiddleware, tenantMiddleware)`.

`route()` copies the child's table at call time (see `docs/adr/0002-simulate-hono-base-composition.md`),
so the google-calendar routes are copied ahead of that middleware.

## Routes

| method | full path                                   | auth step on the chain |
|--------|---------------------------------------------|------------------------|
| GET    | `/v1/integrations/google-calendar/callback` | none (public OAuth)    |
| POST   | `/v1/integrations/google-calendar/sync`     | none                   |
| GET    | `/v1/integrations/:provider`                | `authMiddleware`       |

`hono_routes` reports the composed path (`/v1/contacts/:id`), never the local one (`/:id`).

## Trace

`hono_trace GET /v1/integrations/google-calendar/callback` reports `authMiddleware` and
`tenantMiddleware` as `reached: false`. The same trace for `/v1/integrations/:provider` reports
none unreached.

## Checked by

- `mcp/tests/core/compose.test.ts` (proof case: mount order)
- `mcp/tests/core/oracle.test.ts` (the real Hono table agrees)
- `mcp/tests/core/trace.test.ts` (unreached steps)
- `evals/mounted-path` and `evals/middleware-order`
