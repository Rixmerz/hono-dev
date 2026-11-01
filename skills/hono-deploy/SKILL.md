---
name: hono-deploy
description: >-
  Deploy a Hono 4.x app: Node on Fly.io in Docker (multi-stage node:24-slim image running
  @hono/node-server, fly.toml http_service with internal_port, health checks and
  autostop/autostart, graceful SIGTERM shutdown, fly secrets, env validated at startup) and
  Cloudflare Workers (wrangler.jsonc, compatibility_date, nodejs_compat, bindings through
  c.env, wrangler secret, wrangler dev). Also covers moving a Deno.serve(app.fetch) entry to
  @hono/node-server. Use when adding a Dockerfile, fly.toml or wrangler.jsonc, changing how
  the app is served or configured in production, or migrating off Deno. Ships example config
  files under references/examples/.
user-invocable: false
paths: "Dockerfile,fly.toml,wrangler.jsonc,wrangler.toml,src/server.ts,main.ts,.dev.vars"
---

# hono-deploy

Two targets, one rule: the process **validates its environment before it takes traffic**, and
**secrets never live in a file that is committed**. Everything else follows from where the app runs.

References: `references/node-fly.md`, `references/workers.md`, `references/deno-to-node.md`,
example files in `references/examples/` (`node-fly/Dockerfile`, `node-fly/.dockerignore`,
`node-fly/fly.toml`, `workers/wrangler.jsonc`). Serving an MCP endpoint:
`../hono-mcp-server/SKILL.md`.

## Pick the target

| Question | Call |
|---|---|
| What runtime, entry file and serve call does the project have today? | `hono_project(workspace="/abs/path")` : `runtime`, `entry.serve` (`node-server`, `deno-serve`, `export-default`), `deployTargets` |
| Does it mix runtimes (`Deno.env` in a Node app, `c.env` on Node)? | `hono_validate(workspace="/abs/path", categories=["conventions"])` : rule `C001` |
| Is there an error handler before this goes to production? | `hono_validate(...)` : rule `A002` |

| Target | Entry | Config | Secrets |
|---|---|---|---|
| Node on Fly.io | `serve({ fetch: app.fetch, port, hostname: "0.0.0.0" })` from `@hono/node-server` | `Dockerfile` + `fly.toml` | `fly secrets set` |
| Cloudflare Workers | `export default app` | `wrangler.jsonc` | `wrangler secret put` |
| Deno today (`Deno.serve(app.fetch)`) | move it | `deno-to-node.md` | the old environment, validated |

## Node on Fly.io in Docker (details: `references/node-fly.md`)

1. **Image.** Three stages on `node:24-slim`: install with `npm ci`, build with `tsc` and prune
   dev dependencies, copy only `node_modules` and `dist` into a runtime stage that runs as the
   `node` user with `CMD ["node", "dist/server.js"]` (exec form, so node gets the signal).
2. **Bind `0.0.0.0` on `PORT`.** Fly Proxy reaches the VM on its private IPv4 address, and
   `internal_port` in `fly.toml` must equal the port the process binds.
3. **Validate the environment before `serve()`.** A schema parses `process.env` once; a missing
   secret exits `1` before the port opens, so the health check never passes.
4. **Shut down on `SIGTERM`.** Call `server.close(cb)` (waits for in-flight requests), keep a forced
   exit timer shorter than `kill_timeout`, and set `kill_signal = "SIGTERM"` (the default is
   `SIGINT`) and `kill_timeout` above the timer (default 5 s, max 300).
5. **Health check** on a plain `GET /healthz` that returns `200`: checks expect a 2xx and do not
   follow redirects.
6. **Autostop** `auto_stop_machines = "stop"` with `auto_start_machines = true` (enable both or
   neither) scales to zero; a cold start takes about 2 seconds or more.
7. **Secrets** with `fly secrets set NAME=value --stage`, then `fly deploy`; `fly secrets list`
   shows names and digests, never values. Setting a secret restarts every Machine.

## Cloudflare Workers (details: `references/workers.md`)

1. `wrangler.jsonc` with `name`, `main`, `compatibility_date`, `compatibility_flags: ["nodejs_compat"]`.
   **The date must not exceed what the installed workerd supports**: `wrangler dev` refused
   `2026-10-31` (the date in Cloudflare's own example) against workerd 1.20261023.1.
2. Bindings and secrets arrive as `c.env`, typed by `wrangler types --env-interface CloudflareBindings`
   and `new Hono<{ Bindings: CloudflareBindings }>()`. Read them inside the request, never at module load.
3. Validate `c.env` once per isolate in a first middleware; there is no startup phase.
4. Secrets: `wrangler secret put NAME` (creates a version and deploys it); locally `.dev.vars`,
   never committed (`.dev.vars*` and `.env*` in `.gitignore`).
5. `wrangler dev --local` for development, `wrangler deploy --dry-run` to compile without deploying.

## Moving off Deno (details: `references/deno-to-node.md`)

`Deno.serve({ port, signal }, app.fetch)` becomes `serve({ fetch: app.fetch, port, hostname })`
plus `server.close()` on `SIGTERM`; `Deno.addSignalListener` becomes `process.on`; `Deno.env.get`
becomes a validated `process.env`; `npm:hono@4` in `deno.json` becomes a `package.json`
dependency. **`Deno.cron` has no Node counterpart**, and `typeof Deno.cron` throws under Node.

## Traps

| Trap | Why |
|---|---|
| Binding `localhost` in a container | the proxy cannot reach it (502) |
| `NODE_ENV=production` before `npm ci` in the build stage | dev dependencies, including `tsc`, are skipped |
| `CMD ["npm", "start"]` | npm sits between the platform and node; the signal may not arrive |
| `auto_stop_machines` without `auto_start_machines` | Machines stop and never wake |
| Secret in `[env]`, `vars`, the Dockerfile or the repo | `[env]` and `vars` are plain text; use `fly secrets` / `wrangler secret` |
| `compatibility_date` ahead of the local workerd | the Worker will not start locally |
| Reading `c.env` at module top level | bindings exist per request |
| Trusting an example from memory | flags and fields moved between versions; the reference files cite the pages they were read from |

## What was and was not verified

Run on 2026-11-01: the Docker build and run, the drain behaviour, `wrangler types`,
`wrangler deploy --dry-run`, `wrangler dev --local`. **Not run**: `fly deploy`, `fly config validate`
(no `flyctl` available), `wrangler deploy`, Prisma in the slim image, the Deno migration sketch
against xpteam. Treat those as unverified.

## Precedence

The project's existing conventions outrank this skill (a repo already on Alpine, on `wrangler.toml`
or on another health path keeps them); the user's request and safety outrank both
(`engineering-baseline`). Secrets and input validation are safety: never loosen them to make a
deploy go green.
