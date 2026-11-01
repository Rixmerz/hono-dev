---
type: tool_order
before: hono_routes
after: Write
---
`hono_routes` must be called before the first `Write`: the route neighbourhood is
checked before any file is created.
