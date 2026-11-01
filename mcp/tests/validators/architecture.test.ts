import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

describe("A001 handler touching the database", () => {
  const db = src(
    'import { PrismaClient } from "@prisma/client";',
    "export const db = new PrismaClient();",
  );
  const app = (...lines: string[]) =>
    src(HONO, 'import { db } from "./db.ts";', ...lines, "export default app;");
  const direct = app(
    "export const app = new Hono();",
    'app.get("/users", async (c) => c.json(await db.user.findMany()));',
  );
  const service = (dir: string) => ({
    // the service opens the client itself, so it is a DB module and a handler calling it is "direct"
    [`${dir}/user.service.ts`]: src(
      'import { PrismaClient } from "@prisma/client";',
      "const db = new PrismaClient();",
      "export const listUsers = () => db.user.findMany();",
    ),
    "src/app.ts": src(
      HONO,
      `import { listUsers } from "./${dir.replace("src/", "")}/user.service.ts";`,
      "export const app = new Hono();",
      'app.get("/users", async (c) => c.json(await listUsers()));',
      "export default app;",
    ),
  });
  ruleCase("A001", {
    violating: project({ "src/db.ts": db, "src/app.ts": direct }),
    fixed: project({ "src/db.ts": db, ...service("src/services") }),
    at: { file: "src/app.ts", line: 4 },
    message: /GET \/users calls the database itself \(db\.user\.findMany, from src\/db\.ts\)/,
  });

  it("A001 exempts the directories config.serviceDirs names, and only those", async () => {
    const files = { "src/db.ts": db, ...service("src/domain") };
    await fires("A001", project(files));
    await quiet(
      "A001",
      project({ ...files, ".hono-dev/config.json": '{"serviceDirs":["src/domain"]}' }),
    );
  });

  it("A001 counts a route module that opens the client itself", async () => {
    const { hits } = await fires(
      "A001",
      project({
        "src/app.ts": src(
          HONO,
          'import { PrismaClient } from "@prisma/client";',
          "const db = new PrismaClient();",
          "export const app = new Hono();",
          'app.get("/n", async (c) => c.json(await db.user.count()));',
          "export default app;",
        ),
      }),
    );
    expect(hits[0].message).toMatch(/from src\/app\.ts/);
  });
});

describe("A002 and A003 root app handlers", () => {
  const root = (...lines: string[]) =>
    project({
      "src/app.ts": src(
        HONO,
        "export const app = new Hono();",
        'app.get("/a", (c) => c.text("a"));',
        ...lines,
        "export default app;",
      ),
    });
  const onError = "app.onError((err, c) => { console.error(err); return c.text('boom', 500); });";
  const notFound = "app.notFound((c) => c.json({ error: 'Not found' }, 404));";

  ruleCase("A002", {
    violating: root(),
    fixed: root(onError),
    at: { file: "src/app.ts", line: 2 },
    message: /'app' is served but never calls onError/,
  });
  ruleCase("A003", {
    violating: root(onError),
    fixed: root(onError, notFound),
    at: { file: "src/app.ts", line: 2 },
    message: /never calls notFound/,
  });

  it("A002 does not fire on a root app that calls onError", async () => {
    await quiet("A002", root(onError, notFound));
    await quiet("A003", root(onError, notFound));
  });

  it("A002 asks only the app that is served, not a sub-app or an unserved helper", async () => {
    await quiet(
      "A002",
      project({
        "src/child.ts": src(
          HONO,
          "export const child = new Hono();",
          'child.get("/c", (c) => c.text("c"));',
        ),
        "src/app.ts": src(
          HONO,
          'import { child } from "./child.ts";',
          "export const app = new Hono();",
          'app.route("/c", child);',
          "app.onError((err, c) => c.text('boom', 500));",
          "export default app;",
        ),
      }),
    );
  });

  it("A002 accepts onError set on the instance that is exported when it is a basePath clone", async () => {
    await quiet(
      "A002",
      project({
        "src/app.ts": src(
          HONO,
          "const root = new Hono();",
          'root.get("/a", (c) => c.text("a"));',
          'const api = root.basePath("/api");',
          "api.onError((err, c) => c.text('boom', 500));",
          "export default api;",
        ),
      }),
    );
  });
});

describe("A004 import cycle between route modules", () => {
  const files = (cycle: boolean) =>
    project({
      "src/a.ts": src(
        HONO,
        'import { b } from "./b.ts";',
        "export const a = new Hono();",
        'a.get("/a", (c) => c.text("a"));',
        'a.route("/b", b);',
      ),
      "src/b.ts": src(
        HONO,
        ...(cycle ? ['import { a } from "./a.ts";'] : []),
        "export const b = new Hono();",
        `b.get("/b", (c) => c.json(${cycle ? "Object.keys(a)" : "[]"}));`,
      ),
      "src/app.ts": src(
        HONO,
        'import { a } from "./a.ts";',
        "export const app = new Hono();",
        'app.route("/a", a);',
        "export default app;",
      ),
    });
  ruleCase("A004", {
    violating: files(true),
    fixed: files(false),
    at: { file: "src/a.ts", line: 2 },
    message: /src\/a\.ts -> src\/b\.ts -> src\/a\.ts/,
  });

  it("A004 is slow: the fast option skips it", async () => {
    await quiet("A004", files(true), { fast: true });
  });

  it("A004 ignores type-only imports, which never run", async () => {
    const cyclic = files(true);
    cyclic["src/b.ts"] = cyclic["src/b.ts"].replace(
      'import { a } from "./a.ts";',
      'import type { a } from "./a.ts";',
    );
    await quiet("A004", cyclic);
  });
});
