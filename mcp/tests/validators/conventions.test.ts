import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

const NODE_PKG = `{"dependencies":{"hono":"4.13.16","@hono/node-server":"2.1.5"}}`;
const node = (...lines: string[]) => ({
  "package.json": NODE_PKG,
  "src/app.ts": src(HONO, "export const app = new Hono();", ...lines, "export default app;"),
});
const workers = (wrangler: string, ...lines: string[]) => ({
  "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
  "wrangler.jsonc": wrangler,
  "src/app.ts": src(HONO, "export const app = new Hono();", ...lines, "export default app;"),
});

describe("C001 Deno.env on Node", () => {
  ruleCase("C001", {
    violating: node('export const secret = Deno.env.get("PORT");'),
    fixed: node("export const secret = process.env.PORT;"),
    at: { file: "src/app.ts", line: 3 },
    message: /Deno\.env\.get is read 1 time here but the project runs on node/,
  });
});

describe("C001 c.env on Node", () => {
  ruleCase("C001", {
    violating: node('app.get("/x", (c) => c.text(String(c.env.GREETING)));'),
    fixed: node('app.get("/x", (c) => c.text(String(process.env.GREETING)));'),
    at: { file: "src/app.ts", line: 3 },
    message: /c\.env is read 1 time here but the project runs on node/,
  });

  it("C001 leaves the bindings the node server itself provides", async () => {
    await quiet(
      "C001",
      project(node('app.get("/ip", (c) => c.text(String(c.env.incoming.socket.remoteAddress)));')),
    );
  });
});

describe("C001 process.env on Workers", () => {
  const cfg = (extra: string) =>
    `{ "name": "w", "main": "src/app.ts", "compatibility_date": "2026-01-01"${extra} }`;
  const read = "export const greeting = process.env.GREETING;";
  ruleCase("C001", {
    violating: workers(cfg(""), read),
    fixed: workers(cfg(', "compatibility_flags": ["nodejs_compat"]'), read),
    at: { file: "src/app.ts", line: 3 },
    message: /process\.env is read 1 time here but the project runs on cloudflare-workers/,
  });

  it("C001 knows nodejs_compat is on by default from compatibility_date 2026-08-04", async () => {
    await quiet("C001", workers(cfg("").replace("2026-01-01", "2026-08-04"), read));
    await fires("C001", workers(cfg("").replace("2026-01-01", "2026-08-03"), read));
  });

  it("C001 respects no_nodejs_compat even on a new date", async () => {
    const off = cfg(', "compatibility_flags": ["no_nodejs_compat"]').replace(
      "2026-01-01",
      "2026-09-01",
    );
    await fires("C001", workers(off, read));
  });

  it("C001 reads a wrangler.toml too", async () => {
    const files = {
      ...workers("{}", read),
      "wrangler.toml":
        'name = "w"\ncompatibility_date = "2026-01-01"\ncompatibility_flags = ["nodejs_compat"]\n',
    };
    delete (files as Record<string, string>)["wrangler.jsonc"];
    await quiet("C001", files);
  });

  it("C001 makes no claim about a project that mixes runtimes", async () => {
    await quiet("C001", { ...workers(cfg(""), read), "package.json": NODE_PKG });
  });
});

describe("C002 two Hono copies", () => {
  const files = (importLine: string) => ({
    "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
    "deno.json": '{"imports":{"hono":"npm:hono@4"}}',
    "src/app.ts": src(importLine, "export const app = new Hono();", "export default app;"),
  });
  ruleCase("C002", {
    violating: files('import { Hono } from "jsr:@hono/hono@4";'),
    fixed: files('import { Hono } from "hono";'),
    at: { file: "src/app.ts", line: 1 },
    message: /two copies of Hono/,
  });

  it("C002 reads the import map when no source names the second copy", async () => {
    const { hits } = await fires("C002", {
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "deno.json": '{"imports":{"hono":"npm:hono@4","@hono/hono":"jsr:@hono/hono@4"}}',
      "src/app.ts": src(HONO, "export const app = new Hono();"),
    });
    expect(hits[0].file).toBe("deno.json");
  });
});

describe("C003 deprecated APIs", () => {
  describe("app.mount()", () => {
    ruleCase("C003", {
      violating: project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          'app.mount("/legacy", (r: Request) => new Response(r.url));',
        ),
      }),
      fixed: project({
        "src/app.ts": src(
          HONO,
          'import { mount } from "hono/mount";',
          "export const app = new Hono();",
          'app.all("/legacy/*", mount((r: Request) => new Response(r.url)));',
        ),
      }),
      at: { file: "src/app.ts", line: 3 },
      message: /app\.mount\(\) is deprecated/,
    });
  });

  describe("c.req.routePath", () => {
    ruleCase("C003", {
      violating: project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          'app.get("/a", (c) => c.text(c.req.routePath));',
        ),
      }),
      fixed: project({
        "src/app.ts": src(
          HONO,
          'import { routePath } from "hono/route";',
          "export const app = new Hono();",
          'app.get("/a", (c) => c.text(routePath(c)));',
        ),
      }),
      at: { file: "src/app.ts", line: 3 },
      message: /c\.req\.routePath is deprecated/,
    });
  });

  describe("an adapter that moved to its own package", () => {
    const handler = (from: string) =>
      project({
        "src/app.ts": src(
          HONO,
          `import { handle } from "${from}";`,
          "export const app = new Hono();",
          "export default handle(app);",
        ),
      });
    ruleCase("C003", {
      violating: handler("hono/vercel"),
      fixed: handler("@hono/vercel"),
      at: { file: "src/app.ts", line: 2 },
      message: /the 'hono\/vercel' adapter is deprecated/,
    });
  });

  describe("bearerAuth message options", () => {
    const use = (opts: string) =>
      project({
        "src/app.ts": src(
          HONO,
          'import { bearerAuth } from "hono/bearer-auth";',
          "export const app = new Hono();",
          `app.use("/a/*", bearerAuth({ verifyToken: async () => true, ${opts} }));`,
        ),
      });
    ruleCase("C003", {
      violating: use('invalidTokenMessage: "nope"'),
      fixed: use('invalidToken: { message: "nope" }'),
      at: { file: "src/app.ts", line: 4 },
      message: /the bearerAuth\(\) option 'invalidTokenMessage'/,
    });
  });

  it("C003 reports app.fire() on a Hono instance and not on anything else", async () => {
    const { hits } = await fires(
      "C003",
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          "const timer = { fire() {} };",
          "timer.fire();",
          "app.fire();",
        ),
      }),
    );
    expect(hits.map((f) => [f.line, f.message.split(" is ")[0]])).toEqual([[5, "app.fire"]]);
  });

  it("C003 does not read deprecation out of strings and comments", async () => {
    await quiet(
      "C003",
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          '// c.req.routePath is deprecated; app.mount("/x", h) too',
          'export const note = "c.req.routePath";',
        ),
      }),
    );
  });
});

describe("C004 route module with no test", () => {
  const app = src(
    HONO,
    "export const app = new Hono();",
    'app.get("/items", (c) => c.json([]));',
    "export default app;",
  );
  const test = (body: string) => src('import { it } from "vitest";', body);
  ruleCase("C004", {
    violating: project({ "src/app.ts": app }),
    fixed: project({
      "src/app.ts": app,
      "src/app.test.ts": test(
        'it("lists", async () => { await fetch("http://localhost:3000/items"); });',
      ),
    }),
    at: { file: "src/app.ts", line: 3 },
    message: /no test imports this module or mentions its paths \(\/items\)/,
  });

  it("C004 counts a test that imports the module even without naming a path", async () => {
    await quiet(
      "C004",
      project({
        "src/app.ts": app,
        "src/app.test.ts": src(
          'import { it } from "vitest";',
          'import { app } from "./app.ts";',
          'it("loads", () => { void app; });',
        ),
      }),
    );
  });

  it("C004 is slow: the fast option skips it", async () => {
    await quiet("C004", project({ "src/app.ts": app }), { fast: true });
  });
});
