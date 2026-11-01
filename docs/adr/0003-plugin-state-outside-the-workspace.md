# 0003. Plugin state lives outside the analysed workspace

Status: accepted

## Context

hono-dev analyses projects it does not own. Writing an index cache, a dirty marker or a log into
the project would dirty its working tree, show up in its `git status` and break read-only mounts.

## Decision

All plugin state is kept in a per-workspace directory returned by `stateDir()` in
`mcp/core/state.ts`, keyed by the first 16 hex characters of `sha256(realpath(workspace))`. The
first of these wins:

1. `$HONO_DEV_STATE_DIR`
2. `${CLAUDE_PLUGIN_DATA}/state`
3. `${XDG_CACHE_HOME:-~/.cache}/hono-dev`

The directory holds the facts cache, `dirty.json` (the marker the hooks write and the index
consumes) and `warnings.jsonl`.

The only writes into a workspace are the ones the user asks for: `hono_graph_export` writes the
graph file (`.hono-dev/graph.json` by default), and `/hono-dev:init` prints snippets without
writing anything.

## Consequences

- Analysis tools are read-only with respect to the project. `hono_reindex` writes only the state
  directory.
- Two checkouts of the same project share nothing unless they resolve to the same real path.
- The marker file is the only channel between hooks and the server, so hooks that fail open still
  leave the index correct: a missing or corrupt marker means nothing is known to be dirty.
