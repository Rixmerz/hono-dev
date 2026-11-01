import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

describe("P001 app type from a non-chained instance", () => {
  const files = (chained: boolean) =>
    project({
      "src/app.ts": chained
        ? src(
            HONO,
            'export const app = new Hono().get("/a", (c) => c.json({ a: 1 }, 200));',
            "export type AppType = typeof app;",
            "export default app;",
          )
        : src(
            HONO,
            "export const app = new Hono();",
            'app.get("/a", (c) => c.json({ a: 1 }, 200));',
            "export type AppType = typeof app;",
            "export default app;",
          ),
    });
  ruleCase("P001", {
    violating: files(false),
    fixed: files(true),
    at: { file: "src/app.ts", line: 4 },
    message: /AppType is typeof 'app'/,
  });

  it("P001 also catches a route() whose result is thrown away", async () => {
    const { hits } = await fires(
      "P001",
      project({
        "src/contacts.ts": src(
          HONO,
          'export const contacts = new Hono().get("/", (c) => c.json([], 200));',
        ),
        "src/app.ts": src(
          HONO,
          'import { contacts } from "./contacts.ts";',
          "export const app = new Hono();",
          'app.route("/contacts", contacts);',
          "export type AppType = typeof app;",
          "export default app;",
        ),
      }),
    );
    expect(hits).toHaveLength(1);
  });

  it("P001 has nothing to say about an app type with no routes at all", async () => {
    await quiet(
      "P001",
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          "export type AppType = typeof app;",
        ),
      }),
    );
  });
});

describe("P002 hc() typed with something that is not an app type", () => {
  const app = src(
    HONO,
    'export const app = new Hono().get("/a", (c) => c.json({ a: 1 }, 200));',
    "export type AppType = typeof app;",
    "export default app;",
  );
  const files = (typeArg: string, extra = "") =>
    project({
      "src/app.ts": app,
      "src/client.ts": src(
        'import { hc } from "hono/client";',
        'import type { AppType } from "./app.ts";',
        extra,
        `export const client = hc<${typeArg}>("http://localhost:3000");`,
      ),
    });
  ruleCase("P002", {
    violating: files("Api", "type Api = { routes: string[] };"),
    fixed: files("AppType"),
    at: { file: "src/client.ts", line: 4 },
    message: /hc<Api>\(\)/,
  });

  it("P002 leaves a type imported from another package alone", async () => {
    await quiet(
      "P002",
      project({
        "src/client.ts": src(
          'import { hc } from "hono/client";',
          'import type { AppType } from "@acme/api";',
          'export const client = hc<AppType>("http://localhost:3000");',
        ),
      }),
    );
  });

  it("P002 accepts typeof a Hono instance", async () => {
    await quiet(
      "P002",
      project({
        "src/app.ts": app,
        "src/client.ts": src(
          'import { hc } from "hono/client";',
          'import { app } from "./app.ts";',
          'export const client = hc<typeof app>("http://localhost:3000");',
        ),
      }),
    );
    expect(true).toBe(true);
  });
});
