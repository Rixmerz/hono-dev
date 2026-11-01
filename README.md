# hono-dev

**Hono** 4.x specialist plugin for Claude Code. It knows Hono — the route table each
instance owns, the full path a handler is served under once `route()` and `basePath()`
have composed it, the middleware that wraps it and in what order, validators, the RPC
client type, how to test and deploy it — and hands that knowledge to the agents that do
the work.

```
Claude Code
    │
 hono-dev ── skills (how to reason about Hono)
    │      ── hono MCP (read-only semantic analysis, 12 tools)
    │      ── validators (36 rules, also a headless CLI for CI / vise gates)
    │      ── hooks (detect the project, keep the index fresh, feedback after edits)
    ▼
 Hono project ──► livespec (symbol graph) via .hono-dev/graph.json, when you export it
```

Principle: **hono-dev knows Hono; [vise](https://github.com/Rixmerz/vise) knows how to
orchestrate agents; [livespec](https://github.com/Rixmerz/livespec) knows the whole
system.** hono-dev ships no agents of its own (see [`agents/README.md`](agents/README.md)):
vise's `backend-typescript` agent loads the `hono-dev:*` skills when the orchestrator names
them in a brief.

Analyses **Hono 4.x** projects that run on Node, Deno, Bun or Cloudflare Workers. The
headline fact it gets right where a single-file reader cannot: a route mounted as
`app.route("/v1", v1)` and `v1.route("/contacts", contacts)` is `GET /v1/contacts/:id`, not
the local `/:id` its handler was registered with.

## Install

Requirements: Claude Code and **Node 24 or newer on PATH**. Nothing is installed in the
project you analyse: no dependency, no `node_modules`, no config. The plugin parses with its
own bundled TypeScript (see [Bundled TypeScript](#bundled-typescript)), so a Deno project with
an `npm:` import map and no `node_modules` works the same as an npm one.

hono-dev is not in the published `rixmerz` marketplace yet. Install it from a clone:

```sh
git clone https://github.com/Rixmerz/hono-dev && cd hono-dev
claude plugin marketplace add ./          # registers the local "hono-dev-local" marketplace
claude plugin install hono-dev@hono-dev-local
```

The marketplace file deliberately does not claim the `rixmerz` name: Claude Code keys
marketplaces by name, and a clone declaring it would displace the published plugins.
Restart Claude Code after installing, then run `/hono-dev:init` in a Hono project.

## What you get

### MCP server `hono` (12 tools)

Every tool takes `workspace` — the absolute project root — on every call (no cwd fallback,
same convention as livespec). A monorepo is analysed one package at a time: pass the package
that holds the app. Output is one JSON text; a failure is `{ ok: false, error, hint }`. The
names below are the tool suffixes; the prefix your tool list shows depends on how the plugin
was mounted.

| Tool | Arguments (besides `workspace`) | Answers |
|---|---|---|
| `hono_project` | — | Is this Hono? Hono version, runtime, deploy targets, entry file, apps, workspace members, counts, index status. The only tool that also answers on a non-Hono workspace |
| `hono_routes` | `prefix?`, `file?`, `app?`, `include_middleware?`, `limit?`, `offset?` | The route table under full composed paths, with methods, files and optionally the middleware chain |
| `hono_route` | `method`, `path` | One route by its full path: where it is registered, the chain of middleware and validators, the steps that never run (`unreached`), the handler |
| `hono_middleware` | `method?`, `path?` | The middleware that applies to a method and path, in execution order |
| `hono_validators` | `prefix?`, `missing_only?` | Validators per route and target; `missing_only` lists the routes that have none |
| `hono_rpc` | — | Exported app types, `hc` client uses, and whether the type carries every route |
| `hono_trace` | `path`, `method?` (default `GET`) | What a request to a URL goes through, step by step, or why it ends in a 404 |
| `hono_dependencies` | `file`, `direction` (`imports` or `importers`), `depth?` | The import graph around a file, tsconfig paths and Deno import map applied |
| `hono_impact` | `files?` or `base?`, `head?`, `depth?` | Routes, apps and modules affected by changed files or a git range, plus the checks to run |
| `hono_validate` | `categories?`, `files?`, `fast?` | The rule catalogue over the project: `ok`, findings, and `unverified` for what could not be checked |
| `hono_graph_export` | `path?` | Writes a Graphify node-link `graph.json` for livespec's external-graph ingest |
| `hono_reindex` | `force?` | Rebuilds the incremental index |

All tools are read-only except two: `hono_reindex` writes the state directory only, and
`hono_graph_export` writes the graph file only (see [What is written, and where](#what-is-written-and-where)).

### Skills

Knowledge skills, loaded by path or by description: `hono-development` (the working loop),
`hono-routing`, `hono-middleware`, `hono-validation`, `hono-rpc`, `hono-testing`,
`hono-deploy` and `hono-mcp-server` (building an MCP server on Hono). Shared references
live in `skills/_shared/references/`.

User command: `/hono-dev:init` detects the project, runs `hono_project`, and prints the
livespec, gitignore and (when `.vise/` exists) vise snippets for you to add. It never writes
into the project.

### Validators

36 rules in seven categories, each reporting `error`, `warning` or `info` with the file and
line, and a fix hint. `ok` means no error-severity finding.

| Category | Rules | Catches, for example |
|---|---|---|
| `routes` | R001–R007 | the same method and path registered twice; a param route shadowing a static sibling; a route added to a sub-app after `route()` mounted it |
| `middleware` | M001–M007 | `use()` registered after the routes or mounts it should cover; a middleware that never calls `next()`; `cors()` after auth |
| `validation` | V001–V005 | POST/PUT/PATCH reading the body with no validator; `c.req.valid()` for a target nothing validates |
| `security` | S001–S007 | CORS `*` with credentials; a route left public on a guarded mount; secret env keys read without validation; literal secrets in auth options |
| `architecture` | A001–A004 | a handler using the DB client instead of a service; no `onError` on the root app; import cycles between route modules |
| `rpc` | P001–P002 | an exported app type from a non-chained instance; `hc<T>()` where `T` is not an app type |
| `conventions` | C001–C004 | `process.env` on Workers, `Deno.env` on Node; two Hono copies; deprecated APIs; route modules no test mentions |

Of the 36, 8 are errors, 21 warnings and 7 info. Two are slow, A004 and C004, and are
skipped when `fast` is set. The full list, with
severity, what each rule detects and the fix, is in
[`skills/_shared/references/rules.md`](skills/_shared/references/rules.md).

### Headless CLI

`bin/hono-mcp <command> <workspace> [--json] [flags]` answers the same questions as the tools
(both call the same functions), for CI and for vise quality gates. The workspace is required;
a relative one such as `.` is resolved against the current directory. Commands: `project`, `routes`, `route`, `middleware`,
`validators`, `rpc`, `trace`, `deps`, `impact`, `validate`, `export`, `reindex`, `rules`.
Each maps to the tool of the same subject (`deps` is `hono_dependencies`); `rules` prints the
rule catalogue and has no tool. Flags carry the tool's arguments.

```sh
bin/hono-mcp validate /abs/project --json     # CI gate
bin/hono-mcp routes /abs/project --json
bin/hono-mcp export /abs/project              # → /abs/project/.hono-dev/graph.json
bin/hono-mcp rules
```

| Exit code | Meaning |
|---|---|
| `0` | ok (for `validate`: no error-severity finding) |
| `1` | `validate` found error-severity findings |
| `2` | not a Hono project, or an invalid or missing workspace |
| `3` | a route or file that does not exist, bad arguments, an unknown command, an internal error |

### Hooks

| Event | Does |
|---|---|
| `SessionStart`, `CwdChanged`, `DirectoryAdded` | **detect**: says once that this is a Hono project and how to work in it; silent otherwise |
| `PostToolUse` Edit, Write, MultiEdit | **invalidate** marks the index dirty; an `mcp_tool` hook then calls the reindex tool on the plugin's own `hono` server for the session's working directory; **validate** runs the fast rules on the edited file and hands the findings back |
| `PostToolUse` Bash | **invalidate** `--from-bash` marks the index dirty after a shell command that could have changed the tree |
| `FileChanged` on the project manifests | **invalidate** |

The command hooks run `bin/hono-dev-run hook <detect|invalidate|validate>`; the exact
matchers are in `hooks/hooks.json`. All hooks fail open: they always exit 0 and never block
an edit. What they log goes to `warnings.jsonl` in the state directory, never into the
project. Kill switch: `HONO_DEV_HOOKS=off` (`0` and `false` work too).

### With vise

`integrations/vise/capabilities.yaml` binds each tool of the `hono` server to an `x.hono.*`
capability, and the five recipes in `recipes/` (`hono-route`, `hono-feature`,
`hono-middleware`, `hono-debug`, `hono-refactor`) are read-only consultation plans over them.
`integrations/vise/quality.hono.yaml` adds a `hono` check
(`bin/hono-mcp validate . --json`) so a workflow node can gate on it. `/hono-dev:init` prints
these for you to copy; nothing is installed on its own. How an orchestrator briefs
`vise:backend-typescript` for Hono work is in [`agents/README.md`](agents/README.md).

### With livespec

```toml
# <project>/.livespec.toml, after: bin/hono-mcp export /abs/project
[graph]
external = ".hono-dev/graph.json"
auto_ingest = true
```

livespec keeps the path a mounted route was registered with (`/:id`); the exported graph adds
the composed path as a node attribute and in the node label (`GET /v1/contacts/:id`). Route
tables, validators and middleware order stay in hono-dev, which livespec has no model for.

### Evals

`claude plugin eval .` runs the five behavioural cases in `evals/` (session detection,
adding a route, mounted paths, middleware order, validating a project) against the fixtures.
See [`evals/README.md`](evals/README.md); they consume tokens, so run them on demand.

## What is written, and where

**Inside the project you analyse, hono-dev writes nothing.** The one exception is the
explicit graph export (`hono_graph_export`, or `bin/hono-mcp export`): it writes
`.hono-dev/graph.json`, or the path you give, and only when you ask for it. Add `.hono-dev/`
to `.gitignore` unless your team versions the graph (`/hono-dev:init` prints the lines).

Everything else — the parse cache, the dirty marker, the hook log — lives in the plugin's own
state directory, one subdirectory per project. The first rule that applies wins:

| # | State root |
|---|---|
| 1 | `$HONO_DEV_STATE_DIR/<key>` |
| 2 | `$CLAUDE_PLUGIN_DATA/state/<key>` |
| 3 | `${XDG_CACHE_HOME:-~/.cache}/hono-dev/<key>` |

`<key>` is the first 16 hex characters of the sha256 of the project's real path. Installed as
a plugin, `.mcp.json` sets `HONO_DEV_STATE_DIR` to `${CLAUDE_PLUGIN_DATA}/state`, and hooks and
the CLI started by Claude Code have `CLAUDE_PLUGIN_DATA` set, so rule 2 gives all three the
same directory; a CLI run by hand outside Claude Code falls to rule 3. The directory holds `facts-cache.json` (parsed
modules), `dirty.json` (what the hooks marked stale) and `warnings.jsonl` (hook audit). It is
safe to delete; the next call rebuilds it.

`<project>/.hono-dev/config.json` is an optional file hono-dev reads and never writes. Keys,
all optional: `ignore`, `maxFileBytes`, `entry`, `dbSpecifiers`, `authMiddleware`,
`serviceDirs` (default `src/services`, `services`, `src/lib`; files there are the service
layer and are exempt from rule A001) and `envValidationModules`. The gitignore snippet ignores
`.hono-dev/*` but keeps `config.json` versioned.

## Bundled TypeScript

hono-dev reads code through the TypeScript compiler API. `typescript` is pinned to exactly
**6.0.3** because TypeScript 7.x ships no JavaScript compiler API. The plugin bundles its own
copy in `dist/` and **never resolves TypeScript from the analysed project**: the real target
may be a Deno project with an `npm:` import map and no `node_modules`, and a project's own
TypeScript may be any major. Do not unpin it without checking the replacement exposes the API
the parser uses.

## Layout

```
.claude-plugin/   plugin.json, marketplace.json (local dev marketplace)
.mcp.json         the hono server: bin/hono-dev-run mcp
bin/              hono-dev-run (launcher: mcp, cli, hook), hono-mcp (CLI)
dist/             committed bundles that the launcher runs (TypeScript 6.0.3 inside)
mcp/              the server: core/ (detect, parse, compose, resolve, trace, impact, export, index, state), validators/, tools/, tests/
skills/           8 knowledge skills + init + _shared/references
hooks/            hooks.json + the hook scripts
scripts/          build.ts (esbuild bundle)
recipes/ integrations/ evals/ agents/README.md
fixtures/         hono-node, hono-deno, hono-workers, hono-mounted, not-hono
```

## Development

```sh
npm ci
npm run check        # biome, tsc --noEmit, vitest
npm run dev:mcp      # node mcp/entry.ts mcp --stdio (Node 24 strips the types)
npm run cli -- validate fixtures/hono-mounted
npm run build        # rebuilds dist/; the plugin runs from a checkout with no npm install
claude plugin validate .
npx @modelcontextprotocol/inspector node mcp/entry.ts mcp --stdio
```

Rebuild `dist/` and commit it whenever `mcp/` or `hooks/` changes.

## License

MIT
