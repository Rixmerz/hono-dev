# Implementation — MCP 2026-07-28 on Hono (Node)

Tested on 2026-11-01 with: `hono` 4.13.16, `@hono/node-server` 2.1.5,
`@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/hono` 2.0.2, `zod` 4.6.7,
`jose` 6.2.14, `vitest` 5.0.5, TypeScript 6.0.3. Versions come from `npm view <pkg> version`.

```sh
npm install --save-exact hono @hono/node-server @modelcontextprotocol/server @modelcontextprotocol/hono zod jose
npm install --save-exact --save-dev typescript @types/node vitest
```

`@modelcontextprotocol/server` documents `createMcpHandler(factory, options)` and the
`legacy: 'stateless' | 'reject'` option in its published types; the serving guide is
<https://ts.sdk.modelcontextprotocol.io/v2/serving/http>. `jose` is only the JWT verifier;
anything that implements `OAuthTokenVerifier` fits.

Each block starts with a `file=` marker so the files can be extracted mechanically.

## Environment (validated at startup)

```ts file=src/env.ts
import * as z from "zod/v4";

// Parse once at startup so a missing or malformed variable stops the process
// before it serves a single request.
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // Public URL of the MCP endpoint, e.g. https://mcp.example.com/mcp. It is the
  // RFC 8707 resource identifier that tokens must be issued for.
  MCP_PUBLIC_URL: z.url(),
  // Authorization server the tokens come from.
  AUTH_ISSUER: z.url(),
  AUTH_AUTHORIZATION_ENDPOINT: z.url(),
  AUTH_TOKEN_ENDPOINT: z.url(),
  AUTH_JWKS_URL: z.url(),
  // Comma-separated hostnames, port-agnostic (the SDK's allowlist convention).
  ALLOWED_HOSTS: z.string().min(1).transform((v) => v.split(",").map((h) => h.trim())),
  ALLOWED_ORIGINS: z.string().default("").transform((v) => v.split(",").map((h) => h.trim()).filter(Boolean)),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
```

`MCP_PUBLIC_URL` is the RFC 8707 resource identifier: tokens must be minted for exactly this URL.
`ALLOWED_HOSTS` and `ALLOWED_ORIGINS` are hostnames only, no scheme and no port.

## Token verifier

```ts file=src/verifier.ts
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

export function createJwtVerifier(options: {
  issuer: string;
  jwksUrl: string;
  resource: URL;
}): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  return {
    async verifyAccessToken(token) {
      try {
        // `audience` is the RFC 8707 check: a token minted for another resource
        // server is rejected here (spec: authorization, "Token Handling").
        const { payload } = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: options.resource.href,
        });
        return {
          token,
          clientId: String(payload["client_id"] ?? payload.sub ?? "unknown"),
          scopes: typeof payload["scope"] === "string" ? payload["scope"].split(" ").filter(Boolean) : [],
          // The SDK refuses tokens whose expiresAt is unset.
          ...(payload.exp === undefined ? {} : { expiresAt: payload.exp }),
          resource: options.resource,
        };
      } catch {
        // The cause (bad signature, wrong audience, expired) stays out of the
        // response so a caller cannot probe the validator.
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
      }
    },
  };
}
```

## The MCP handler

```ts file=src/mcp.ts
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

// The factory runs once per HTTP request and holds no state between requests.
// Build pools and caches at module scope and close over them.
export const mcpHandler = createMcpHandler(
  ({ authInfo }) => {
    const server = new McpServer({ name: "notes", version: "1.0.0" });
    server.registerTool(
      "echo",
      { description: "Echo a message", inputSchema: z.object({ message: z.string() }) },
      async ({ message }) => ({ content: [{ type: "text", text: message }] }),
    );
    server.registerTool("whoami", { description: "Name the authenticated caller" }, async () => ({
      content: [{ type: "text", text: authInfo?.clientId ?? "anonymous" }],
    }));
    return server;
  },
  // The default serves 2025-era clients statelessly from this same factory.
  // Pass { legacy: "reject" } for a 2026-07-28-only endpoint.
);
```

By default the handler also serves 2025-era clients, statelessly, from the same factory.
`createMcpHandler(factory, { legacy: "reject" })` makes the endpoint 2026-07-28 only: a
2025 request gets the unsupported-protocol-version error (`-32022`, `data.supported`).
`responseMode` (`auto` by default, `json`, `sse`) shapes the response; `json` drops
notifications emitted before the result.

## The Hono app

```ts file=src/app.ts
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/hono";
import {
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { OAuthMetadata, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env.ts";
import { mcpHandler } from "./mcp.ts";

export function createApp(env: Env, verifier: OAuthTokenVerifier) {
  const resource = new URL(env.MCP_PUBLIC_URL);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const oauthMetadata: OAuthMetadata = {
    issuer: env.AUTH_ISSUER,
    authorization_endpoint: env.AUTH_AUTHORIZATION_ENDPOINT,
    token_endpoint: env.AUTH_TOKEN_ENDPOINT,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
  const gate = requireBearerAuth({
    verifier,
    requiredScopes: ["mcp"],
    resourceMetadataUrl,
    expectedResource: resource,
  });

  const app = new Hono();

  // Liveness only. Left outside the guards below: it returns no MCP data.
  app.get("/healthz", (c) => c.text("ok"));

  // Protected Resource Metadata (RFC 9728) is public by design.
  app.all("/.well-known/*", (c) => oauthMetadataResponse(c.req.raw, {
    oauthMetadata,
    resourceServerUrl: resource,
    scopesSupported: ["mcp"],
    resourceName: "notes",
  }) ?? c.notFound());

  // DNS-rebinding guards, scoped to the MCP endpoint and registered before its
  // routes: a middleware only covers routes registered after it.
  app.use(resource.pathname, hostHeaderValidation(env.ALLOWED_HOSTS), originValidation(env.ALLOWED_ORIGINS));

  // The single MCP endpoint. This revision defines POST only.
  app.post(resource.pathname, async (c) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    return mcpHandler.fetch(c.req.raw, { authInfo: auth });
  });
  app.all(resource.pathname, (c) => c.body(null, 405, { Allow: "POST" }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
```

Notes:

- `/.well-known/*` is answered by `oauthMetadataResponse`. For a resource URL with a path it
  serves the path-inserted document (`/.well-known/oauth-protected-resource/mcp`); the root form
  returned 404 in the smoke test, which the spec allows because the `WWW-Authenticate`
  challenge names the URL clients should fetch. The helper also serves
  `/.well-known/oauth-authorization-server` from the `oauthMetadata` you pass.
- `requireBearerAuth` emits `scope="mcp"` in the challenge because `requiredScopes` is set.
- Do not read the body before `mcpHandler.fetch`. If you must (logging, a validator), read it
  once and pass `mcpHandler.fetch(c.req.raw, { authInfo: auth, parsedBody })`; the second
  argument's `parsedBody` is in `McpHandlerRequestOptions`.
- For local development `createMcpHonoApp()` from `@modelcontextprotocol/hono` returns a Hono
  app with the Host and Origin guards and a JSON body parser already installed.

## Process entry and shutdown

```ts file=src/serve.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { mcpHandler } from "./mcp.ts";
import { createJwtVerifier } from "./verifier.ts";

const env = loadEnv();
const app = createApp(
  env,
  createJwtVerifier({ issuer: env.AUTH_ISSUER, jwksUrl: env.AUTH_JWKS_URL, resource: new URL(env.MCP_PUBLIC_URL) }),
);
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`listening on ${info.address}:${info.port}`);
});

function shutdown() {
  // Stay below kill_timeout in fly.toml: Fly kills the process after that anyway.
  setTimeout(() => process.exit(1), 25_000).unref();
  void mcpHandler.close().then(() => server.close((err) => process.exit(err ? 1 : 0)));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

`handler.close()` aborts in-flight exchanges; keep the forced exit below `kill_timeout`
(`../../hono-deploy/references/node-fly.md`).

## Cloudflare Workers

The handler is web-standard: the SDK serving guide says `export default handler` is the whole
mount on Workers, Deno and Bun. With Hono, export the app and read bindings from `c.env` inside
the request, not at module load (`../../hono-deploy/references/workers.md`). Build `Env` from
`c.env` instead of `process.env`, and keep the same guards and bearer gate. The Workers variant
was not run in this session; only the Node implementation above was.

## The test

```ts file=src/app.test.ts
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { Env } from "./env.ts";

const env: Env = {
  PORT: 8080,
  MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
  AUTH_ISSUER: "https://auth.example.com",
  AUTH_AUTHORIZATION_ENDPOINT: "https://auth.example.com/authorize",
  AUTH_TOKEN_ENDPOINT: "https://auth.example.com/token",
  AUTH_JWKS_URL: "https://auth.example.com/jwks",
  ALLOWED_HOSTS: ["mcp.example.com"],
  ALLOWED_ORIGINS: ["app.example.com"],
};

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    if (token !== "good") throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    return {
      token,
      clientId: "client-1",
      scopes: ["mcp"],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL(env.MCP_PUBLIC_URL),
    };
  },
};

const app = createApp(env, verifier);

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function post(method: string, params: object = {}, headers: Record<string, string> = {}) {
  return app.request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      host: "mcp.example.com",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
}

const auth = { authorization: "Bearer good" };

describe("MCP endpoint", () => {
  it("challenges a request without a token and points at the resource metadata", async () => {
    const res = await post("tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("rejects a token the verifier does not accept", async () => {
    const res = await post("tools/list", {}, { authorization: "Bearer forged" });
    expect(res.status).toBe(401);
  });

  it("lists tools with a valid token", async () => {
    const res = await post("tools/list", {}, auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.resultType).toBe("complete");
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "whoami"]);
  });

  it("passes the verified identity to the tool", async () => {
    const res = await post("tools/call", { name: "whoami", arguments: {} }, { ...auth, "mcp-name": "whoami" });
    const body = await res.json();
    expect(body.result.content[0].text).toBe("client-1");
  });

  it("rejects a header that disagrees with the body (-32020)", async () => {
    const res = await post("tools/call", { name: "whoami", arguments: {} }, { ...auth, "mcp-name": "echo" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it("answers GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("https://mcp.example.com/mcp", { method, headers: { host: "mcp.example.com" } });
      expect(res.status).toBe(405);
    }
  });

  it("rejects a foreign Origin and a foreign Host with 403", async () => {
    expect((await post("tools/list", {}, { ...auth, origin: "https://evil.example.com" })).status).toBe(403);
    expect((await post("tools/list", {}, { ...auth, host: "evil.example.com" })).status).toBe(403);
  });

  it("never mints or echoes a session id", async () => {
    const res = await post("tools/list", {}, { ...auth, "mcp-session-id": "abc" });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("discovery documents", () => {
  it("serves Protected Resource Metadata at the path-inserted well-known URL", async () => {
    const res = await app.request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp", {
      headers: { host: "mcp.example.com" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://mcp.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
  });
});
```

Run it with `npx vitest run`. The two tests that guard the guards (`405`, `403`) were
inverted once to confirm they go red.

## Manual check with curl

Replace the token and host. The three headers are required by the spec on every POST:

```sh
curl -s -X POST http://localhost:8080/mcp \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Observed in the smoke run against this implementation: no token gives `401` with
`WWW-Authenticate: Bearer error="invalid_token" ... scope="mcp", resource_metadata="..."`; a token
for another audience gives `401`; a token without the `mcp` scope gives `403 insufficient_scope`;
a foreign `Origin` or `Host` gives `403`; `GET` and `DELETE` give `405`; a body whose
`params.name` differs from `Mcp-Name` gives `400` with `-32020`; protocol version `1900-01-01`
gives `400` with `-32022` and `data.supported`; `server/discover` returns `supportedVersions`,
`resultType: "complete"`, `ttlMs` and `cacheScope`; a response never carries `Mcp-Session-Id`.

## What the validators say

`hono_validate` may report `V002` (POST with no body validator) on `/mcp`; see `SKILL.md`. These
files were not run through the validators, which did not exist when this skill was written.
