import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps } from "../_helpers.ts";
import { fires, HONO, lineOf, project, quiet, ruleCase, src } from "./_harness.ts";

afterAll(cleanupTemps);

const app = (imports: string[], ...lines: string[]) =>
  project({
    "src/app.ts": src(
      HONO,
      ...imports,
      "export const app = new Hono();",
      ...lines,
      "export default app;",
    ),
  });
const CORS = ['import { cors } from "hono/cors";'];

describe("S001 cors with credentials", () => {
  ruleCase("S001", {
    violating: app(CORS, 'app.use("*", cors({ origin: "*", credentials: true }));'),
    fixed: app(
      CORS,
      'app.use("*", cors({ origin: ["https://app.example.com"], credentials: true }));',
    ),
    at: { file: "src/app.ts", line: 4 },
    message: /allows origin '\*' together with credentials: true/,
  });

  it("S001 counts the default origin as '*'", async () => {
    const { hits } = await fires("S001", app(CORS, 'app.use("*", cors({ credentials: true }));'));
    expect(hits[0].message).toMatch(/\(the default\)/);
  });

  it("S001 flags an origin function that echoes the request origin", async () => {
    const { hits } = await fires(
      "S001",
      app(CORS, 'app.use("*", cors({ origin: (origin) => origin, credentials: true }));'),
    );
    expect(hits[0].message).toMatch(/reflects the request Origin/);
  });

  it("S001 leaves a wildcard without credentials, and a function that filters", async () => {
    await quiet(
      "S001",
      app(
        CORS,
        'app.use("*", cors({ origin: "*" }));',
        'app.use("/b/*", cors({ origin: (o) => (o === "https://a.example" ? o : ""), credentials: true }));',
      ),
    );
  });

  it("S001 is an error", async () => {
    const { hits, result } = await fires(
      "S001",
      app(CORS, 'app.use("*", cors({ credentials: true }));'),
    );
    expect(hits[0].severity).toBe("error");
    expect(result.ok).toBe(false);
  });
});

describe("S002 public route under a guarded mount", () => {
  const files = (specificFirst: boolean) => {
    const oauth = 'v1.route("/integrations/oauth", oauth);';
    const parent = 'v1.route("/integrations", integrations);';
    return project({
      "src/auth.ts": src("export const requireAuth = async (c, next) => { await next(); };"),
      "src/oauth.ts": src(
        HONO,
        "export const oauth = new Hono();",
        'oauth.get("/callback", (c) => c.text("ok"));',
      ),
      "src/integrations.ts": src(
        HONO,
        'import { requireAuth } from "./auth.ts";',
        "export const integrations = new Hono();",
        'integrations.use("*", requireAuth);',
        'integrations.get("/list", (c) => c.text("list"));',
      ),
      "src/app.ts": src(
        HONO,
        'import { oauth } from "./oauth.ts";',
        'import { integrations } from "./integrations.ts";',
        "const v1 = new Hono();",
        ...(specificFirst ? [oauth, parent] : [parent, oauth]),
        "export const app = new Hono();",
        'app.route("/v1", v1);',
        "export default app;",
      ),
    });
  };
  ruleCase("S002", {
    violating: files(true),
    fixed: files(false),
    at: { file: "src/oauth.ts", line: 3 },
    message: /GET \/v1\/integrations\/oauth\/callback has no auth in its chain/,
  });

  it("S002 reports a public route among guarded siblings of one sub-app", async () => {
    const { hits } = await fires(
      "S002",
      project({
        "src/auth.ts": src("export const requireAuth = async (c, next) => { await next(); };"),
        "src/items.ts": src(
          HONO,
          'import { requireAuth } from "./auth.ts";',
          "export const items = new Hono();",
          'items.get("/a", requireAuth, (c) => c.text("a"));',
          'items.get("/b", requireAuth, (c) => c.text("b"));',
          'items.get("/c", requireAuth, (c) => c.text("c"));',
          'items.get("/open", (c) => c.text("open"));',
        ),
        "src/app.ts": src(
          HONO,
          'import { items } from "./items.ts";',
          "export const app = new Hono();",
          'app.route("/items", items);',
          "export default app;",
        ),
      }),
    );
    expect(hits.map((h) => h.route)).toEqual(["GET /items/open"]);
    expect(hits[0].message).toMatch(/3 of 4 routes in 'items' are guarded/);
  });

  it("S002 does not call a public health route before a global guard a hole", async () => {
    const files = project({
      "src/auth.ts": src("export const requireAuth = async (c, next) => { await next(); };"),
      "src/app.ts": src(
        HONO,
        'import { requireAuth } from "./auth.ts";',
        "export const app = new Hono();",
        'app.get("/health", (c) => c.text("ok"));',
        'app.use("*", requireAuth);',
        'app.get("/x", (c) => c.text("x"));',
        "export default app;",
      ),
    });
    await quiet("S002", files);
    expect((await fires("M001", files)).hits).toHaveLength(1); // the order is still reported, as M001
  });
});

describe("S002 and M001 do not report one defect twice", () => {
  it("S002 leaves a route above its own sub-app's guard to M001", async () => {
    const files = project({
      "src/auth.ts": src("export const requireAuth = async (c, next) => { await next(); };"),
      "src/members.ts": src(
        HONO,
        'import { requireAuth } from "./auth.ts";',
        "export const members = new Hono();",
        'members.post("/accept", (c) => c.text("accepted"));',
        'members.use("*", requireAuth);',
        'members.get("/a", (c) => c.text("a"));',
        'members.get("/b", (c) => c.text("b"));',
        'members.get("/c", (c) => c.text("c"));',
      ),
      "src/app.ts": src(
        HONO,
        'import { members } from "./members.ts";',
        "export const app = new Hono();",
        'app.route("/members", members);',
        "export default app;",
      ),
    });
    await quiet("S002", files);
    expect((await fires("M001", files)).hits).toHaveLength(1);
  });
});

describe("S003 secret read without validation", () => {
  const read = src("export const secret = process.env.JWT_SECRET;");
  ruleCase("S003", {
    violating: project({ "src/auth.ts": read }),
    fixed: project({
      "src/auth.ts": src(
        "const secret = process.env.JWT_SECRET;",
        'if (!secret) throw new Error("JWT_SECRET is not set");',
        "export { secret };",
      ),
    }),
    at: { file: "src/auth.ts", line: 1 },
    message: /JWT_SECRET is read straight from the environment/,
  });

  it("S003 accepts a schema that names the key", async () => {
    await quiet(
      "S003",
      project({
        "src/env.ts": src(
          'import { z } from "zod";',
          "const schema = z.object({ JWT_SECRET: z.string().min(32) });",
          "export const env = schema.parse(process.env);",
        ),
      }),
    );
  });

  it("S003 honours a boot guard in another module (xpteam startup-guard)", async () => {
    await quiet(
      "S003",
      project({
        "src/utils/startup-guard.ts": src(
          "export function assertStartupSecrets(): void {",
          '  const jwtSecret = Deno.env.get("JWT_SECRET");',
          '  if (!jwtSecret) throw new Error("JWT_SECRET is not set");',
          '  const encKey = Deno.env.get("ENCRYPTION_KEY");',
          '  if (!encKey || encKey.length !== 64) throw new Error("ENCRYPTION_KEY invalid");',
          "}",
        ),
        "src/auth.ts": src('export const sign = () => Deno.env.get("JWT_SECRET");'),
        "src/crypto.ts": src('export const key = () => Deno.env.get("ENCRYPTION_KEY");'),
      }),
    );
  });

  it("S003 honours a guard on a read with a default, and still flags the unguarded one", async () => {
    const { hits } = await fires(
      "S003",
      project({
        "prisma/demo-data.ts": src(
          'const url = Deno.env.get("DATABASE_URL") ?? "";',
          "if (!/@localhost[:/]/.test(url)) { Deno.exit(1); }",
        ),
        "src/loose.ts": src('export const k = Deno.env.get("STRIPE_API_KEY") ?? "";'),
      }),
    );
    expect(hits.map((h) => [h.file, h.message.split(" ")[0]])).toEqual([
      ["src/loose.ts", "STRIPE_API_KEY"],
    ]);
  });

  it("S003 accepts a fail-closed check that answers instead of throwing", async () => {
    await quiet(
      "S003",
      app(
        [],
        'app.post("/hook", (c) => {',
        "  const secret = process.env.WEBHOOK_SECRET;",
        '  if (!secret) return c.json({ error: "not configured" }, 500);',
        "  return c.text(secret.length.toString());",
        "});",
      ),
    );
  });

  it("S003 looks only at secret-looking keys", async () => {
    await quiet(
      "S003",
      project({
        "src/config.ts": src(
          "export const a = process.env.PORT;",
          "export const b = process.env.KEYCLOAK_URL;",
          "export const c = process.env.TOKEN_TTL_SECONDS;",
          "export const d = process.env.VAPID_PUBLIC_KEY;",
        ),
      }),
    );
  });

  it("S003 flags DATABASE_URL and API keys", async () => {
    const { hits } = await fires(
      "S003",
      project({
        "src/config.ts": src(
          "export const db = process.env.DATABASE_URL;",
          "export const k = process.env.STRIPE_API_KEY;",
        ),
      }),
    );
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });
});

describe("S004 literal secret in auth options", () => {
  const JWT = ['import { jwt } from "hono/jwt";'];
  ruleCase("S004", {
    violating: app(JWT, 'app.use("/api/*", jwt({ secret: "hunter2", alg: "HS256" }));'),
    fixed: app(
      JWT,
      'app.use("/api/*", jwt({ secret: String(process.env.JWT_SECRET), alg: "HS256" }));',
    ),
    at: { file: "src/app.ts", line: 4 },
    message: /jwt\(\) is given a literal secret/,
  });

  it("S004 covers bearerAuth tokens and basicAuth passwords, also on a single route", async () => {
    const { hits } = await fires(
      "S004",
      app(
        [
          'import { bearerAuth } from "hono/bearer-auth";',
          'import { basicAuth } from "hono/basic-auth";',
        ],
        'app.use("/a/*", bearerAuth({ token: "abc123" }));',
        'app.get("/b", basicAuth({ username: "admin", password: "pw" }), (c) => c.text("b"));',
      ),
    );
    expect(hits.map((h) => h.message.split("(")[0])).toEqual(["bearerAuth", "basicAuth"]);
  });

  it("S004 ignores a function that merely shares the name", async () => {
    await quiet(
      "S004",
      app([], "const jwt = (o: { secret: string }) => o;", 'jwt({ secret: "x" });'),
    );
  });
});

describe("S005 onError leaking the error", () => {
  ruleCase("S005", {
    violating: app([], "app.onError((err, c) => c.json({ error: err.message }, 500));"),
    fixed: app(
      [],
      'app.onError((err, c) => { console.error(err); return c.json({ error: "Internal Server Error" }, 500); });',
    ),
    at: { file: "src/app.ts", line: 3 },
    message: /err\.message, err\.stack or the raw error/,
  });

  it("S005 lets an HTTPException answer with its own message", async () => {
    await quiet(
      "S005",
      app(
        ['import { HTTPException } from "hono/http-exception";'],
        "app.onError((err, c) => {",
        "  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);",
        '  return c.json({ error: "Internal Server Error" }, 500);',
        "});",
      ),
    );
  });

  it("S005 follows an error handler imported from another module", async () => {
    const { hits } = await fires(
      "S005",
      project({
        "src/errors.ts": src("export const onFail = (err, c) => c.text(String(err.stack), 500);"),
        "src/app.ts": src(
          HONO,
          'import { onFail } from "./errors.ts";',
          "export const app = new Hono();",
          "app.onError(onFail);",
          "export default app;",
        ),
      }),
    );
    expect(hits[0].file).toBe("src/app.ts");
  });
});

describe("S006 cookie auth without csrf", () => {
  const files = (csrf: boolean) =>
    project({
      "src/auth.ts": src(
        'import { getCookie } from "hono/cookie";',
        "export const sessionAuth = async (c, next) => { if (!getCookie(c, 'sid')) return c.text('no', 401); await next(); };",
      ),
      "src/app.ts": src(
        HONO,
        'import { csrf } from "hono/csrf";',
        'import { sessionAuth } from "./auth.ts";',
        "export const app = new Hono();",
        ...(csrf ? ['app.use("/api/*", csrf());'] : []),
        'app.use("/api/*", sessionAuth);',
        'app.post("/api/items", (c) => c.text("created", 201));',
        "export default app;",
      ),
    });
  ruleCase("S006", {
    violating: files(false),
    fixed: files(true),
    at: { file: "src/app.ts", line: lineOf(files(false)["src/app.ts"], "sessionAuth);") },
    message: /sessionAuth authenticates with a cookie or session and guards 1 state-changing route/,
  });

  it("S006 ignores header-token auth", async () => {
    await quiet(
      "S006",
      project({
        "src/app.ts": src(
          HONO,
          'import { bearerAuth } from "hono/bearer-auth";',
          "export const app = new Hono();",
          'app.use("/api/*", bearerAuth({ token: String(process.env.T) }));',
          'app.post("/api/items", (c) => c.text("created", 201));',
          "export default app;",
        ),
      }),
    );
  });
});

describe("S007 upload read with no bodyLimit", () => {
  const upload = "async (c) => c.json({ n: [...(await c.req.formData()).keys()].length })";
  const files = (limit: boolean) =>
    app(
      ['import { bodyLimit } from "hono/body-limit";'],
      limit
        ? `app.post("/up", bodyLimit({ maxSize: 1024 * 1024 }), ${upload});`
        : `app.post("/up", ${upload});`,
    );
  ruleCase("S007", {
    violating: files(false),
    fixed: files(true),
    at: { file: "src/app.ts", line: 4 },
    message: /POST \/up reads c\.req\.formData\(\) with no bodyLimit\(\)/,
  });

  it("S007 sees a bodyLimit applied by a use() over the path", async () => {
    await quiet(
      "S007",
      app(
        ['import { bodyLimit } from "hono/body-limit";'],
        'app.use("/up", bodyLimit({ maxSize: 1024 }));',
        `app.post("/up", ${upload});`,
      ),
    );
  });
});
