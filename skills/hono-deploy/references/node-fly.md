# Node on Fly.io in Docker

Everything here was built and run on 2026-11-01: the image built from the Dockerfile below,
answered `/healthz` with `200`, exited `1` with a readable error when `APP_SECRET` was missing,
ran as uid 1000 (`node`) on Node v24.22.2, and finished an in-flight 3-second request after
`docker stop` before exiting `0`. `fly.toml` was parsed as TOML and cross-checked against the
reference below; **it was not validated by `fly config validate` or deployed** (no `flyctl` in
the session).

Sources (all fetched 2026-11-01):

- fly.toml reference: <https://docs.fly.io/reference/configuration>
- Autostop and autostart: <https://docs.fly.io/launch/autostop-autostart>
- Secrets: <https://docs.fly.io/apps/secrets>
- Health checks: <https://docs.fly.io/reference/health-checks>
- Bind address and `internal_port`: <https://docs.fly.io/networking/app-services/>
- `fly launch` flags: <https://docs.fly.io/flyctl/launch/>
- Hono on Node (serve, shutdown): <https://hono.dev/docs/getting-started/nodejs>
- Official image tags: <https://hub.docker.com/_/node>

Packages, from `npm view <pkg> version`: `hono` 4.13.16, `@hono/node-server` 2.1.5 (engines
`node >=20`, peer `hono ^4 || ^5.0.0-0`), `zod` 4.6.7, `typescript` 6.0.3.

## Files

Real files in `examples/node-fly/`: `Dockerfile`, `.dockerignore`, `fly.toml`. Copy them to the
project root.

`package.json` (the Dockerfile calls `npm run build`; `npm ci` needs a committed `package-lock.json`):

```json file=package.json
{
  "name": "hono-node-fly",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "dev": "node --watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@hono/node-server": "2.1.5",
    "hono": "4.13.16",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "24.19.2",
    "typescript": "6.0.3"
  }
}
```

`tsconfig.json` (`rewriteRelativeImportExtensions` turns `./app.ts` into `./app.js` in `dist/`, so
sources keep the `.ts` imports Node's type stripping needs in development):

```json file=tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2024",
    "types": ["node"],
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

```ts file=src/env.ts
import * as z from "zod/v4";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // A secret: set with `fly secrets set`, never in fly.toml.
  APP_SECRET: z.string().min(32),
});

export type Env = z.infer<typeof schema>;

// Called once at startup. A missing or malformed variable throws here, so the
// process exits before it listens and the platform never routes to it.
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
```

```ts file=src/app.ts
import { Hono } from "hono";
import type { Env } from "./env.ts";

export function createApp(env: Env) {
  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/", (c) => c.json({ ok: true }));
  app.get("/slow", async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return c.text("finished");
  });
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
```

`/slow` exists only to watch a drain; delete it.

```ts file=src/server.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const app = createApp(env);

// Fly's proxy reaches the VM on its private IPv4 address, so bind 0.0.0.0.
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`listening on ${info.address}:${info.port}`);
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, draining`);
  // Stay below kill_timeout in fly.toml: after that Fly kills the process anyway.
  setTimeout(() => process.exit(1), 25_000).unref();
  // Stops accepting connections and resolves once in-flight requests finish.
  server.close((err) => process.exit(err ? 1 : 0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

## Why each line is the way it is

| Choice | Reason |
|---|---|
| `hostname: "0.0.0.0"` | Fly Proxy reaches the VM on its private IPv4 address, so the process "should listen on IPv4 `0.0.0.0:<port>`" (app-services page) |
| `internal_port = 8080` equals `PORT` | the service definition's `internal_port` must match the port the process binds, or Fly Proxy cannot route to it |
| `kill_signal = "SIGTERM"`, `kill_timeout = 30` | the default signal is `SIGINT` and the default wait is 5 s (max 300); the app handles both signals and drains inside 25 s, under the 30 s kill |
| `CMD ["node", ...]` in exec form | node is PID 1 and gets the signal itself; `npm start` would sit between Fly and node |
| `ENV NODE_ENV=production` only in the runtime stage | in the build stage it would make `npm ci` skip the TypeScript compiler |
| `npm prune --omit=dev` then copy `node_modules` | the runtime image carries production dependencies only |
| `USER node` | the official image ships a non-root `node` user (uid 1000 observed) |
| `loadEnv()` before `serve()` | a bad environment exits before the port opens, so the health check never passes and the deploy does not route traffic to it |
| `/healthz` is a plain `200` | checks "expect a 2xx" and "do not follow 301/302"; it must not redirect or touch the database |

`node:24-slim` is the tag the request asked for; Docker Hub lists `24-slim`, `24-bookworm-slim`
and `24-trixie-slim`. Which Debian release `24-slim` maps to is inferred from the page, not
stated: pin `24-bookworm-slim` if the base image must not move.

## Commands

```sh
fly launch --no-deploy --copy-config --name <app> --region <code>   # keep the shipped fly.toml
fly secrets set APP_SECRET=<32+ chars> --stage                       # vault only, no restart yet
fly deploy                                                           # builds the image, creates a release
fly secrets list                                                     # NAME, DIGEST, DATE; values are never shown
fly checks list                                                      # the Last Updated column is when the status changed
```

Facts from the secrets page: `fly secrets set` updates every Machine, each restarts and its
ephemeral filesystem resets; `--stage` defers that; `fly secrets deploy` redeploys the current
release with staged secrets without rebuilding; `fly secrets unset NAME ...` removes them;
`fly secrets set` can read from stdin (see `fly secrets --help` for the syntax; the page gives none).
A secret overrides a same-named entry in `[env]`. Secrets needed **during the Docker build** are a
separate mechanism (<https://docs.fly.io/apps/build-secrets.md>): `fly deploy --build-secret NAME=value`
(repeat the flag for several), consumed in the Dockerfile with
`RUN --mount=type=secret,id=NAME ...`, which exposes the value at `/run/secrets/NAME`. The page does
not say whether the value can persist in image layers, so check Docker's secrets documentation
before relying on that. This example needs no build secret. Never put a secret in `fly.toml`, the
Dockerfile or the repository.

## Autostop and autostart

`auto_stop_machines = "stop"` lets Fly Proxy stop Machines when there is excess capacity (judged
against `soft_limit`); the stop pass runs every few minutes and stops at most one Machine per region
per pass. A request that arrives with nothing running starts a stopped Machine (a cold start of
about 2 seconds or more). Enable `auto_stop_machines` and `auto_start_machines` together, or
neither, otherwise Machines can stop and never restart. `min_machines_running` only has an effect
with autostop on, and only in the primary region. The autostop page does not say how health checks
affect stop decisions.

A failing service-level check makes the proxy stop routing to that Machine; it does not restart
it. `grace_period` must exceed startup time.

## When something is off

| Symptom | Check |
|---|---|
| deploy never becomes healthy | `fly checks list`; run the image locally with the same env; look for the `Invalid environment` error |
| 502 / connection refused from the proxy | the process binds `localhost` or a port other than `internal_port` |
| requests cut during a deploy | `kill_timeout` shorter than the slowest request; the drain timer must stay below it |
| Machine never wakes | `auto_start_machines` is `false` while `auto_stop_machines` is on |
| Prisma or another native client fails to start in the slim image | not verified here; check that library's docs for system packages (for example OpenSSL) and install them in the runtime stage |

## Ask the project first

`hono_project(workspace="/abs/path")` reports the runtime, the entry file, how it is served
(`entry.serve`) and `deployTargets`. After the change, `hono_validate(workspace="/abs/path",
categories=["conventions", "architecture"])` covers `C001` (a runtime API that does not match the
runtime, for example `Deno.env` under Node) and `A002` (no `onError`). Do not read this skill as
proof that the example passes the validators; run them.
