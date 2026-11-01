---
name: middleware-order
tags: [skill:hono-middleware, tool:hono_trace, read-only]
runs: 3
max_turns: 10
---
The working project is the Hono 4 app at `fixtures/hono-mounted` (relative to the
plugin root; use its absolute path as `workspace` for every hono tool).

The `/v1/integrations/google-calendar` sub-app is mounted before `/v1/integrations`,
whose sub-app calls `use('*', ...)` with an auth middleware. Pick one route under
`/v1/integrations/google-calendar` with the hono tools and tell me whether that auth
middleware runs for it. Explain why, in terms of how Hono orders middleware and mounts.
Do not edit any file.
