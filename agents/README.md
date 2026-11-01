# agents/

This directory is intentionally empty.

hono-dev ships no agents. It answers Hono questions through the `hono` MCP tools and
teaches how to reason about routing, middleware order, validation, RPC clients, testing,
deployment and MCP servers through its knowledge skills. Orchestration belongs to vise,
whose fleet (`vise:backend-typescript`) already covers a Hono codebase; a second agent
would only duplicate it. The vise backend agents load the `hono-dev:*` skills on request.

How a vise orchestrator briefs `vise:backend-typescript` for Hono work:

1. Name the skills explicitly; subagents do not load plugin skills on their own:
   "Load the hono-dev:hono-routing skill before your first edit" (likewise
   `hono-dev:hono-development`, `hono-middleware`, `hono-validation`, `hono-rpc`,
   `hono-testing`, `hono-deploy`, `hono-mcp-server`).
2. Pass the workspace: every hono tool needs `workspace=<absolute project root>`.
3. Paste facts, not prose: `hono_routes` / `hono_route` / `hono_impact` output for the
   files in scope, as `path:line`, so the subagent starts from the graph. Quote the
   full composed path (`/v1/contacts/:id`), never the local one (`/:id`).
4. State the validation to run before reporting: `hono_validate` (matching categories),
   plus the project's own type check (`npx tsc --noEmit` or `deno check`) and lint. The
   recipes under `recipes/` list the same consultations.
