# The 12 tools of the `hono` MCP server

Every tool takes `workspace`: the absolute path of the project root (the directory holding
`package.json` or `deno.json`). A relative path, a missing directory or `/` is refused with
`{ ok: false, error, hint }`. Every tool except `hono_project` also refuses a workspace that
is not a Hono project, with the detection `evidence` in the answer. The reply is one JSON text;
`isError` is set when `ok` is `false` because the call failed. `hono_validate` is the exception
that proves the rule: a project with error-severity findings is a normal answer with
`ok: false` inside it, not a failed call.

The same functions back `bin/hono-mcp <command> <workspace> --json`; the second column names
the command and its flags.

| Tool (CLI command) | Arguments besides `workspace` | Answer fields worth reading |
|---|---|---|
| `hono_project` (`project`) | none | `isHono`, `honoVersion` (`declared`, `resolved`, `major`, `supported`), `runtime`, `deployTargets`, `entry`, `apps[]`, `workspaceMembers`, `counts`, `index`, `skipped[]` |
| `hono_routes` (`routes`) | `prefix`, `file`, `app` (`file#local`), `include_middleware`, `limit` (default 100, max 1000), `offset` | `routes[]` with `method`, `fullPath`, `localPath`, `file`, `line`, `app`, `reachable`, `validators[]`, `handler`; with `include_middleware` also `chain[]`, `unreached[]`; `total`, `truncated`, `next_offset` |
| `hono_route` (`route --method --path`) | `method`, `path` (full composed path) | the whole route entry: `mountChain[]`, `chain[]`, `unreached[]`, `inline[]`, `validators[]`, `handler`, `errorHandler`; `alsoRegistered[]`, `tests[]`. A miss lists `registeredMethods` and `didYouMean` |
| `hono_middleware` (`middleware`) | `method` (default `GET`), `path` | `middleware[]` in execution order; with `path` each has `reached`; without it, every registration with `registeredAfterRoutes` |
| `hono_validators` (`validators`) | `prefix`, `missing_only` | `routes[]` with `validators[]` (`target`, `library`, `schema`, `scope`) and `readsBody` |
| `hono_rpc` (`rpc`) | none | `appTypes[]` with `chained`, `carriesEveryRoute`; `clients[]` with `typeArg`, `appType` |
| `hono_trace` (`trace --path`) | `path`, `method` (default `GET`) | `steps[]` (`kind`, `reached`, `params`), `handler`, `params`, `errorHandler`, `allowedMethods`, `notFound`, `reason` |
| `hono_dependencies` (`deps --file`) | `file`, `direction` (`imports` or `importers`; CLI flag `--importers`), `depth` (1 to 10) | `files[]` with `distance` and `via`; `external[]`; `unresolved[]` |
| `hono_impact` (`impact`) | `files[]`, or `base` with optional `head`; `depth` | `routes[]` with `why[]`, `middlewares[]`, `apps[]`, `rpcTypes[]`, `tests[]`, `suggestedChecks[]` |
| `hono_validate` (`validate`) | `categories[]`, `files[]`, `fast` | `ok`, `findings[]` (`id`, `severity`, `file`, `line`, `message`, `hint`), `summary` (`errors`, `warnings`, `info`, `unverified[]`) |
| `hono_graph_export` (`export`) | `path` (inside the workspace; default `.hono-dev/graph.json`) | `path`, `nodes`, `links`, `byRelation`, `livespecSnippet`. The CLI also accepts a path outside the workspace, because the person typing it chose it |
| `hono_reindex` (`reindex`) | `force` | `files`, `parsed`, `reused`, `removed`, `ms`, `skipped[]` |

`rules` (CLI only) prints the 36-rule catalogue.

## Reading an answer

- A route is always reported under `fullPath`. `localPath` is where its handler was
  registered, kept for navigation.
- `unreached[]` and `reached: false` mean a step sits after an entry that ends the request:
  the code exists and never runs for that URL.
- `summary.unverified[]` lists what the validator could not check (a file that did not
  parse, a rule that threw). Absence of a finding is only a pass when this list is empty.
- `skipped[]` on `hono_project` and `hono_reindex` lists files the index left out and why
  (too large, unreadable, syntax error).

## CLI exit codes

| Code | Meaning |
|---|---|
| `0` | ok (for `validate`: no error-severity finding) |
| `1` | `validate` found error-severity findings |
| `2` | not a Hono project, or a missing or invalid workspace |
| `3` | a route or file that does not exist, bad arguments, unknown command, internal error |
