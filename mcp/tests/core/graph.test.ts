import { afterAll, describe, expect, it } from "vitest";
import { matchesSpecifier } from "../../core/graph.ts";
import { cleanupTemps, loadFixture, loadProject } from "../_helpers.ts";

afterAll(cleanupTemps);

describe("import graph", () => {
  it("links local imports in both directions and separates externals", async () => {
    const idx = await loadFixture("hono-mounted");
    const g = idx.graph;
    expect(g.importsOf.get("src/routes/v1/index.ts")?.map((i) => i.target)).toEqual([
      "src/routes/barrel.ts",
    ]);
    expect(g.importedBy.get("src/middleware/auth.ts")?.sort()).toEqual([
      "src/routes/v1/admin.ts",
      "src/routes/v1/contacts.ts",
      "src/routes/v1/integrations.ts",
    ]);
    const ext = g.externalsOf.get("src/app.ts")?.map((e) => e.canonical);
    expect(ext).toEqual([
      "hono",
      "hono/cors",
      "hono/http-exception",
      "hono/logger",
      "hono/secure-headers",
    ]);
    expect(g.unresolved).toEqual([]);
  });

  it("counts barrel re-exports as imports and keeps type-only imports typed", async () => {
    const idx = await loadFixture("hono-mounted");
    expect(idx.graph.importsOf.get("src/routes/barrel.ts")?.length).toBe(5);
    const client = idx.graph.importsOf.get("src/rpc/client.ts");
    expect(client).toEqual([{ target: "src/rpc/api.ts", line: 2, dynamic: false, typeOnly: true }]);
  });

  it("records unresolved relative imports with a reason", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"4.13.16"}}`,
      "src/app.ts": `import "./gone.ts";\nimport { Hono } from "hono";\nexport const app = new Hono();\n`,
    });
    expect(idx.graph.unresolved).toEqual([
      { file: "src/app.ts", specifier: "./gone.ts", line: 1, reason: "file not found" },
    ]);
  });

  it("indexes dynamic imports", async () => {
    const idx = await loadProject({
      "src/a.ts": `export const a = 1;\n`,
      "src/b.ts": `export async function load() { return import("./a.ts"); }\n`,
    });
    expect(idx.graph.importsOf.get("src/b.ts")).toEqual([
      { target: "src/a.ts", line: 1, dynamic: true, typeOnly: false },
    ]);
  });
});

describe("dbModules", () => {
  it("lists files importing a DB client, canonicalised and with subpaths", async () => {
    const idx = await loadProject({
      "deno.json": `{"imports":{"prisma-client":"npm:@prisma/client@6","drizzle":"npm:drizzle-orm@0.4"}}`,
      "src/a.ts": `import { PrismaClient } from "prisma-client";\nexport const a = new PrismaClient();\n`,
      "src/b.ts": `import { drizzle } from "drizzle-orm/node-postgres";\nexport const b = drizzle;\n`,
      "src/c.ts": `import type { PrismaClient } from "@prisma/client";\nexport type C = PrismaClient;\n`,
      "src/d.ts": `import pg from "pg";\nexport const d = pg;\n`,
      "src/e.ts": `import { x } from "my-orm";\nexport const e = x;\n`,
      "src/f.ts": `import { z } from "zod";\nexport const f = z;\n`,
      "src/g.test.ts": `import pg from "pg";\nexport const g = pg;\n`,
      ".hono-dev/config.json": `{"dbSpecifiers":["my-orm"]}`,
    });
    expect([...idx.dbModules].sort()).toEqual(["src/a.ts", "src/b.ts", "src/d.ts", "src/e.ts"]);
  });

  it("matches packages and their subpaths, not look-alikes", () => {
    expect(matchesSpecifier("@prisma/client/runtime", ["@prisma/client"])).toBe("@prisma/client");
    expect(matchesSpecifier("pg-promise", ["pg"])).toBeNull();
    expect(matchesSpecifier("postgres", ["postgres"])).toBe("postgres");
  });
});
