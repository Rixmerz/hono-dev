---
name: hono-mcp-server
description: >-
  Build a Streamable HTTP MCP server on Hono 4.x per MCP spec revision 2026-07-28: the
  single POST endpoint (no sessions, no GET stream, no DELETE), the MCP-Protocol-Version,
  Mcp-Method and Mcp-Name headers, Origin and Host validation, server/discover, and OAuth
  bearer authorization with Protected Resource Metadata at
  /.well-known/oauth-protected-resource. Says which SDK can serve 2026-07-28
  (@modelcontextprotocol/server 2.x with @modelcontextprotocol/hono, not sdk 1.x or
  @hono/mcp) and ships a tested implementation. Use when adding an MCP endpoint to a Hono
  app, migrating a 2025-era MCP server, or reviewing one for spec compliance.
user-invocable: false
paths: "**/mcp.ts,**/mcp/**,**/mcp-server.ts"
---

# hono-mcp-server

An MCP server over HTTP is one Hono route plus a handful of guards. The work is knowing
what the 2026-07-28 revision removed, so you do not rebuild it from a 2025 tutorial.

References: `references/spec-2026-07-28.md` (the requirements, each with its spec URL),
`references/server.md` (the tested implementation and its test), `../hono-deploy/SKILL.md`
(Fly.io and Workers).

Written from the spec text, fetched 2026-11-01: <https://modelcontextprotocol.io/specification/2026-07-28>
and its changelog <https://modelcontextprotocol.io/specification/2026-07-28/changelog>.

## Pick the SDK first

| Package (npm view, 2026-11-01) | Speaks | Use for |
|---|---|---|
| `@modelcontextprotocol/server` 2.4.0 + `@modelcontextprotocol/hono` 2.0.2 | 2026-07-28 and, by default, 2025 clients statelessly | a server that must follow this skill |
| `@modelcontextprotocol/sdk` 1.32.2 | up to 2025-11-25 (`LATEST_PROTOCOL_VERSION = '2025-11-25'` in its published `types.js`) | a 2025-era server; cannot serve 2026-07-28 |
| `@hono/mcp` 0.3.5 | 2025 (peer `@modelcontextprotocol/sdk ^1.29`; its dist imports `sdk/types.js` and mints `mcp-session-id`) | not for 2026-07-28 |

hono-dev's own stdio server stays on `@modelcontextprotocol/sdk` 1.32.2; stdio is not
affected by the HTTP changes below, and nothing here asks you to move it.

## What 2026-07-28 changed for a server author

| Gone or new | Rule | Spec |
|---|---|---|
| Sessions and `Mcp-Session-Id` removed | do not mint, require or echo a session id; ignore one that arrives | changelog major 1; streamable-http "Earlier Streamable HTTP Revisions" |
| `initialize` handshake removed | every request carries `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities` in `_meta` | changelog major 2 |
| `server/discover` | MUST implement | changelog major 3; `server/discover.md` |
| GET stream and `resources/subscribe` | replaced by `subscriptions/listen`, a long-lived POST response stream | changelog major 4 |
| SSE resumability | `Last-Event-ID` ignored; a broken stream loses the request | changelog major 9 |
| Server-initiated requests | replaced by `InputRequiredResult` (MRTR); every result carries `resultType` | changelog major 7, 8 |
| Request headers | `MCP-Protocol-Version` on every POST, `Mcp-Method` on all requests, `Mcp-Name` for `tools/call`, `resources/read`, `prompts/get`; mismatch with the body is 400 + `-32020` | streamable-http "Request Metadata" |
| Version errors | unsupported version is 400 + `-32022` with `data.supported` | `basic/versioning.md` |
| Cache hints | `ttlMs` and `cacheScope` required on list and read results | changelog minor 5 |
| Deprecated | HTTP+SSE transport; Roots, Sampling, Logging; Dynamic Client Registration (prefer Client ID Metadata Documents) | changelog "Deprecated" |

## The endpoint, in Hono terms

1. **One path, POST only.** `app.post('/mcp', ...)`. `GET` and `DELETE` get `405` (SHOULD, per
   the backward-compatibility section of the transport page); a stray `Mcp-Session-Id` or
   `Last-Event-ID` header is ignored.
2. **Origin and Host first.** The server MUST validate `Origin` and answer a bad one with `403`.
   `hostHeaderValidation(...)` and `originValidation(...)` from `@modelcontextprotocol/hono`
   are Hono middleware. Register them with the endpoint path, **before** the route: a Hono
   middleware only covers routes registered after it (rule M001).
3. **Authenticate every request.** `requireBearerAuth` from `@modelcontextprotocol/server` is a
   `(Request) => Promise<AuthInfo | Response>` gate: return the `Response` when it is one,
   otherwise pass the result as `handler.fetch(c.req.raw, { authInfo })`. The handler never
   verifies tokens itself.
4. **Serve Protected Resource Metadata** (MUST, RFC 9728) with `authorization_servers`, and put
   its URL in the `WWW-Authenticate` challenge as `resource_metadata`.
5. **One server per request.** `createMcpHandler(factory)` calls the factory for every request;
   build pools and caches at module scope and close over them.

## Authorization, as the spec orders it

401 without or with an invalid token, carrying
`WWW-Authenticate: Bearer resource_metadata="<url>"` (and `scope` when you know it); 403 with
`error="insufficient_scope"` when the token lacks a scope. The server MUST check that the
token was issued **for it** (audience, RFC 8707) and MUST NOT pass the client's token on to an
upstream API. Tokens never travel in the query string. Details and the discovery URL forms:
`references/spec-2026-07-28.md`.

## Traps

| Trap | Why |
|---|---|
| Reading the body before `handler.fetch` (a body validator, `await c.req.json()`) | the stream is consumed and the call returns 500; read it once and pass `{ parsedBody }` |
| Following a 2025 tutorial (`initialize`, `Mcp-Session-Id`, GET for notifications) | all removed; a modern client will not send them |
| `@modelcontextprotocol/sdk` 1.x or `@hono/mcp` for a 2026-07-28 endpoint | they cannot speak it (table above) |
| Guards registered after the route | they never run for it |
| Token `expiresAt` unset | the SDK refuses the token; fill it from `exp` |
| Allowing `*` or a reflected origin with credentials | rule S001; the allowlist is hostnames, deny by default |
| Sharing one `McpServer` across requests | the factory exists so each request owns its instance |

## Checks

| Question | Call |
|---|---|
| Runtime, entrypoint, how it is served | `hono_project(workspace="/abs/path")` |
| Does the endpoint have a chain with auth and guards in the right order? | `hono_trace(workspace="/abs/path", path="/mcp", method="POST")` |
| Rule findings on the new endpoint | `hono_validate(workspace="/abs/path", categories=["security", "middleware", "conventions"])` |

Expect `V002` (a POST with no body validator) on the MCP route: the SDK validates the JSON-RPC
body, and a Hono body validator in front of it would consume the stream (first trap). It is
a finding to acknowledge, not to silence by adding a validator. `C001` flags a runtime
mismatch such as `Deno.env` under Node. Do not read this skill as proof that an example is
validator-clean: run `hono_validate` on your project.

## Precedence

The project's existing conventions outrank this skill; the user's request and safety outrank
both (`engineering-baseline`). Authentication and Origin validation are safety: deny by
default, and never loosen either to make a client connect.
