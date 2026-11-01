import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

const app = (...lines: string[]) =>
  project({
    "src/app.ts": src(HONO, "export const app = new Hono();", ...lines, "export default app;"),
  });

describe("M001 use() after the routes it targets", () => {
  const late = app(
    'app.get("/a", (c) => c.text("a"));',
    'app.use("*", async (c, next) => { await next(); });',
  );
  ruleCase("M001", {
    violating: late,
    fixed: app(
      'app.use("*", async (c, next) => { await next(); });',
      'app.get("/a", (c) => c.text("a"));',
    ),
    at: { file: "src/app.ts", line: 4 },
    message: /registered after routes it targets \(GET \/a\)/,
  });

  it("M001 is not the finding for a use() that follows a route() mount", async () => {
    await quiet("M002", late);
  });
});

describe("M002 parent use() after the route() mount", () => {
  const files = (useFirst: boolean) => {
    const use = 'app.use("*", async (c, next) => { await next(); });';
    const mount = 'app.route("/v1", child);';
    return project({
      "src/child.ts": src(
        HONO,
        "export const child = new Hono();",
        'child.get("/a", (c) => c.text("a"));',
      ),
      "src/app.ts": src(
        HONO,
        'import { child } from "./child.ts";',
        "export const app = new Hono();",
        ...(useFirst ? [use, mount] : [mount, use]),
        "export default app;",
      ),
    });
  };
  ruleCase("M002", {
    violating: files(false),
    fixed: files(true),
    at: { file: "src/app.ts", line: 5 },
    message: /comes after the route\(\) mount of 'child'/,
  });

  it("M002 leaves the same-instance case to M001", async () => {
    await quiet("M001", files(false));
  });
});

describe("M003 scoped middleware that matches no route", () => {
  const mw = 'app.use("/admin/*", async (c, next) => { await next(); });';
  ruleCase("M003", {
    violating: app(mw, 'app.get("/public", (c) => c.text("p"));'),
    fixed: app(mw, 'app.get("/admin/stats", (c) => c.text("s"));'),
    at: { file: "src/app.ts", line: 3 },
    message: /matches no route/,
  });

  it("M003 exempts serveStatic, which answers paths no route owns", async () => {
    await quiet(
      "M003",
      project({
        "src/app.ts": src(
          HONO,
          'import { serveStatic } from "@hono/node-server/serve-static";',
          "export const app = new Hono();",
          'app.use("/static/*", serveStatic({ root: "./public" }));',
          'app.get("/a", (c) => c.text("a"));',
          "export default app;",
        ),
      }),
    );
  });
});

describe("M004 middleware that never calls next()", () => {
  ruleCase("M004", {
    violating: app(
      'app.use("/x/*", async (c, next) => { c.set("seen", true); });',
      'app.get("/x/a", (c) => c.text("a"));',
    ),
    fixed: app(
      'app.use("/x/*", async (c, next) => { c.set("seen", true); await next(); });',
      'app.get("/x/a", (c) => c.text("a"));',
    ),
    at: { file: "src/app.ts", line: 3 },
    message: /never calls or forwards it/,
  });

  it("M004 accepts a middleware that hands next to another one", async () => {
    await quiet(
      "M004",
      project({
        "src/app.ts": src(
          HONO,
          'import { jwt } from "hono/jwt";',
          "export const app = new Hono();",
          'app.use("/x/*", (c, next) => jwt({ secret: String(c.env.S) })(c, next));',
          'app.get("/x/a", (c) => c.text("a"));',
          "export default app;",
        ),
      }),
    );
  });

  it("M004 does not call a use() handler without a next parameter a middleware bug", async () => {
    await quiet("M004", app('app.use("/x/*", (c) => c.text("maintenance", 503));'));
  });

  it("M004 reads inline route middleware too", async () => {
    await fires(
      "M004",
      app('app.get("/x", async (c, next) => { c.header("a", "b"); }, (c) => c.text("x"));'),
    );
  });
});

describe("M005 next() without await or return", () => {
  ruleCase("M005", {
    violating: app('app.use("*", async (c, next) => { next(); c.header("x-a", "1"); });'),
    fixed: app('app.use("*", async (c, next) => { await next(); c.header("x-a", "1"); });'),
    at: { file: "src/app.ts", line: 3 },
    message: /without await or return/,
  });

  it("M005 accepts return next()", async () => {
    await quiet("M005", app('app.use("*", (c, next) => { return next(); });'));
  });

  it("M005 reports a referenced middleware once, at the file that defines it", async () => {
    const files = project({
      "src/mw.ts": src("export const slow = async (c, next) => {", "  next();", "};"),
      "src/app.ts": src(
        HONO,
        'import { slow } from "./mw.ts";',
        "export const app = new Hono();",
        'app.use("/a/*", slow);',
        'app.use("/b/*", slow);',
        'app.get("/a/x", (c) => c.text("a"));',
        'app.get("/b/x", (c) => c.text("b"));',
        "export default app;",
      ),
    });
    const { hits } = await fires("M005", files);
    expect(hits.map((h) => [h.file, h.line])).toEqual([["src/mw.ts", 1]]);
  });
});

describe("M006 same middleware twice in one chain", () => {
  const log = (path: string) => `app.use("${path}", logger());`;
  const files = (second: string) =>
    project({
      "src/app.ts": src(
        HONO,
        'import { logger } from "hono/logger";',
        "export const app = new Hono();",
        log("*"),
        second,
        'app.get("/api/x", (c) => c.text("x"));',
        "export default app;",
      ),
    });
  ruleCase("M006", {
    violating: files(log("/api/*")),
    fixed: files(""),
    at: { file: "src/app.ts", line: 5 },
    message: /logger is already in the chain from src\/app\.ts:4/,
  });

  it("M006 tells two calls of one factory apart by their arguments", async () => {
    await quiet(
      "M006",
      project({
        "src/app.ts": src(
          HONO,
          "const requireRole = (r: string) => async (c, next) => { await next(); };",
          "export const app = new Hono();",
          'app.use("/api/*", requireRole("user"));',
          'app.use("/api/admin/*", requireRole("admin"));',
          'app.get("/api/admin/x", (c) => c.text("x"));',
          "export default app;",
        ),
      }),
    );
  });
});

describe("M007 cors after auth", () => {
  const auth = src("export const requireAuth = async (c, next) => { await next(); };");
  const files = (corsFirst: boolean) => {
    const order = ['app.use("*", cors());', 'app.use("/api/*", requireAuth);'];
    return project({
      "src/auth.ts": auth,
      "src/app.ts": src(
        HONO,
        'import { cors } from "hono/cors";',
        'import { requireAuth } from "./auth.ts";',
        "export const app = new Hono();",
        ...(corsFirst ? order : order.toReversed()),
        'app.get("/api/x", (c) => c.text("x"));',
        "export default app;",
      ),
    });
  };
  ruleCase("M007", {
    violating: files(false),
    fixed: files(true),
    at: { file: "src/app.ts", line: 6 },
    message: /cors\(\) runs after requireAuth on GET \/api\/x/,
  });

  it("M007 is an error, so the CLI exits 1 on it", async () => {
    const { hits, result } = await fires("M007", files(false));
    expect(hits[0].severity).toBe("error");
    expect(result.ok).toBe(false);
  });
});
