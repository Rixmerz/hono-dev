import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectIndex } from "../../core/index.ts";
import { CATEGORIES, catalogue, RULES, validate } from "../../validators/index.ts";
import type { Rule } from "../../validators/rule.ts";
import { cleanupTemps, loadFixture, makeProject } from "../_helpers.ts";
import { HONO, only, project, run, src } from "./_harness.ts";

afterAll(cleanupTemps);

/** The contract's catalogue, row for row. */
const CONTRACT: [string, string, string, boolean, string][] = [
  ["R001", "routes", "error", false, "same method and full path registered twice in one table"],
  [
    "R002",
    "routes",
    "warning",
    false,
    "param or wildcard route registered before a static sibling it shadows",
  ],
  ["R003", "routes", "error", false, "route added to a sub-app after route() mounted it"],
  [
    "R004",
    "routes",
    "warning",
    false,
    "Hono instance with routes that is never mounted nor served",
  ],
  ["R005", "routes", "info", false, "route or mount path built from a variable or template"],
  [
    "R006",
    "routes",
    "warning",
    false,
    "missing leading slash, double slash or trailing-slash duplicate",
  ],
  ["R007", "routes", "info", false, "one sub-app mounted at two prefixes"],
  [
    "M001",
    "middleware",
    "warning",
    false,
    "use() after the routes it targets on the same instance",
  ],
  ["M002", "middleware", "warning", false, "parent use() after the route() mount it would cover"],
  ["M003", "middleware", "warning", false, "scoped use('/x/*') whose path matches no route"],
  ["M004", "middleware", "warning", false, "inline middleware that never calls next()"],
  ["M005", "middleware", "warning", false, "next() without await or return"],
  ["M006", "middleware", "warning", false, "same middleware twice in one route's chain"],
  ["M007", "middleware", "error", false, "cors() after an auth middleware over the same paths"],
  [
    "V001",
    "validation",
    "warning",
    false,
    "POST/PUT/PATCH reads the body with no json/form validator",
  ],
  [
    "V002",
    "validation",
    "info",
    false,
    "body route whose body use cannot be analysed and has no validator",
  ],
  ["V003", "validation", "error", false, "c.req.valid(target) with no validator for that target"],
  ["V004", "validation", "warning", false, "json/form validator on a GET/HEAD route"],
  ["V005", "validation", "info", false, "route params read with no param validator"],
  ["S001", "security", "error", false, "cors origin '*' or reflected with credentials: true"],
  ["S002", "security", "warning", false, "route public on a mount where most routes are guarded"],
  ["S003", "security", "warning", false, "secret-looking env key read without validation"],
  ["S004", "security", "error", false, "literal secret in jwt/bearerAuth/basicAuth options"],
  [
    "S005",
    "security",
    "warning",
    false,
    "onError answering with err.message, err.stack or the raw error",
  ],
  [
    "S006",
    "security",
    "warning",
    false,
    "cookie/session auth with state-changing routes and no csrf()",
  ],
  ["S007", "security", "info", false, "formData/parseBody read with no bodyLimit()"],
  [
    "A001",
    "architecture",
    "warning",
    false,
    "route handler touches a DB client directly instead of a service",
  ],
  ["A002", "architecture", "warning", false, "root app with no onError"],
  ["A003", "architecture", "info", false, "root app with no notFound"],
  ["A004", "architecture", "warning", true, "import cycle between route modules"],
  ["P001", "rpc", "warning", false, "exported app type from a non-chained instance"],
  ["P002", "rpc", "warning", false, "hc<T>() where T is not an exported app type"],
  ["C001", "conventions", "error", false, "runtime API that does not match the runtime"],
  ["C002", "conventions", "error", false, "two Hono copies (npm:hono and jsr:@hono/hono)"],
  ["C003", "conventions", "warning", false, "deprecated Hono API"],
  ["C004", "conventions", "info", true, "route module with no test referencing its paths"],
];

describe("catalogue", () => {
  it("is the contract's 36 rules: id, category, severity, slow flag and title", () => {
    expect(catalogue().map((r) => [r.id, r.category, r.severity, r.slow, r.title])).toEqual(
      CONTRACT,
    );
    expect(RULES).toHaveLength(36);
  });

  it("covers every category and marks only A004 and C004 slow", () => {
    expect([...new Set(catalogue().map((r) => r.category))]).toEqual(CATEGORIES);
    expect(
      catalogue()
        .filter((r) => r.slow)
        .map((r) => r.id),
    ).toEqual(["A004", "C004"]);
  });

  it("gives every rule id a test file case", async () => {
    const ids = new Set(CONTRACT.map((r) => r[0]));
    const tests = (
      await Promise.all(
        [
          "routes",
          "middleware",
          "validation",
          "security",
          "architecture",
          "rpc",
          "conventions",
        ].map((f) =>
          import("node:fs/promises").then((fs) =>
            fs.readFile(join(import.meta.dirname, `${f}.test.ts`), "utf8"),
          ),
        ),
      )
    ).join("\n");
    for (const id of ids) expect(tests, id).toContain(`"${id}"`);
  });
});

describe("validate()", () => {
  const two = project({
    "src/a.ts": src(
      HONO,
      "export const a = new Hono();",
      'a.get("/x", (c) => c.text("a"));',
      'a.get("/x", (c) => c.text("b"));',
    ),
    "src/b.ts": src(HONO, "export const b = new Hono();", 'b.get("users", (c) => c.text("b"));'),
    "src/app.ts": src(
      HONO,
      'import { a } from "./a.ts";',
      'import { b } from "./b.ts";',
      "export const app = new Hono();",
      'app.route("/a", a);',
      'app.route("/b", b);',
      "app.onError((e, c) => c.text('x', 500));",
      "export default app;",
    ),
  });

  it("answers with the frozen ValidationResult shape and no summary.external", async () => {
    const r = await run(two);
    expect(Object.keys(r).sort()).toEqual(["findings", "ok", "summary"]);
    expect(Object.keys(r.summary).sort()).toEqual([
      "categories",
      "errors",
      "info",
      "unverified",
      "warnings",
    ]);
    expect(r.summary.categories).toEqual(CATEGORIES);
    for (const f of r.findings) {
      expect(f.source).toBe("hono-dev");
      expect(f.file.startsWith("./")).toBe(false);
    }
  });

  it("sets ok from the error count and counts each severity", async () => {
    const r = await run(two);
    expect(r.summary.errors).toBe(r.findings.filter((f) => f.severity === "error").length);
    expect(r.summary.errors).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
    const clean = await run(
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          "app.onError((e, c) => c.text('x', 500));",
          "export default app;",
        ),
      }),
    );
    expect(clean.ok).toBe(true);
  });

  it("sorts error, warning, info, then file, then line", async () => {
    const r = await run(two);
    const rank = { error: 0, warning: 1, info: 2 };
    const keys = r.findings.map((f) => [rank[f.severity], f.file, f.line ?? 0] as const);
    const sorted = [...keys].sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2]);
    expect(keys).toEqual(sorted);
    expect(r.findings[0].severity).toBe("error");
  });

  it("filters by file, with or without the ./ prefix", async () => {
    const r = await run(two, { files: ["./src/b.ts"] });
    expect(r.findings.length).toBeGreaterThan(0);
    expect(new Set(r.findings.map((f) => f.file))).toEqual(new Set(["src/b.ts"]));
    expect(only(await run(two, { files: ["src/a.ts"] }), "R001")).toHaveLength(1);
    expect(only(await run(two, { files: ["src/b.ts"] }), "R001")).toHaveLength(0);
  });

  it("filters by category", async () => {
    const r = await run(two, { categories: ["routes"] });
    expect(new Set(r.findings.map((f) => f.category))).toEqual(new Set(["routes"]));
    expect(r.summary.categories).toEqual(["routes"]);
  });

  it("skips the slow rules when fast is set", async () => {
    const files = project({
      "src/app.ts": src(
        HONO,
        "export const app = new Hono();",
        'app.get("/items", (c) => c.json([]));',
        "export default app;",
      ),
    });
    expect(only(await run(files), "C004")).toHaveLength(1);
    expect(only(await run(files, { fast: true }), "C004")).toHaveLength(0);
  });

  it("reports a rule that throws as '<id>: <message>' and runs the others", async () => {
    const boom: Rule = {
      id: "X999",
      category: "routes",
      severity: "error",
      title: "throws",
      run() {
        throw new Error("exploded");
      },
    };
    RULES.push(boom);
    try {
      const r = await run(two);
      expect(r.summary.unverified).toContain("X999: exploded");
      expect(only(r, "R001")).toHaveLength(1);
    } finally {
      RULES.pop();
    }
  });

  it("lists the files the index could not read in summary.unverified", async () => {
    const r = await run(
      project({
        "src/broken.ts": "export const = ;\n",
        "src/app.ts": src(HONO, "export const app = new Hono();"),
      }),
    );
    expect(r.summary.unverified.some((u) => u.startsWith("src/broken.ts: syntax:"))).toBe(true);
  });
});

describe("the analysed workspace is never written", () => {
  async function snapshot(dir: string, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for (const name of (await readdir(join(dir, prefix))).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const s = await stat(join(dir, rel));
      if (s.isDirectory()) out.push(`${rel}/`, ...(await snapshot(dir, rel)));
      else out.push(`${rel} ${s.size} ${s.mtimeMs}`);
    }
    return out;
  }

  it("leaves every file, directory and mtime as it found them, through load and validate", async () => {
    const dir = await makeProject(
      project({
        "src/app.ts": src(
          HONO,
          "export const app = new Hono();",
          'app.get("/a", (c) => c.text(String(process.env.JWT_SECRET)));',
          "export default app;",
        ),
        "src/app.test.ts": src('import { it } from "vitest";', 'it("x", () => {});'),
      }),
    );
    await mkdir(join(dir, "empty"), { recursive: true });
    await writeFile(join(dir, ".keep"), "");
    const before = await snapshot(dir);
    const idx = await ProjectIndex.load(dir, { force: true });
    const r = await validate(idx);
    await validate(idx, { fast: true, files: ["src/app.ts"] });
    expect(r.findings.length).toBeGreaterThan(0);
    expect(await snapshot(dir)).toEqual(before);
    expect(before.some((e) => e.startsWith(".hono-dev"))).toBe(false);
  });
});

describe("the fixtures", () => {
  it("raise no error finding on the clean Hono fixtures, and nothing on a non-Hono project", async () => {
    for (const name of ["hono-node", "hono-deno", "hono-workers", "hono-mounted"]) {
      const r = await validate(await loadFixture(name));
      expect(
        r.summary.errors,
        `${name}: ${r.findings.filter((f) => f.severity === "error").map((f) => f.id)}`,
      ).toBe(0);
      expect(r.summary.unverified, name).toEqual([]);
    }
    expect((await validate(await loadFixture("not-hono"))).findings).toEqual([]);
  });

  it("hono-mounted reports its deliberate public OAuth callback, and nothing on A002 or S005", async () => {
    const r = await validate(await loadFixture("hono-mounted"));
    expect(only(r, "S002").map((f) => f.route)).toEqual([
      "GET /v1/integrations/google-calendar/callback",
      "POST /v1/integrations/google-calendar/sync",
    ]);
    expect(only(r, "A002")).toEqual([]);
    expect(only(r, "S005")).toEqual([]); // its onError is guarded by instanceof HTTPException
  });

  it("hono-violations yields each family it was built to, and fails", async () => {
    const r = await validate(await loadFixture("hono-violations"));
    const ids = new Set(r.findings.map((f) => f.id));
    for (const id of [
      "R001",
      "R002",
      "R003",
      "M002",
      "M003",
      "M004",
      "V001",
      "V003",
      "S001",
      "S003",
      "A001",
      "A002",
      "A003",
      "C003",
    ])
      expect(ids.has(id), id).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.summary.errors).toBe(4);
  });
});
