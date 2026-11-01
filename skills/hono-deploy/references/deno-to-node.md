# Moving `Deno.serve(app.fetch)` to `@hono/node-server`

The reference case is `xpteam-backend/main.ts` (read only): it imports `app` from `./src/app.ts`,
calls `assertStartupSecrets()`, registers a `Deno.cron` job behind a `typeof` guard, aborts an
`AbortController` on `SIGTERM`/`SIGINT` and then `await getDb().$disconnect()`, and starts with
`Deno.serve({ port, signal: ac.signal }, app.fetch)`. Its `deno.json` maps `hono` to `npm:hono@4`.

The Node target, packaging and Fly settings are in `node-fly.md`; those parts were run. **The
sketch at the end of this page was not run against xpteam**: it applies the pattern that was run
to what `main.ts` does.

Sources: Hono on Node <https://hono.dev/docs/getting-started/nodejs>; `serve()` signature from the
published `@hono/node-server` 2.1.5 types (`serve(options, listeningListener?)` returns the
`node:http` server).

## Mapping

| Deno | Node | Note |
|---|---|---|
| `Deno.serve({ port, signal }, app.fetch)` | `serve({ fetch: app.fetch, port, hostname: "0.0.0.0" })` | `serve` returns the `node:http` server; stop it with `server.close(cb)`. There is no `signal` option, and Hono's Node page says you must close the server yourself |
| `Deno.addSignalListener("SIGTERM", fn)` | `process.on("SIGTERM", fn)` | handle `SIGINT` too |
| `ac.abort()` then `$disconnect()` | `server.close(() => db.$disconnect())` | close the listener first and disconnect from the database only after in-flight requests finish, otherwise they lose the connection mid-request |
| `Deno.env.get("PORT") ?? 8000` | `process.env.PORT`, parsed once by a schema | rule `C001` flags `Deno.env` under Node; `S003` flags a secret-looking variable read without validation |
| `deno.json` `"hono": "npm:hono@4"` | `package.json` dependency `"hono": "4.13.16"` plus a committed `package-lock.json` | `deno.lock` does not become `package-lock.json` by itself; run `npm install` |
| `npm:hono` / `jsr:@hono/hono` specifiers in sources | bare `hono` | two Hono copies in one app is rule `C002`; `hono_project` lists `honoSpecifiers` |
| `import ... from "./src/app.ts"` | unchanged | Node strips types and accepts `.ts` imports in development; `tsc` with `rewriteRelativeImportExtensions` builds `dist/` (see `node-fly.md`). Use erasable syntax only: no enums, namespaces or parameter properties |
| `Deno.cron(...)` | **no counterpart in Node** | the job needs a different scheduler. This skill did not fetch any Fly scheduling documentation, so it names none; decide it separately before the cutover. The `typeof Deno.cron === "function"` guard in `main.ts` is **not** safe under Node: `Deno` is an undeclared identifier there, and the expression throws `ReferenceError: Deno is not defined` at startup (checked with `node -e`). Remove the block, and the retention purge stops running until a replacement exists |
| Deno Deploy | Fly.io (`node-fly.md`) | `hono_project` reports `deployTargets` |

Every other `Deno.*` call in the code base has to go before Node can run it. Find them with
`hono_validate(workspace="/abs/path", categories=["conventions"])` once `hono_project` reports the
runtime as `node` (rule `C001`), and with a text search for `Deno.`: a language server cannot see
a global used as a namespace in every case.

## Sketch of the migrated entry (not run)

```ts
import { serve } from "@hono/node-server";
import { app } from "./src/app.ts";
import { getDb } from "./src/db/client.ts";
import { loadEnv } from "./src/env.ts"; // schema-validated replacement for assertStartupSecrets + Deno.env

const env = loadEnv();

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`listening on ${info.address}:${info.port}`);
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, draining`);
  setTimeout(() => process.exit(1), 25_000).unref(); // below kill_timeout in fly.toml
  server.close(async (err) => {
    await getDb().$disconnect();
    process.exit(err ? 1 : 0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

## Order of work

1. Replace `Deno.env` and the other `Deno.*` APIs behind a validated `loadEnv()`; keep running on
   Deno while you do it, so each step is small.
2. Add `package.json`, install, switch the import specifiers to bare `hono`.
3. Swap the entry for the Node one above; run the existing tests against it.
4. Decide the `Deno.cron` replacement.
5. Build the image and rehearse the deploy (`node-fly.md`) before pointing traffic at it.
