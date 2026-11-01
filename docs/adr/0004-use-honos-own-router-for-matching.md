# 0004. Match requests with Hono's own router

Status: accepted

## Context

Which handler and middleware answer a request depends on Hono's routing rules: parameter
constraints, wildcards, optional segments and the order of the table. Reimplementing them would
drift from the framework with every release.

## Decision

`mcp/core/match.ts` loads the table into the same router a default `new Hono()` builds,
`SmartRouter([RegExpRouter, TrieRouter])`, imported from `hono/router/*`. The payload stored per
entry is its position in the table, so a match maps straight back to the entry.

`hono` is pinned in `package.json` (4.13.16) and is a runtime dependency of the bundle in
`dist/entry.cjs`.

## Consequences

- Matching, parameter extraction and wildcard rules are the framework's own, not a copy.
- `RegExpRouter` returns name-to-index results while `TrieRouter` returns values; `TableMatcher`
  normalises both.
- Bumping the pinned `hono` version changes matching behaviour; the oracle test
  (`mcp/tests/core/oracle.test.ts`) and the trace tests are the check.
