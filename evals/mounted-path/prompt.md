---
name: mounted-path
tags: [skill:hono-routing, tool:hono_routes, read-only]
runs: 3
max_turns: 8
---
The working project is the Hono 4 app at `fixtures/hono-mounted` (relative to the
plugin root; use its absolute path as `workspace` for every hono tool).

The contacts sub-app declares a handler for `/:id`. What is the full path a client has
to request to reach it, and which other contacts route sits next to it that accepts
POST? Use the hono tools, report the full composed paths, and do not edit any file.
