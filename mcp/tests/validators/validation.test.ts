import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, lineOf, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

const ZOD = [
  'import { zValidator } from "@hono/zod-validator";',
  'import { z } from "zod";',
  "const schema = z.object({ name: z.string() });",
];
const app = (...lines: string[]) =>
  project({
    "src/app.ts": src(
      HONO,
      ...ZOD,
      "export const app = new Hono();",
      ...lines,
      "export default app;",
    ),
  });

describe("V001 body read with no validator", () => {
  ruleCase("V001", {
    violating: app('app.post("/items", async (c) => c.json(await c.req.json()));'),
    fixed: app(
      'app.post("/items", zValidator("json", schema), (c) => c.json(c.req.valid("json")));',
    ),
    at: { file: "src/app.ts", line: 6 },
    message: /POST \/items reads the body with c\.req\.json\(\)/,
  });

  it("V001 covers PUT and PATCH with formData and parseBody", async () => {
    const { hits } = await fires(
      "V001",
      app(
        'app.put("/a", async (c) => c.json(Object.fromEntries(await c.req.formData())));',
        'app.patch("/b", async (c) => c.json(await c.req.parseBody()));',
      ),
    );
    expect(hits.map((h) => h.route)).toEqual(["PUT /a", "PATCH /b"]);
  });

  it("V001 leaves raw body reads (webhook signatures) and GET alone", async () => {
    await quiet(
      "V001",
      app(
        'app.post("/hook", async (c) => c.text(await c.req.text()));',
        'app.get("/x", async (c) => c.json(await c.req.json()));',
      ),
    );
  });

  it("V001 accepts a validator applied by a use() over the path", async () => {
    await quiet(
      "V001",
      app(
        'app.use("/items", zValidator("json", schema));',
        'app.post("/items", async (c) => c.json(await c.req.json()));',
      ),
    );
  });
});

describe("V002 body route that cannot be analysed", () => {
  const handler = src(
    "export const mcp = { fetch: (r: Request) => new Response(String(r.method)) };",
  );
  const files = (route: string) =>
    project({
      "src/mcp.ts": handler,
      "src/app.ts": src(
        HONO,
        ...ZOD,
        'import { mcp } from "./mcp.ts";',
        "export const app = new Hono();",
        route,
        "export default app;",
      ),
    });
  ruleCase("V002", {
    violating: files('app.post("/mcp", async (c) => mcp.fetch(c.req.raw));'),
    fixed: files(
      'app.post("/mcp", zValidator("json", schema), async (c) => mcp.fetch(c.req.raw));',
    ),
    at: {
      file: "src/app.ts",
      line: lineOf(
        files('app.post("/mcp", async (c) => mcp.fetch(c.req.raw));')["src/app.ts"],
        "app.post",
      ),
    },
    message: /hands the request to other code/,
  });

  it("V002 reports a handler imported from a package it cannot read", async () => {
    const { hits } = await fires(
      "V002",
      project({
        "src/app.ts": src(
          HONO,
          'import { handle } from "some-sdk";',
          "export const app = new Hono();",
          'app.post("/sdk", handle);',
          "export default app;",
        ),
      }),
    );
    expect(hits[0].confidence).toBe("inferred");
  });

  it("V002 stays quiet for a handler that ignores the body, and for ones V001 already reports", async () => {
    const files = app(
      'app.post("/ping", (c) => c.text("pong"));',
      'app.post("/items", async (c) => c.json(await c.req.json()));',
    );
    await quiet("V002", files);
    expect((await fires("V001", files)).hits).toHaveLength(1);
  });

  it("V002 does not take a Hono helper that receives the context for a body consumer", async () => {
    await quiet(
      "V002",
      project({
        "src/app.ts": src(
          HONO,
          'import { deleteCookie } from "hono/cookie";',
          "export const app = new Hono();",
          'app.post("/logout", (c) => { deleteCookie(c, "sid"); return c.text("bye"); });',
          "export default app;",
        ),
      }),
    );
  });
});

describe("V003 valid() with no validator", () => {
  ruleCase("V003", {
    violating: app('app.get("/a", (c) => c.json(c.req.valid("query")));'),
    fixed: app('app.get("/a", zValidator("query", schema), (c) => c.json(c.req.valid("query")));'),
    at: { file: "src/app.ts", line: 6 },
    message: /c\.req\.valid\('query'\) on GET \/a has no 'query' validator/,
  });

  it("V003 is an error", async () => {
    const { result } = await fires(
      "V003",
      app('app.get("/a", (c) => c.json(c.req.valid("query")));'),
    );
    expect(result.ok).toBe(false);
  });

  it("V003 asks for the validator of that target, not any validator", async () => {
    const { hits } = await fires(
      "V003",
      app('app.post("/a", zValidator("json", schema), (c) => c.json(c.req.valid("query")));'),
    );
    expect(hits[0].message).toMatch(/'query'/);
  });
});

describe("V004 json/form validator on a GET", () => {
  ruleCase("V004", {
    violating: app(
      'app.get("/a", zValidator("json", schema), (c) => c.json(c.req.valid("json")));',
    ),
    fixed: app('app.get("/a", zValidator("query", schema), (c) => c.json(c.req.valid("query")));'),
    at: { file: "src/app.ts", line: 6 },
    message: /zValidator\('json'\) guards GET \/a/,
  });
});

describe("V005 route params without a validator", () => {
  ruleCase("V005", {
    violating: app('app.get("/u/:id", (c) => c.text(c.req.param("id")));'),
    fixed: app(
      'app.get("/u/:id", zValidator("param", z.object({ id: z.string().uuid() })), (c) => c.text(c.req.valid("param").id));',
    ),
    at: { file: "src/app.ts", line: 6 },
    message: /reads route param id/,
  });
});
