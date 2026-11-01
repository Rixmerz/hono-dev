import { afterAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectIndex } from "../../core/index.ts";
import { stateDir } from "../../core/state.ts";
import { cleanupTemps, loadFixture, loadProject, makeProject } from "../_helpers.ts";

afterAll(cleanupTemps);

describe("rpc", () => {
  it("reports a chained app type with its route count and the hc client", async () => {
    const idx = await loadFixture("hono-mounted");
    expect(idx.rpc.appTypes).toEqual([
      {
        name: "AppType",
        file: "src/rpc/api.ts",
        line: 14,
        target: "src/rpc/api.ts#rpcApp",
        chained: true,
        routeCount: 2,
      },
    ]);
    expect(idx.rpc.clients).toEqual([
      {
        file: "src/rpc/client.ts",
        line: 4,
        typeArg: "AppType",
        appType: "AppType",
        baseUrl: "http://localhost:3000/rpc",
      },
    ]);
  });

  it("flags an app type taken from a non-chained instance", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `import { Hono } from "hono";\nconst app = new Hono();\napp.get("/a", (c) => c.text("a"));\napp.get("/b", (c) => c.text("b"));\nexport type AppType = typeof app;\nexport default app;\n`,
    });
    expect(idx.rpc.appTypes).toMatchObject([
      { name: "AppType", chained: false, routeCount: 0, target: "src/app.ts#app" },
    ]);
  });

  it("follows `const route = app.post(...)` aliases and counts the chain", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `import { Hono } from "hono";\nconst app = new Hono();\nconst route = app.get("/a", (c) => c.text("a")).post("/b", (c) => c.text("b"));\nexport type AppType = typeof route;\nexport default app;\n`,
    });
    expect(idx.rpc.appTypes).toMatchObject([
      { chained: true, routeCount: 2, target: "src/app.ts#app" },
    ]);
  });

  it("resolves hc<typeof app> and leaves unknown type arguments unresolved", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `import { Hono } from "hono";\nexport const app = new Hono().get("/a", (c) => c.text("a"));\nexport default app;\n`,
      "src/client.ts": `import { hc } from "hono/client";\nimport { app } from "./app.ts";\nimport type { Missing } from "./nowhere.ts";\nexport const a = hc<typeof app>("http://x");\nexport const b = hc<Missing>("http://y");\nexport const c = hc("http://z");\n`,
    });
    expect(idx.rpc.clients.map((c) => [c.typeArg, c.appType, c.baseUrl])).toEqual([
      ["typeof app", "typeof app", "http://x"],
      ["Missing", null, "http://y"],
      [null, null, "http://z"],
    ]);
  });
});

describe("env reads and validation", () => {
  it("collects every env API with its key", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/a.ts": [
        `import { env } from "hono/adapter";`,
        `export const a = [process.env.A, process.env["B"], Deno.env.get("C"), Bun.env.D, import.meta.env.E];`,
        `export const h = (c) => [c.env.F, env(c).G];`,
        `export const { H, I } = process.env;`,
        ``,
      ].join("\n"),
    });
    expect(idx.envReads.map((e) => [e.api, e.key])).toEqual([
      ["process.env", "A"],
      ["process.env", "B"],
      ["Deno.env.get", "C"],
      ["Bun.env", "D"],
      ["import.meta.env", "E"],
      ["c.env", "F"],
      ["env(c)", "G"],
      ["process.env", "H"],
      ["process.env", "I"],
    ]);
    expect(idx.envReads.every((e) => !e.validated)).toBe(true);
  });

  it("recognises schema validation (zod, valibot, envalid, t3-env) and marks the reads inside", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/zod.ts": `import { z } from "zod";\nconst schema = z.object({ PORT: z.string(), TOKEN: z.string() });\nexport const env = schema.parse(process.env);\n`,
      "src/valibot.ts": `import * as v from "valibot";\nconst s = v.object({ A: v.string() });\nexport const env = v.parse(s, process.env);\n`,
      "src/envalid.ts": `import { cleanEnv, str } from "envalid";\nexport const env = cleanEnv(process.env, { X: str(), Y: str() });\n`,
      "src/t3.ts": `import { createEnv } from "@t3-oss/env-core";\nexport const env = createEnv({ server: {}, runtimeEnv: process.env });\n`,
      "src/workers.ts": `import { z } from "zod";\nconst s = z.object({ K: z.string() });\nexport const mw = async (c, next) => { s.parse(c.env); await next(); };\n`,
      "src/raw.ts": `export const url = process.env.DATABASE_URL;\n`,
    });
    const byFile = Object.fromEntries(idx.envValidation.map((v) => [v.file, [v.via, v.keys]]));
    expect(byFile).toEqual({
      "src/zod.ts": ["zod", ["PORT", "TOKEN"]],
      "src/valibot.ts": ["valibot", ["A"]],
      "src/envalid.ts": ["envalid", ["X", "Y"]],
      "src/t3.ts": ["t3-env", "all"],
      "src/workers.ts": ["zod", ["K"]],
    });
    const validated = Object.fromEntries(idx.envReads.map((e) => [e.file, e.validated]));
    expect(validated).toEqual({
      "src/zod.ts": true,
      "src/valibot.ts": true,
      "src/envalid.ts": true,
      "src/t3.ts": true,
      "src/workers.ts": true,
      "src/raw.ts": false,
    });
  });

  it("treats reads inside config.envValidationModules as validated", async () => {
    const idx = await loadProject({
      ".hono-dev/config.json": `{"envValidationModules":["src/env.ts"]}`,
      "src/env.ts": `export const url = process.env.DATABASE_URL;\n`,
    });
    expect(idx.envReads.map((e) => e.validated)).toEqual([true]);
    expect(idx.envValidation.map((v) => v.file)).toEqual(["src/env.ts"]);
  });

  it("the clean fixtures read env only through a schema", async () => {
    for (const name of ["hono-node", "hono-deno", "hono-workers"]) {
      const idx = await loadFixture(name);
      expect(idx.envValidation.length, name).toBeGreaterThan(0);
      expect(
        idx.envReads.filter((e) => !e.validated),
        name,
      ).toEqual([]);
    }
  });
});

describe("hand-written env guards", () => {
  const PKG = `{"dependencies":{"hono":"4.13.16"}}`;

  it("records a read-then-throw guard as a custom validation with its keys", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/utils/startup-guard.ts": [
        `export function assertStartupSecrets(): void {`,
        `  const jwtSecret = Deno.env.get("JWT_SECRET");`,
        `  if (!jwtSecret) {`,
        `    throw new Error("JWT_SECRET is not set");`,
        `  }`,
        `  const encKey = Deno.env.get("ENCRYPTION_KEY");`,
        `  if (!encKey || encKey.length !== 64) throw new Error("ENCRYPTION_KEY invalid");`,
        `}`,
        ``,
      ].join("\n"),
      "src/other.ts": `export const port = Deno.env.get("PORT");\n`,
    });
    expect(idx.envValidation).toEqual([
      {
        file: "src/utils/startup-guard.ts",
        line: 3,
        via: "custom",
        keys: ["JWT_SECRET", "ENCRYPTION_KEY"],
      },
    ]);
    const validated = Object.fromEntries(idx.envReads.map((e) => [e.key, e.validated]));
    expect(validated).toEqual({ JWT_SECRET: true, ENCRYPTION_KEY: true, PORT: false });
  });

  it("recognises an inline guard on the read itself and a guard on destructured keys", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/inline.ts": `if (!process.env.API_TOKEN) throw new Error("missing");\nexport const t = process.env.API_TOKEN;\n`,
      "src/destructured.ts": `const { DB_PASSWORD, HOST } = process.env;\nif (DB_PASSWORD === undefined) throw new Error("missing");\nexport const h = HOST;\n`,
    });
    const byFile = Object.fromEntries(idx.envValidation.map((v) => [v.file, v.keys]));
    expect(byFile).toEqual({
      "src/inline.ts": ["API_TOKEN"],
      "src/destructured.ts": ["DB_PASSWORD"],
    });
    const validated = Object.fromEntries(
      idx.envReads.map((e) => [`${e.file}:${e.key}`, e.validated]),
    );
    expect(validated["src/destructured.ts:HOST"]).toBe(false);
    expect(validated["src/destructured.ts:DB_PASSWORD"]).toBe(true);
  });

  it("follows a read through a default, a cast or a method call to the guard (xpteam demo-data)", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "prisma/demo-data.ts": [
        `const url = Deno.env.get("DATABASE_URL") ?? "";`,
        `if (!/@(localhost|127\\.0\\.0\\.1)[:/]/.test(url)) {`,
        `  console.error("denied");`,
        `  Deno.exit(1);`,
        `}`,
        ``,
      ].join("\n"),
      "src/cast.ts": `const a = process.env.API_TOKEN as string;\nif (!a) throw new Error("missing");\n`,
      "src/trim.ts": `const b = Deno.env.get("SIGNING_KEY")?.trim();\nif (!b) throw new Error("missing");\n`,
      "src/or.ts": `const c = process.env.DB_PASSWORD || "";\nif (c === "") throw new Error("missing");\n`,
      "src/assigned.ts": `let d: string | undefined;\nd = Deno.env.get("HMAC_SECRET");\nif (!d) throw new Error("missing");\n`,
    });
    const byFile = Object.fromEntries(idx.envValidation.map((v) => [v.file, v.keys]));
    expect(byFile).toEqual({
      "prisma/demo-data.ts": ["DATABASE_URL"],
      "src/cast.ts": ["API_TOKEN"],
      "src/trim.ts": ["SIGNING_KEY"],
      "src/or.ts": ["DB_PASSWORD"],
      "src/assigned.ts": ["HMAC_SECRET"],
    });
    expect(idx.envReads.every((e) => e.validated)).toBe(true);
  });

  it("matches a module-level read to a guard inside a function of the same module", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/boot.ts": [
        `const secret = Deno.env.get("JWT_SECRET");`,
        `export function assertBoot(): void {`,
        `  if (!secret) throw new Error("JWT_SECRET missing");`,
        `}`,
        ``,
      ].join("\n"),
    });
    expect(idx.envValidation).toMatchObject([{ via: "custom", keys: ["JWT_SECRET"] }]);
    expect(idx.envReads.map((e) => e.validated)).toEqual([true]);
  });

  it("re-parses a file whose facts a parser of version 2 cached before it saw the guard", async () => {
    const dir = await makeProject({
      "package.json": PKG,
      "prisma/demo-data.ts": `const url = Deno.env.get("DATABASE_URL") ?? "";\nif (!url) Deno.exit(1);\n`,
    });
    await ProjectIndex.load(dir, { force: true });
    const file = join(stateDir(dir), "facts-cache.json");
    const cache = JSON.parse(await readFile(file, "utf8"));
    cache.parser = 2;
    const stale = cache.files["prisma/demo-data.ts"].facts;
    stale.envValidations = [];
    for (const r of stale.envReads) r.validated = false;
    await writeFile(file, JSON.stringify(cache));
    const idx = await ProjectIndex.load(dir);
    expect(idx.envReads.map((e) => e.validated)).toEqual([true]);
    expect(idx.envValidation).toMatchObject([{ keys: ["DATABASE_URL"] }]);
  });

  it("keeps a derived read unvalidated when nothing checks it", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/loose.ts": [
        `const a = Deno.env.get("API_TOKEN") ?? "";`,
        `const b = process.env.SIGNING_KEY?.trim();`,
        `const other = "x";`,
        `if (!other) throw new Error("unrelated");`,
        `export { a, b };`,
        ``,
      ].join("\n"),
    });
    expect(idx.envValidation).toEqual([]);
    expect(idx.envReads.map((e) => e.validated)).toEqual([false, false]);
  });

  it("does not count a guard behind a non-empty fallback, which can never fire", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/fallback.ts": [
        `const a = Deno.env.get("JWT_SECRET") ?? "dev-secret";`,
        `if (!a) throw new Error("missing");`,
        `const b = process.env.API_TOKEN || "changeme";`,
        `if (!b) throw new Error("missing");`,
        ``,
      ].join("\n"),
    });
    expect(idx.envValidation).toEqual([]);
    expect(idx.envReads.map((e) => e.validated)).toEqual([false, false]);
  });

  it("follows a read that is the fallback of another value to the guard", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/override.ts": [
        `export function boot(override?: string): void {`,
        `  const s = override ?? Deno.env.get("JWT_SECRET");`,
        `  if (!s) throw new Error("missing");`,
        `}`,
        ``,
      ].join("\n"),
    });
    expect(idx.envValidation).toMatchObject([{ via: "custom", keys: ["JWT_SECRET"] }]);
    expect(idx.envReads.map((e) => e.validated)).toEqual([true]);
  });

  it("keeps both alternatives of `A ?? B` tied to the guard", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/either.ts": [
        `const k = process.env.A_KEY ?? process.env.B_KEY;`,
        `if (!k) throw new Error("missing");`,
        ``,
      ].join("\n"),
    });
    expect(idx.envReads.map((e) => [e.key, e.validated])).toEqual([
      ["A_KEY", true],
      ["B_KEY", true],
    ]);
  });

  it("only a redeclaration whose block holds the guard shadows a module-level read", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/sibling.ts": [
        `const secret = Deno.env.get("JWT_SECRET");`,
        `export function f(): void {`,
        `  { const secret = 1; void secret; }`,
        `  if (!secret) throw new Error("missing");`,
        `}`,
        ``,
      ].join("\n"),
      "src/own.ts": [
        `const secret = Deno.env.get("JWT_SECRET");`,
        `export function f(): void {`,
        `  { const secret = 1; if (!secret) throw new Error("missing"); }`,
        `}`,
        `export function g(xs: string[]): void {`,
        `  for (const secret of xs) if (!secret) throw new Error("missing");`,
        `}`,
        `export function h(): void {`,
        `  try { f(); } catch (secret) { if (!secret) throw new Error("missing"); }`,
        `}`,
        `export function v(): void {`,
        `  if (f()) { var secret = 1; }`,
        `  if (!secret) throw new Error("missing");`,
        `}`,
        ``,
      ].join("\n"),
    });
    const validated = Object.fromEntries(idx.envReads.map((e) => [e.file, e.validated]));
    expect(validated).toEqual({ "src/sibling.ts": true, "src/own.ts": false });
  });

  it("does not let a shadowing parameter or local validate a module-level read", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/shadow.ts": [
        `const secret = Deno.env.get("JWT_SECRET");`,
        `export function byParam(secret: string): void {`,
        `  if (!secret) throw new Error("missing");`,
        `}`,
        `export function byLocal(): void {`,
        `  const { secret } = { secret: "x" };`,
        `  if (!secret) throw new Error("missing");`,
        `}`,
        `export const keep = secret;`,
        ``,
      ].join("\n"),
      "src/inner.ts": [
        `const token = Deno.env.get("API_TOKEN");`,
        `export function guard(): void {`,
        `  const check = (token: string) => {`,
        `    if (!token) throw new Error("missing");`,
        `  };`,
        `  check("x");`,
        `}`,
        `export function real(): void {`,
        `  if (!token) throw new Error("missing");`,
        `}`,
        ``,
      ].join("\n"),
    });
    const validated = Object.fromEntries(
      idx.envReads.map((e) => [`${e.file}:${e.key}`, e.validated]),
    );
    expect(validated).toEqual({
      "src/shadow.ts:JWT_SECRET": false,
      "src/inner.ts:API_TOKEN": true,
    });
    expect(idx.envValidation.map((v) => v.file)).toEqual(["src/inner.ts"]);
  });

  it("honours a fail-closed guard that answers instead of throwing (xpteam webhooks)", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/hook.ts": [
        `import { Hono } from "hono";`,
        `export const hook = new Hono();`,
        `hook.post("/x", async (c) => {`,
        `  const secret = Deno.env.get("WEBHOOK_SECRET");`,
        `  if (!secret) {`,
        `    return c.json({ error: "not configured" }, 500);`,
        `  }`,
        `  return c.text(secret.length.toString());`,
        `});`,
        ``,
      ].join("\n"),
    });
    expect(idx.envValidation).toMatchObject([{ via: "custom", keys: ["WEBHOOK_SECRET"] }]);
    expect(idx.envReads.map((e) => e.validated)).toEqual([true]);
  });

  it("does not count a positive branch that returns as a guard", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/positive.ts": [
        `export function connect(): string | null {`,
        `  const key = process.env.API_KEY;`,
        `  if (key) {`,
        `    return \`client:\${key}\`;`,
        `  }`,
        `  return null;`,
        `}`,
        ``,
      ].join("\n"),
    });
    expect(idx.envValidation).toEqual([]);
    expect(idx.envReads.map((e) => e.validated)).toEqual([false]);
  });

  it("does not treat a fallback default, or a check that does not throw, as validation", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/fallback.ts": `export const s = process.env.JWT_SECRET ?? "dev-secret";\n`,
      "src/log-only.ts": `const k = process.env.API_KEY;\nif (!k) console.warn("no key");\nexport { k };\n`,
    });
    expect(idx.envValidation).toEqual([]);
    expect(idx.envReads.every((e) => !e.validated)).toBe(true);
  });
});
