---
name: add-route
tags: [skill:hono-routing, tool:hono_routes, tool:hono_trace, write]
runs: 3
max_turns: 18
---
The working project is the Hono 4 app at `fixtures/hono-mounted` (relative to the
plugin root; use its absolute path as `workspace` for every hono tool).

Add a `GET /v1/contacts/export` endpoint that returns `{ "ok": true }`. Put it in a new
module file (do not append to an existing route file) and mount it so that the full path
is exactly `/v1/contacts/export`. Before creating or editing any file, make sure no
existing route already serves or shadows that path. Finish with one line that says which
file you created and which full path it serves.
