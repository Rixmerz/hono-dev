import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceKey } from "../../core/state.ts";
import { cleanupTemps, copyFixture, fixture } from "../_helpers.ts";

const ENTRY = fileURLToPath(new URL("../../entry.ts", import.meta.url));
const STATE = process.env.HONO_DEV_STATE_DIR as string; // set by _helpers.ts

const TOOLS = [
  "hono_project",
  "hono_routes",
  "hono_route",
  "hono_middleware",
  "hono_validators",
  "hono_rpc",
  "hono_trace",
  "hono_dependencies",
  "hono_impact",
  "hono_validate",
  "hono_graph_export",
  "hono_reindex",
];

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // StdioClientTransport hands the child only a whitelist of variables unless told otherwise;
  // without HONO_DEV_STATE_DIR the server would write its cache into the real ~/.cache
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "mcp", "--stdio"],
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "hono-dev-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await cleanupTemps();
});

interface Called {
  isError: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: tool payloads are asserted field by field below
  body: any;
}

async function call(name: string, args: Record<string, unknown>): Promise<Called> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  return { isError: res.isError === true, body: JSON.parse(content[0]?.text ?? "null") };
}

const mounted = fixture("hono-mounted");

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

describe("the hono MCP server over stdio", () => {
  it("lists exactly the 12 tools, each requiring an absolute-path workspace", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const t of tools) {
      expect(t.inputSchema.required, t.name).toContain("workspace");
      expect(t.description, t.name).toBeTruthy();
    }
    const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writers.sort()).toEqual(["hono_graph_export", "hono_reindex"]);
  });

  it("hono_project detects the project", async () => {
    const { isError, body } = await call("hono_project", { workspace: mounted });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, isHono: true, runtime: "node" });
    expect(body.honoVersion.major).toBe(4);
    expect(body.counts.routes).toBeGreaterThan(5);
    expect(body.apps.length).toBeGreaterThan(1);
  });

  it("hono_routes reports the full composed path, not the local one", async () => {
    const { body } = await call("hono_routes", { workspace: mounted, prefix: "/v1/contacts" });
    const r = body.routes.find(
      (x: { method: string; fullPath: string }) =>
        x.method === "GET" && x.fullPath === "/v1/contacts/:id",
    );
    expect(r).toMatchObject({ localPath: "/:id", file: "src/routes/v1/contacts.ts" });
    expect(
      body.routes.every((x: { fullPath: string }) => x.fullPath.startsWith("/v1/contacts")),
    ).toBe(true);
  });

  it("hono_routes pages and adds the chain on request", async () => {
    const first = await call("hono_routes", { workspace: mounted, limit: 2 });
    expect(first.body.routes).toHaveLength(2);
    expect(first.body).toMatchObject({ truncated: true, next_offset: 2 });
    expect(first.body.routes[0].chain).toBeUndefined();
    const withMw = await call("hono_routes", {
      workspace: mounted,
      prefix: "/v1/contacts/",
      include_middleware: true,
    });
    expect(withMw.body.routes[0]).toHaveProperty("chain");
    expect(withMw.body.routes[0]).toHaveProperty("unreached");
  });

  it("hono_route returns the mount chain and the middleware chain", async () => {
    const { isError, body } = await call("hono_route", {
      workspace: mounted,
      method: "GET",
      path: "/v1/contacts/:id",
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, fullPath: "/v1/contacts/:id", localPath: "/:id" });
    expect(body.mountChain.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.chain)).toBe(true);
    expect(Array.isArray(body.unreached)).toBe(true);
    expect(body.tests).toContain("src/routes/v1/contacts.test.ts");
  });

  it("hono_route fails with a hint for a route that does not exist", async () => {
    const { isError, body } = await call("hono_route", {
      workspace: mounted,
      method: "GET",
      path: "/nope",
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false });
    expect(body.error).toContain("GET /nope");
    expect(body.hint).toBeTruthy();
  });

  it("hono_trace follows a concrete URL and extracts the params", async () => {
    const { body } = await call("hono_trace", {
      workspace: mounted,
      path: "/v1/contacts/42",
      method: "GET",
    });
    expect(body).toMatchObject({ ok: true, notFound: false, params: { id: "42" }, reason: null });
    expect(body.handler.fullPath).toBe("/v1/contacts/:id");
    expect(body.steps.at(-1)).toMatchObject({ kind: "handler", reached: true });
  });

  it("hono_trace explains a 404", async () => {
    const { isError, body } = await call("hono_trace", {
      workspace: mounted,
      path: "/definitely/not/here",
    });
    expect(isError).toBe(false);
    expect(body.notFound).toBe(true);
    expect(body.reason).toContain("no route matches");
  });

  it("hono_middleware lists what applies to a request, in order", async () => {
    const { body } = await call("hono_middleware", {
      workspace: mounted,
      method: "GET",
      path: "/v1/contacts/42",
    });
    expect(body.total).toBeGreaterThan(0);
    expect(body.middleware.map((m: { fullPath: string }) => m.fullPath)).toContain("/*");
    const all = await call("hono_middleware", { workspace: mounted });
    expect(all.body.total).toBeGreaterThanOrEqual(body.total);
  });

  it("hono_validators separates validated routes from the ones without", async () => {
    const all = await call("hono_validators", { workspace: mounted });
    const missing = await call("hono_validators", { workspace: mounted, missing_only: true });
    expect(missing.body.total).toBeLessThan(all.body.total);
    expect(
      missing.body.routes.every((r: { validators: unknown[] }) => r.validators.length === 0),
    ).toBe(true);
    expect(all.body.routes.some((r: { validators: unknown[] }) => r.validators.length > 0)).toBe(
      true,
    );
  });

  it("hono_rpc returns the exported app types and the hc clients", async () => {
    const { body } = await call("hono_rpc", { workspace: mounted });
    expect(body.appTypes.length).toBeGreaterThan(0);
    expect(body.appTypes[0]).toHaveProperty("carriesEveryRoute");
    expect(body.clients.length).toBeGreaterThan(0);
  });

  it("hono_dependencies walks importers and imports", async () => {
    const importers = await call("hono_dependencies", {
      workspace: mounted,
      file: "src/routes/v1/contacts.ts",
      direction: "importers",
    });
    expect(importers.body.files.map((f: { file: string }) => f.file)).toContain(
      "src/routes/barrel.ts",
    );
    const imports = await call("hono_dependencies", {
      workspace: mounted,
      file: "src/routes/v1/contacts.ts",
    });
    expect(imports.body.external.map((e: { canonical: string }) => e.canonical)).toContain("hono");
    const missing = await call("hono_dependencies", { workspace: mounted, file: "src/ghost.ts" });
    expect(missing.isError).toBe(true);
  });

  it("hono_impact maps a changed file to routes and checks", async () => {
    const { body } = await call("hono_impact", {
      workspace: mounted,
      files: ["src/routes/v1/contacts.ts"],
    });
    expect(body.routes.map((r: { fullPath: string }) => r.fullPath)).toContain("/v1/contacts/:id");
    expect(body.suggestedChecks.length).toBeGreaterThan(0);
    const none = await call("hono_impact", { workspace: mounted });
    expect(none.isError).toBe(true);
    expect(none.body.error).toBe("no changed files");
  });

  it("hono_validate answers with findings, and a project with errors is not a tool error", async () => {
    const { isError, body } = await call("hono_validate", {
      workspace: fixture("hono-violations"),
    });
    expect(isError).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.summary.errors).toBeGreaterThan(0);
    expect(body.findings[0]).toMatchObject({ source: "hono-dev" });
    const scoped = await call("hono_validate", {
      workspace: fixture("hono-violations"),
      categories: ["security"],
    });
    expect(scoped.body.summary.categories).toEqual(["security"]);
    // the SDK rejects an unknown category before the handler runs, with plain text
    const bad = await client.callTool({
      name: "hono_validate",
      arguments: { workspace: mounted, categories: ["nonsense"] },
    });
    expect(bad.isError).toBe(true);
  });

  it("hono_reindex reports the index stats", async () => {
    const { body } = await call("hono_reindex", { workspace: mounted, force: true });
    expect(body.ok).toBe(true);
    expect(body.parsed).toBe(body.files);
  });

  it("answers a workspace that is not Hono with ok:false and the evidence", async () => {
    const notHono = fixture("not-hono");
    const project = await call("hono_project", { workspace: notHono });
    expect(project.isError).toBe(true);
    expect(project.body).toMatchObject({ ok: false, isHono: false });
    expect(project.body.evidence).toBeInstanceOf(Array);
    for (const [name, extra] of [
      ["hono_routes", {}],
      ["hono_validate", {}],
      ["hono_trace", { path: "/" }],
    ] as const) {
      const r = await call(name, { workspace: notHono, ...extra });
      expect(r.isError, name).toBe(true);
      expect(r.body, name).toMatchObject({ ok: false });
      expect(r.body.error, name).toContain("not a Hono project");
    }
  });

  it("rejects a missing, relative or unknown workspace", async () => {
    for (const workspace of ["relative/path", "/definitely/not/a/dir", "/"]) {
      const r = await call("hono_project", { workspace });
      expect(r.isError, workspace).toBe(true);
      expect(r.body.ok).toBe(false);
    }
    const res = await client.callTool({ name: "hono_project", arguments: {} });
    expect(res.isError).toBe(true);
  });
});

describe("what the server writes", () => {
  it("leaves the analysed project untouched and keeps its cache in the state directory", async () => {
    const ws = await copyFixture("hono-mounted");
    const before = await listing(ws);
    for (const name of TOOLS.filter((t) => t !== "hono_graph_export")) {
      const args: Record<string, unknown> = { workspace: ws };
      if (name === "hono_route") Object.assign(args, { method: "GET", path: "/v1/contacts/:id" });
      if (name === "hono_trace") args.path = "/v1/contacts/1";
      if (name === "hono_dependencies") args.file = "src/app.ts";
      if (name === "hono_impact") args.files = ["src/app.ts"];
      await call(name, args);
    }
    expect(await listing(ws)).toEqual(before);
    expect(existsSync(join(STATE, workspaceKey(ws), "facts-cache.json"))).toBe(true);
  });

  it("hono_graph_export writes the graph file inside the workspace and nothing else", async () => {
    const ws = await copyFixture("hono-mounted");
    const before = await listing(ws);
    const { isError, body } = await call("hono_graph_export", { workspace: ws });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, path: join(".hono-dev", "graph.json") });
    const added = (await listing(ws)).filter((p) => !before.includes(p));
    expect(added).toEqual([".hono-dev", join(".hono-dev", "graph.json")]);
    const graph = JSON.parse(await readFile(join(ws, ".hono-dev", "graph.json"), "utf8"));
    expect(
      graph.nodes.some((n: { hono_full_path?: string }) => n.hono_full_path === "/v1/contacts/:id"),
    ).toBe(true);
  });

  it("hono_graph_export refuses a path outside the workspace", async () => {
    const ws = await copyFixture("hono-mounted");
    const outside = await copyFixture("not-hono");
    for (const path of [
      "../escape.json",
      join(outside, "graph.json"),
      "/tmp/hono-dev-escape.json",
    ]) {
      const r = await call("hono_graph_export", { workspace: ws, path });
      expect(r.isError, path).toBe(true);
      expect(r.body.error, path).toContain("escapes the workspace");
    }
    expect(existsSync(join(outside, "graph.json"))).toBe(false);
    expect(existsSync("/tmp/hono-dev-escape.json")).toBe(false);
  });
});
