import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportGraph } from "../../core/export.ts";
import { ProjectIndex } from "../../core/index.ts";
import { cleanupTemps, copyFixture, fixture } from "../_helpers.ts";

afterAll(cleanupTemps);

interface Doc {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, unknown>;
  nodes: {
    id: string;
    label: string;
    hono_kind: string;
    source_location: string;
    _origin: string;
    hono_full_path?: string;
  }[];
  links: {
    source: string;
    target: string;
    relation: string;
    hono_edge: string;
    confidence: string;
    confidence_score: number;
  }[];
}

describe("exportGraph", () => {
  it("writes graphify node-link JSON to <ws>/.hono-dev/graph.json in a temp copy", async () => {
    const dir = await copyFixture("hono-mounted");
    const idx = await ProjectIndex.load(dir, { force: true });
    const res = await exportGraph(idx);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(join(".hono-dev", "graph.json"));
    expect(res.livespecSnippet).toBe(
      '[graph]\nexternal = ".hono-dev/graph.json"\nauto_ingest = true',
    );
    const doc = JSON.parse(await readFile(join(dir, ".hono-dev", "graph.json"), "utf8")) as Doc;
    expect(doc.directed).toBe(true);
    expect(doc.multigraph).toBe(false);
    expect(doc.graph).toMatchObject({ generator: "hono-dev", hono: "4.13.16" });
    expect(typeof doc.graph.exported_at).toBe("string");
    expect(res.nodes).toBe(doc.nodes.length);
    expect(res.links).toBe(doc.links.length);
  });

  it("names a route node with the FULL composed path", async () => {
    const dir = await copyFixture("hono-mounted");
    const doc = await exportAndRead(dir);
    const route = doc.nodes.find((n) => n.id === "src/routes/v1/contacts.ts::GET /v1/contacts/:id");
    expect(route).toMatchObject({
      label: "GET /v1/contacts/:id",
      hono_kind: "route",
      hono_full_path: "/v1/contacts/:id",
      _origin: "ast",
    });
    expect(route?.source_location).toMatch(/^L\d+$/);
  });

  it("emits mounts, guards, validates and imports edges with the contract fields", async () => {
    const dir = await copyFixture("hono-mounted");
    const doc = await exportAndRead(dir);
    const edge = (kind: string) => doc.links.filter((l) => l.hono_edge === kind);
    expect(
      edge("mounts").some(
        (l) =>
          l.source === "src/routes/v1/index.ts::v1" &&
          l.target === "src/routes/v1/contacts.ts::contactRoutes",
      ),
    ).toBe(true);
    expect(
      edge("guards").some(
        (l) =>
          l.source.endsWith("GET /v1/contacts/:id") &&
          l.target.includes("use /v1/contacts/* authMiddleware"),
      ),
    ).toBe(true);
    expect(edge("validates").length).toBeGreaterThan(0);
    expect(
      edge("imports").some(
        (l) => l.source === "src/app.ts" && l.target === "src/routes/v1/index.ts",
      ),
    ).toBe(true);
    for (const l of doc.links) {
      expect(["uses", "calls", "imports", "mounts"]).toContain(l.relation);
      expect(["EXTRACTED", "INFERRED"]).toContain(l.confidence);
    }
    // the unreached auth step of the google-calendar route is an inferred guard
    const gc = edge("guards").filter(
      (l) => l.source.includes("google-calendar/callback") && l.target.includes("authMiddleware"),
    );
    expect(gc).toHaveLength(1);
    expect(gc[0].confidence).toBe("INFERRED");
  });

  it("writes only to the requested path and leaves the workspace otherwise untouched", async () => {
    const dir = await copyFixture("hono-mounted");
    const idx = await ProjectIndex.load(dir, { force: true });
    const out = join(dir, "build", "g.json");
    const res = await exportGraph(idx, { path: out });
    expect(res.path).toBe(join("build", "g.json"));
    await expect(readFile(join(dir, ".hono-dev", "graph.json"))).rejects.toThrow();
    await expect(readFile(out, "utf8")).resolves.toContain('"generator": "hono-dev"');
  });

  it("does not write inside the shared fixture when analysing it", async () => {
    await ProjectIndex.load(fixture("hono-mounted"), { force: true });
    await expect(
      readFile(join(fixture("hono-mounted"), ".hono-dev", "graph.json")),
    ).rejects.toThrow();
  });
});

async function exportAndRead(dir: string): Promise<Doc> {
  const idx = await ProjectIndex.load(dir, { force: true });
  const res = await exportGraph(idx);
  return JSON.parse(await readFile(join(dir, res.path), "utf8")) as Doc;
}
