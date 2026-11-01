import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps, loadFixture, loadProject, routeAt } from "../_helpers.ts";

afterAll(cleanupTemps);

const HONO = `import { Hono } from "hono";\n`;
const table = (idx: Awaited<ReturnType<typeof loadProject>>) =>
  idx.routes.map((r) => `${r.method} ${r.fullPath}`);

describe("composition: full composed paths", () => {
  it("resolves /v1/contacts/:id across two mount levels (what livespec stores as /:id)", async () => {
    const idx = await loadFixture("hono-mounted");
    const r = routeAt(idx, "GET", "/v1/contacts/:id");
    expect(r.localPath).toBe("/:id");
    expect(r.file).toBe("src/routes/v1/contacts.ts");
    expect(r.root).toBe("src/app.ts#app");
    expect(r.params).toEqual(["id"]);
    expect(r.mountChain.map((h) => [h.app, h.prefix])).toEqual([
      ["src/routes/v1/index.ts#v1", "/v1"],
      ["src/routes/v1/contacts.ts#contactRoutes", "/contacts"],
    ]);
    expect(routeAt(idx, "POST", "/v1/contacts/import").localPath).toBe("/import");
  });

  it("composes a three-level mount (/v1/admin/cms) and keeps parent middleware in the chain", async () => {
    const idx = await loadFixture("hono-mounted");
    const r = routeAt(idx, "POST", "/v1/admin/cms/modules");
    expect(r.mountChain).toHaveLength(3);
    expect(r.chain.map((c) => c.name)).toContain("authMiddleware");
    expect(r.validators.map((v) => [v.target, v.library, v.via])).toEqual([
      ["json", "zod", "zValidator"],
    ]);
  });

  it("serves basePath routes straight from the shared table", async () => {
    const idx = await loadFixture("hono-mounted");
    const r = routeAt(idx, "GET", "/api/ping");
    expect(r.app).toBe("src/app.ts#api");
    expect(r.mountChain.map((h) => h.prefix)).toEqual(["/api"]);
    const api = idx.apps.find((a) => a.id === "src/app.ts#api");
    expect(api?.ctor).toBe("derived");
    expect(api?.derivedFrom).toBe("src/app.ts#app");
    expect(api?.basePath).toBe("/api");
    expect(idx.mounts.some((m) => m.kind === "basePath" && m.child === "src/app.ts#api")).toBe(
      true,
    );
  });

  it("follows barrels: named, star and renamed default re-exports", async () => {
    const idx = await loadFixture("hono-mounted");
    expect(idx.routes.some((r) => r.fullPath === "/v1/reports/summary")).toBe(true);
    expect(idx.routes.some((r) => r.fullPath === "/v1/integrations/:provider")).toBe(true);
  });
});

describe("composition: proof case (mount order)", () => {
  it("google-calendar routes carry no auth; the integrations auth step is unreached", async () => {
    const idx = await loadFixture("hono-mounted");
    const cb = routeAt(idx, "GET", "/v1/integrations/google-calendar/callback");
    expect(cb.chain.some((c) => c.isAuth)).toBe(false);
    expect(cb.unreached.map((c) => [c.name, c.isAuth])).toEqual([
      ["authMiddleware", true],
      ["tenantMiddleware", false],
    ]);
    const sibling = routeAt(idx, "GET", "/v1/integrations/:provider");
    expect(sibling.chain.some((c) => c.isAuth)).toBe(true);
    expect(sibling.unreached).toEqual([]);
  });

  it("does not flag the intentional ordering as middleware registered after its routes", async () => {
    const idx = await loadFixture("hono-mounted");
    const auth = idx.middlewares.find((m) => m.fullPath === "/v1/integrations/*" && m.isAuth);
    expect(auth?.registeredAfterRoutes).toEqual([]);
  });
});

describe("composition: table semantics (docs/adr/0002)", () => {
  it("copies the child table at route() time: later child routes are stranded", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/child.ts": `${HONO}export const child = new Hono();\nchild.get("/early", (c) => c.text("a"));\n`,
      "src/app.ts": `${HONO}import { child } from "./child.ts";\nexport const app = new Hono();\napp.route("/c", child);\nchild.get("/late", (c) => c.text("b"));\nexport default app;\n`,
    });
    expect(table(idx)).toContain("GET /c/early");
    const late = idx.routes.find((r) => r.fullPath === "/c/late");
    expect(late?.reachable).toBe(false);
    expect(late?.notes.join(" ")).toMatch(/after 'child' was mounted/);
    expect(idx.composition.stranded).toHaveLength(1);
    expect(idx.roots).toEqual(["src/app.ts#app"]);
  });

  it("evaluates imported modules first, depth-first in import order", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/b.ts": `${HONO}export const b = new Hono();\nb.get("/b", (c) => c.text("b"));\n`,
      "src/a.ts": `${HONO}export const a = new Hono();\na.get("/a", (c) => c.text("a"));\n`,
      "src/app.ts": `${HONO}import { b } from "./b.ts";\nimport { a } from "./a.ts";\nexport const app = new Hono();\napp.route("/", a);\napp.route("/", b);\nexport default app;\n`,
    });
    expect(table(idx)).toEqual(["GET /a", "GET /b"]);
  });

  it("merges prefixes with hono's mergePath (trailing slash, root mount)", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}const sub = new Hono();\nsub.get("/", (c) => c.text("root"));\nsub.get("/x/", (c) => c.text("x"));\nexport const app = new Hono();\napp.route("/", sub);\nconst api = new Hono().basePath("/api/");\napi.get("/y", (c) => c.text("y"));\napp.route("/v2", api);\nexport default app;\n`,
    });
    expect(table(idx)).toEqual(["GET /", "GET /x/", "GET /v2/api/y"]);
  });

  it("emits one middleware entry per function, and a sticky path for chained verbs", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}const a = async (c, next) => { await next(); };\nconst b = async (c, next) => { await next(); };\nexport const app = new Hono();\napp.use("/x/*", a, b);\napp.get("/x/y", (c) => c.text("1"));\napp.on(["PUT", "POST"], ["/m", "/n"], (c) => c.text("2"));\nexport default app;\n`,
    });
    expect(idx.middlewares.map((m) => [m.name, m.fullPath])).toEqual([
      ["a", "/x/*"],
      ["b", "/x/*"],
    ]);
    // hono-base.js:51-60 — paths outer, methods inner
    expect(table(idx)).toEqual(["GET /x/y", "PUT /m", "POST /m", "PUT /n", "POST /n"]);
  });

  it("clones the error handler at basePath() time and wraps only at route() time", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}const early = new Hono();\nearly.onError((e, c) => c.text("early", 500));\nearly.get("/e", (c) => c.text("e"));\nconst late = new Hono();\nlate.get("/l", (c) => c.text("l"));\nexport const app = new Hono();\napp.onError((e, c) => c.text("root", 500));\napp.route("/early", early);\napp.route("/late", late);\nlate.onError((e, c) => c.text("too late", 500));\nexport default app;\n`,
    });
    expect(routeAt(idx, "GET", "/early/e").errorHandler?.line).toBe(3);
    // the late handler was set after route(): the copied entries fall back to the root handler
    expect(routeAt(idx, "GET", "/late/l").errorHandler?.line).toBe(8);
  });

  it("records mount() as an ALL entry at <prefix>/*", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}export const app = new Hono();\napp.mount("/legacy", (req) => new Response("x"));\nexport default app;\n`,
    });
    const m = idx.routes[0];
    expect([m.kind, m.method, m.fullPath]).toEqual(["mount", "ALL", "/legacy/*"]);
  });

  it("handles openapi(createRoute) with a same-module literal, converting {id} to :id", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16","@hono/zod-openapi":"1.6.3"}}`,
      "src/app.ts": `import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";\nconst getUser = createRoute({ method: "get", path: "/users/{id}", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "ok" } } });\nexport const app = new OpenAPIHono();\napp.openapi(getUser, (c) => c.json({ id: c.req.valid("param").id }));\napp.doc("/doc", { openapi: "3.0.0", info: { title: "t", version: "1" } });\nexport default app;\n`,
    });
    const r = routeAt(idx, "GET", "/users/:id");
    expect(r.openapi).toBe(true);
    expect(r.validators.map((v) => [v.target, v.via])).toEqual([["param", "openapi"]]);
    expect(idx.apps[0].ctor).toBe("OpenAPIHono");
    expect(table(idx)).toContain("GET /doc");
  });

  it("composes an inline sub-app and an aliased chained instance", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}export const app = new Hono();\napp.route("/inline", new Hono().get("/a", (c) => c.text("a")));\nconst chained = app.get("/b", (c) => c.text("b"));\nchained.get("/c", (c) => c.text("c"));\nexport default app;\n`,
    });
    expect(table(idx)).toEqual(["GET /inline/a", "GET /b", "GET /c"]);
  });

  it("reports an unresolvable route() child instead of dropping it silently", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}import { make } from "./make.ts";\nexport const app = new Hono();\napp.route("/x", make());\nexport default app;\n`,
      "src/make.ts": `export const make = () => null;\n`,
    });
    expect(idx.skipped.some((s) => s.reason.includes("compose:") && s.reason.includes("/x"))).toBe(
      true,
    );
  });

  it("flags non-literal paths and leaves them out of matching", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}const PREFIX = "/known";\nexport const app = new Hono();\napp.get(PREFIX + "/a", (c) => c.text("a"));\napp.get(\`/dyn/\${process.argv[2]}\`, (c) => c.text("b"));\nexport default app;\n`,
    });
    const [lit, dyn] = idx.routes;
    expect([lit.fullPath, lit.pathNonLiteral]).toEqual(["/known/a", false]);
    expect(dyn.pathNonLiteral).toBe(true);
    expect(dyn.confidence).toBe("inferred");
  });

  it("marks tables nobody serves as orphans (root null) when a served app exists", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/orphan.ts": `${HONO}export const orphan = new Hono();\norphan.get("/lost", (c) => c.text("x"));\n`,
      "src/app.ts": `${HONO}import "./orphan.ts";\nexport const app = new Hono();\napp.get("/ok", (c) => c.text("x"));\nexport default app;\n`,
    });
    const lost = idx.routes.find((r) => r.fullPath === "/lost");
    expect(lost?.root).toBeNull();
    expect(lost?.reachable).toBe(false);
    expect(routeAt(idx, "GET", "/ok").reachable).toBe(true);
  });
});

describe("composition: handler facts", () => {
  it("records body reads, valid reads, params, db access and env reads", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16","@prisma/client":"6.0.0"}}`,
      "src/db.ts": `import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();\n`,
      "src/services/s.ts": `import { prisma } from "../db.ts";\nexport const list = () => prisma.user.findMany();\n`,
      "src/services/direct.ts": `import { PrismaClient } from "@prisma/client";\nconst p = new PrismaClient();\nexport const listDirect = () => p.user.findMany();\n`,
      "src/app.ts": `${HONO}import { prisma } from "./db.ts";\nimport { list } from "./services/s.ts";\nimport { listDirect } from "./services/direct.ts";\nexport const app = new Hono();\napp.post("/u/:id", async (c) => {\n  const body = await c.req.json();\n  const id = c.req.param("id");\n  const q = c.req.query("q");\n  const rows = await prisma.user.findMany();\n  const more = await list();\n  const direct = await listDirect();\n  return c.json({ body, id, q, rows, more, direct, k: process.env.API_KEY });\n});\nexport default app;\n`,
    });
    const h = routeAt(idx, "POST", "/u/:id").handler;
    expect(h?.kind).toBe("inline");
    expect(h?.bodyReads.map((b) => b.api)).toEqual(["json"]);
    expect(h?.paramReads.map((p) => p.name)).toEqual(["id"]);
    expect(h?.queryReads.map((p) => p.name)).toEqual(["q"]);
    expect(h?.dbAccess.map((d) => [d.via, d.source])).toEqual([
      ["prisma.user.findMany", "src/db.ts"],
      ["listDirect", "src/services/direct.ts"],
    ]);
    expect(h?.envReads.map((e) => [e.key, e.api, e.validated])).toEqual([
      ["API_KEY", "process.env", false],
    ]);
    // a module that only imports the DB module is not itself a DB module: `list()` is not flagged
    expect([...idx.dbModules].sort()).toEqual(["src/db.ts", "src/services/direct.ts"]);
  });

  it("resolves an identifier handler to its function body, one import away", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/handlers.ts": `export async function create(c) { return c.json(await c.req.formData()); }\n`,
      "src/app.ts": `${HONO}import { create } from "./handlers.ts";\nexport const app = new Hono();\napp.post("/x", create);\nexport default app;\n`,
    });
    const h = routeAt(idx, "POST", "/x").handler;
    expect(h?.kind).toBe("identifier");
    expect(h?.resolved).toBe("src/handlers.ts#create");
    expect(h?.bodyReads.map((b) => b.api)).toEqual(["formData"]);
  });

  it("reads inline middleware next() usage", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `${HONO}export const app = new Hono();\napp.use("/a/*", async (c, next) => { await next(); });\napp.use("/b/*", async (c, next) => { next(); });\napp.use("/c/*", async (c) => { c.header("x", "1"); });\nexport default app;\n`,
    });
    expect(idx.middlewares.map((m) => m.fn && [m.fn.callsNext, m.fn.awaitsOrReturnsNext])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    expect(idx.middlewares.every((m) => m.kind === "inline")).toBe(true);
  });

  it("reads literal options of builtin middleware as LiteralValue", async () => {
    const idx = await loadFixture("hono-mounted");
    const cors = idx.middlewares.find((m) => m.name === "cors");
    expect(cors?.source).toBe("hono/cors");
    expect(cors?.kind).toBe("builtin");
    expect(cors?.options).toEqual({ origin: ["https://app.example.com"], credentials: true });
  });
});
