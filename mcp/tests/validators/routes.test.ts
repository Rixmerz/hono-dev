import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, lineOf, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

describe("R001 duplicate registration", () => {
  const dup = src(
    HONO,
    "export const app = new Hono();",
    'app.get("/x", (c) => c.text("first"));',
    'app.get("/x", (c) => c.text("second"));',
    "export default app;",
  );
  ruleCase("R001", {
    violating: project({ "src/app.ts": dup }),
    fixed: project({
      "src/app.ts": dup.replace(
        'app.get("/x", (c) => c.text("second"))',
        'app.post("/x", (c) => c.text("second"))',
      ),
    }),
    at: { file: "src/app.ts", line: lineOf(dup, '"second"') },
    message: /GET \/x is already registered at src\/app\.ts:3/,
  });

  it("R001 ignores an if/else pair that registers the same route", async () => {
    await quiet(
      "R001",
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          "if (process.env.DEV) {",
          '  app.get("/x", (c) => c.text("dev"));',
          "} else {",
          '  app.get("/x", (c) => c.text("prod"));',
          "}",
          "export default app;",
        ),
      }),
    );
  });

  it("R001 sees the duplicate that appears only after composition", async () => {
    const { hits } = await fires(
      "R001",
      project({
        "src/users.ts": src(
          HONO,
          "export const users = new Hono();",
          'users.get("/me", (c) => c.text("a"));',
        ),
        "src/app.ts": src(
          HONO,
          'import { users } from "./users.ts";',
          "export const app = new Hono();",
          'app.get("/people/me", (c) => c.text("b"));',
          'app.route("/people", users);',
          "export default app;",
        ),
      }),
    );
    expect(hits[0].route).toBe("GET /people/me");
  });
});

describe("R002 shadowed static route", () => {
  const shadowed = src(
    HONO,
    "export const app = new Hono();",
    'app.get("/users/:id", (c) => c.text("by id"));',
    'app.get("/users/me", (c) => c.text("me"));',
    "export default app;",
  );
  ruleCase("R002", {
    violating: project({ "src/app.ts": shadowed }),
    fixed: project({
      "src/app.ts": src(
        HONO,
        "export const app = new Hono();",
        'app.get("/users/me", (c) => c.text("me"));',
        'app.get("/users/:id", (c) => c.text("by id"));',
        "export default app;",
      ),
    }),
    at: { file: "src/app.ts", line: 3 },
    message: /GET \/users\/:id is registered before GET \/users\/me/,
  });

  it("R002 leaves a constrained param that cannot match the static path", async () => {
    await quiet(
      "R002",
      project({
        "src/app.ts": shadowed.replace("/users/:id", "/users/:id{[0-9]+}"),
      }),
    );
  });
});

describe("R003 route added after the mount", () => {
  const files = (late: boolean) =>
    project({
      "src/child.ts": src(
        HONO,
        "export const child = new Hono();",
        'child.get("/a", (c) => c.text("a"));',
      ),
      "src/app.ts": src(
        HONO,
        'import { child } from "./child.ts";',
        "export const app = new Hono();",
        ...(late
          ? ['app.route("/p", child);', 'child.get("/late", (c) => c.text("late"));']
          : ['child.get("/late", (c) => c.text("late"));', 'app.route("/p", child);']),
        "export default app;",
      ),
    });
  ruleCase("R003", {
    violating: files(true),
    fixed: files(false),
    at: { file: "src/app.ts", line: 5 },
    message: /GET \/p\/late is added to 'child' after route\(\) mounted it/,
  });
});

describe("R004 instance nobody mounts or serves", () => {
  const orphan = src(
    HONO,
    "export const orphan = new Hono();",
    'orphan.get("/o", (c) => c.text("o"));',
  );
  const app = (mount: boolean) =>
    src(
      HONO,
      ...(mount ? ['import { orphan } from "./orphan.ts";'] : []),
      "export const app = new Hono();",
      'app.get("/a", (c) => c.text("a"));',
      ...(mount ? ['app.route("/o", orphan);'] : []),
      "export default app;",
    );
  ruleCase("R004", {
    violating: project({ "src/orphan.ts": orphan, "src/app.ts": app(false) }),
    fixed: project({ "src/orphan.ts": orphan, "src/app.ts": app(true) }),
    at: { file: "src/orphan.ts", line: 2 },
    message: /'orphan' registers 1 route \(GET \/o\)/,
  });
});

describe("R005 non-literal path", () => {
  // the project source holds template literals; writing "${" in a plain string here would trip lint
  const interpolated = (inner: string) => `\`${inner.replace("{", "$" + "{")}\``;
  const violating = src(
    HONO,
    'const version = "v1";',
    "export const app = new Hono();",
    `app.get(${interpolated("/{version}/a")}, (c) => c.text('a'));`,
    "export default app;",
  );
  ruleCase("R005", {
    violating: project({ "src/app.ts": violating }),
    fixed: project({ "src/app.ts": violating.replace(interpolated("/{version}/a"), '"/v1/a"') }),
    at: { file: "src/app.ts", line: 4 },
    message: /get\(\) path/,
  });

  it("R005 also reports a route() prefix built from a variable", async () => {
    const { hits } = await fires(
      "R005",
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          "const child = new Hono();",
          `export const prefix = (n: number) => ${interpolated("/v{n}")};`,
          "app.route(prefix(1), child);",
          "export default app;",
        ),
      }),
    );
    expect(hits[0].message).toMatch(/route\(\) prefix/);
  });
});

describe("R006 malformed paths", () => {
  const app = (body: string) =>
    project({
      "src/app.ts": src(HONO, "export const app = new Hono();", body, "export default app;"),
    });
  const missing = 'app.get("users", (c) => c.text("u"));';
  ruleCase("R006", {
    violating: app(missing),
    fixed: app('app.get("/users", (c) => c.text("u"));'),
    at: { file: "src/app.ts", line: 3 },
    message: /'users' has no leading slash/,
  });

  it("R006 flags a double slash", async () => {
    const { hits } = await fires("R006", app('app.get("/a//b", (c) => c.text("u"));'));
    expect(hits[0].message).toMatch(/contains \/\//);
  });

  it("R006 flags the trailing-slash twin of a route", async () => {
    const files = app(
      ['app.get("/x", (c) => c.text("a"));', 'app.get("/x/", (c) => c.text("b"));'].join("\n"),
    );
    const { hits } = await fires("R006", files);
    expect(hits[0].message).toMatch(/GET \/x\/ duplicates GET \/x/);
    expect(hits[0].line).toBe(4);
  });
});

describe("R007 one sub-app at two prefixes", () => {
  const files = (second: string) =>
    project({
      "src/child.ts": src(
        HONO,
        "export const child = new Hono();",
        'child.get("/a", (c) => c.text("a"));',
      ),
      "src/app.ts": src(
        HONO,
        'import { child } from "./child.ts";',
        "export const app = new Hono();",
        'app.route("/v1", child);',
        second,
        "export default app;",
      ),
    });
  ruleCase("R007", {
    violating: files('app.route("/v2", child);'),
    fixed: files(""),
    at: { file: "src/app.ts", line: 5 },
    message: /'child' is mounted 2 times/,
  });

  it("R007 does not touch a sub-app mounted once", async () => {
    await quiet("R007", files(""));
  });
});
