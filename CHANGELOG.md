# Changelog

## 0.1.0 — 2026-11-01

First release.

- Hono MCP server (`hono`, Node, stdio): detection of Hono 4.x on Node, Deno, Bun and
  Cloudflare Workers, incremental index, route table under the full composed path across
  `route()` and `basePath()` mounts, per-instance registration order, middleware chains with
  the steps that never run, validators per route and target, RPC types and `hc` uses, import
  graph with tsconfig paths and Deno import maps applied, request tracing, impact analysis,
  Graphify-compatible export for livespec.
- 12 tools; `workspace` required on every call. Read-only, except `hono_reindex` (state
  directory only) and `hono_graph_export` (the graph file only).
- Validator catalogue of 36 rules: R001–R007, M001–M007, V001–V005, S001–S007, A001–A004,
  P001–P002, C001–C004, with a headless CLI (`bin/hono-mcp`, 13 commands) and CI exit codes
  0/1/2/3.
- 8 knowledge skills, the `/hono-dev:init` user command, shared references.
- Hooks: detect (SessionStart/CwdChanged/DirectoryAdded), invalidate (PostToolUse/FileChanged,
  plus an `mcp_tool` reindex), validate (PostToolUse feedback). All fail open; kill switch
  `HONO_DEV_HOOKS=off`.
- vise recipes and `integrations/` config snippets; livespec `.livespec.toml` snippet; evals.
- Safety: nothing is written inside an analysed project except the explicit graph export. The
  index cache, the dirty marker and the hook log live in the plugin's own state directory
  (`HONO_DEV_STATE_DIR`, else `CLAUDE_PLUGIN_DATA/state`, else `~/.cache/hono-dev`).
- TypeScript is pinned to 6.0.3 (7.x ships no JavaScript compiler API) and bundled inside
  `dist/`; it is never resolved from the analysed project, so a Deno project with an `npm:`
  import map and no `node_modules` is analysed the same way.
- Fixtures: `hono-node`, `hono-deno`, `hono-workers`, `hono-mounted`, `not-hono`. All are
  minimal and purpose-built: this is a tool for Hono as a framework, so it ships no
  application templates.
