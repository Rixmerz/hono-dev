import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps, loadProject } from "../_helpers.ts";

afterAll(cleanupTemps);

const PKG = `{"dependencies":{"hono":"4.13.16"}}`;
const HONO = `import { Hono } from "hono";\n`;

describe("middleware function facts", () => {
  it("separates 'never calls next' from 'hands next to another middleware'", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/app.ts": [
        HONO,
        `import { jwt } from "hono/jwt";`,
        `export const app = new Hono();`,
        `app.use("/a/*", async (c, next) => { c.set("x", 1); });`,
        `app.use("/b/*", (c, next) => jwt({ secret: "s" })(c, next));`,
        `app.use("/c/*", (c) => c.text("terminal"));`,
        `app.get("/a/x", (c) => c.text("a"));`,
        ``,
      ].join("\n"),
    });
    const fnOf = (path: string) => idx.middlewares.find((m) => m.localPath === path)?.fn;
    expect(fnOf("/a/*")).toMatchObject({
      declaresNext: true,
      callsNext: false,
      passesNext: false,
      file: "src/app.ts",
    });
    expect(fnOf("/b/*")).toMatchObject({ declaresNext: true, callsNext: false, passesNext: true });
    expect(fnOf("/c/*")).toMatchObject({ declaresNext: false, callsNext: false });
  });

  it("names the file that defines a referenced middleware", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/mw.ts": `export const slow = async (c, next) => { next(); };\n`,
      "src/app.ts": `${HONO}import { slow } from "./mw.ts";\nexport const app = new Hono();\napp.use("*", slow);\n`,
    });
    expect(idx.middlewares[0].fn).toMatchObject({
      file: "src/mw.ts",
      callsNext: true,
      awaitsOrReturnsNext: false,
    });
  });
});

describe("handler facts: where the request goes", () => {
  it("flags a handler that hands the raw request, the request or the context to other code", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/app.ts": [
        HONO,
        `import { getCookie } from "hono/cookie";`,
        `declare const mcp: { fetch(r: Request): Response };`,
        `declare function parse(c: unknown): unknown;`,
        `export const app = new Hono();`,
        `app.post("/raw", (c) => mcp.fetch(c.req.raw));`,
        `app.post("/ctx", (c) => c.json(parse(c)));`,
        `app.post("/req", (c) => { const r = c.req; return c.json(String(r)); });`,
        `app.post("/ok", (c) => c.json({ s: getCookie(c, "s"), h: c.req.raw.headers.get("x"), m: c.req.method }));`,
        `app.post("/body", async (c) => c.json(await c.req.json()));`,
        ``,
      ].join("\n"),
    });
    const esc = Object.fromEntries(idx.routes.map((r) => [r.fullPath, r.handler?.requestEscapes]));
    expect(esc).toEqual({ "/raw": true, "/ctx": true, "/req": true, "/ok": false, "/body": false });
  });
});

describe("deprecated member access", () => {
  it("records c.req.routePath, c.req.matchedRoutes and app.fire() with their lines", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/app.ts": [
        HONO,
        `import { routePath } from "hono/route";`,
        `export const app = new Hono();`,
        `app.get("/a", (c) => c.text(c.req.routePath));`,
        `app.get("/b", (c) => c.json(c.req.matchedRoutes.length));`,
        `app.get("/c", (c) => c.text(routePath(c)));`,
        `const fire = { fire() {} };`,
        `fire.fire();`,
        `app.fire();`,
        ``,
      ].join("\n"),
    });
    expect(idx.facts.get("src/app.ts")?.deprecatedUses).toEqual([
      { api: "c.req.routePath", line: 5 },
      { api: "c.req.matchedRoutes", line: 6 },
      { api: "app.fire", line: 10 },
    ]);
  });
});

describe("composition.resolveFn", () => {
  it("follows a local name and an import to the function facts", async () => {
    const idx = await loadProject({
      "package.json": PKG,
      "src/errors.ts": `export const onFail = (err, c) => c.json({ error: err.message }, 500);\n`,
      "src/app.ts": `${HONO}import { onFail } from "./errors.ts";\nconst local = (err, c) => c.text("x");\nexport const app = new Hono();\napp.onError(onFail);\n`,
    });
    expect(idx.composition.resolveFn("src/app.ts", "onFail")?.leaksError).toBe(true);
    expect(idx.composition.resolveFn("src/app.ts", "local")?.leaksError).toBe(false);
    expect(idx.composition.resolveFn("src/app.ts", "missing")).toBeNull();
  });
});
