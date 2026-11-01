import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps, copyFixture, fixture, makeProject } from "../_helpers.ts";

afterAll(cleanupTemps);

const ENTRY = fileURLToPath(new URL("../../entry.ts", import.meta.url));

function cli(args: string[], cwd?: string) {
  // HONO_DEV_STATE_DIR comes from process.env, set by _helpers.ts
  const r = spawnSync(process.execPath, [ENTRY, "cli", ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("hono-mcp exit codes", () => {
  it("validate exits 0 on a project without error-severity findings", () => {
    const r = cli(["validate", fixture("hono-node"), "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true });
  });

  it("validate exits 1 when there is an error-severity finding", () => {
    const r = cli(["validate", fixture("hono-violations"), "--json"]);
    expect(r.code).toBe(1);
    const body = JSON.parse(r.out);
    expect(body.ok).toBe(false);
    expect(body.summary.errors).toBeGreaterThan(0);
  });

  it("exits 2 for a project that is not Hono, with the evidence in the JSON", () => {
    const r = cli(["validate", fixture("not-hono"), "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
    expect(cli(["routes", fixture("not-hono")]).code).toBe(2);
    expect(cli(["project", fixture("not-hono")]).code).toBe(2);
  });

  it("exits 2 for a missing, unknown or non-directory workspace", () => {
    expect(cli(["validate"]).code).toBe(2);
    expect(cli(["validate", "/definitely/not/a/dir"]).code).toBe(2);
    expect(cli(["validate", join(fixture("hono-node"), "package.json")]).code).toBe(2);
  });

  it("exits 3 for an unknown command, an unknown flag and a bad value", () => {
    expect(cli(["frobnicate", fixture("hono-node")]).code).toBe(3);
    expect(cli(["routes", fixture("hono-node"), "--nope"]).code).toBe(3);
    expect(cli(["routes", fixture("hono-node"), "--limit", "many", "--json"]).code).toBe(3);
    expect(
      cli(["route", fixture("hono-mounted"), "--method", "GET", "--path", "/ghost"]).code,
    ).toBe(3);
    expect(cli(["impact", fixture("hono-mounted"), "--json"]).code).toBe(3);
  });

  it("resolves a relative workspace such as `.` against the working directory", () => {
    const r = cli(["validate", ".", "--json"], fixture("hono-violations"));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).summary.errors).toBeGreaterThan(0);
  });
});

describe("hono-mcp commands", () => {
  it("routes --json lists the composed paths and keeps stdout pure JSON", () => {
    const r = cli(["routes", fixture("hono-mounted"), "--json"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.total).toBe(body.routes.length);
    expect(body.routes.map((x: { fullPath: string }) => x.fullPath)).toEqual(
      expect.arrayContaining(["/v1/contacts/:id", "/v1/admin/cms/modules", "/api/ping"]),
    );
  });

  it("routes prints one line per route in text mode", () => {
    const r = cli(["routes", fixture("hono-mounted"), "--prefix", "/v1/contacts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("GET     /v1/contacts/:id  src/routes/v1/contacts.ts:24");
  });

  it("route, middleware, trace, deps, impact and rpc answer from the same tool functions", () => {
    const ws = fixture("hono-mounted");
    const route = JSON.parse(
      cli(["route", ws, "--method", "GET", "--path", "/v1/contacts/:id", "--json"]).out,
    );
    expect(route.fullPath).toBe("/v1/contacts/:id");
    const trace = JSON.parse(cli(["trace", ws, "--path", "/v1/contacts/7", "--json"]).out);
    expect(trace.params).toEqual({ id: "7" });
    const mw = JSON.parse(cli(["middleware", ws, "--path", "/v1/contacts/7", "--json"]).out);
    expect(mw.total).toBeGreaterThan(0);
    const deps = JSON.parse(
      cli(["deps", ws, "--file", "src/routes/v1/contacts.ts", "--importers", "--json"]).out,
    );
    expect(deps.direction).toBe("importers");
    const impact = JSON.parse(
      cli(["impact", ws, "--file", "src/routes/v1/contacts.ts", "--file", "src/app.ts", "--json"])
        .out,
    );
    expect(impact.files).toEqual(["src/routes/v1/contacts.ts", "src/app.ts"]);
    expect(JSON.parse(cli(["rpc", ws, "--json"]).out).appTypes.length).toBeGreaterThan(0);
    const validators = JSON.parse(cli(["validators", ws, "--missing-only", "--json"]).out);
    expect(
      validators.routes.every((r: { validators: unknown[] }) => r.validators.length === 0),
    ).toBe(true);
  });

  it("validate takes categories and files", () => {
    const r = cli([
      "validate",
      fixture("hono-violations"),
      "--category",
      "security",
      "--category",
      "routes",
      "--json",
    ]);
    expect(JSON.parse(r.out).summary.categories).toEqual(["security", "routes"]);
    const text = cli(["validate", fixture("hono-violations")]);
    expect(text.out).toMatch(/not ok — \d+ errors, \d+ warnings, \d+ info/);
  });

  it("rules prints the 36-rule catalogue", () => {
    const rules = JSON.parse(cli(["rules", "--json"]).out);
    expect(rules).toHaveLength(36);
    expect(cli(["rules"]).out).toContain("R001");
  });

  it("export writes .hono-dev/graph.json in the workspace, and only when asked", async () => {
    const ws = await copyFixture("hono-mounted");
    cli(["routes", ws]);
    cli(["validate", ws]);
    expect(existsSync(join(ws, ".hono-dev"))).toBe(false);
    const r = cli(["export", ws, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).path).toBe(join(".hono-dev", "graph.json"));
    const graph = JSON.parse(await readFile(join(ws, ".hono-dev", "graph.json"), "utf8"));
    expect(graph.graph.generator).toBe("hono-dev");
  });

  it("export honours an explicit path chosen by the person running the CLI", async () => {
    const ws = await copyFixture("hono-mounted");
    const elsewhere = await makeProject({});
    const target = join(elsewhere, "graph.json");
    expect(cli(["export", ws, "--path", target]).code).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(ws, ".hono-dev"))).toBe(false);
  });
});
