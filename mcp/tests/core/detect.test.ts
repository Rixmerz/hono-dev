import { afterAll, describe, expect, it } from "vitest";
import { cleanupTemps, loadFixture, loadProject } from "../_helpers.ts";

afterAll(cleanupTemps);

const APP = `import { Hono } from "hono";\nexport const app = new Hono();\napp.get("/", (c) => c.text("ok"));\n`;

describe("detection", () => {
  it("node: version declared and resolved, node-server entry, fly + docker", async () => {
    const d = (await loadFixture("hono-node")).detection;
    expect(d.isHono).toBe(true);
    expect(d.honoVersion).toEqual({
      declared: "4.13.16",
      resolved: "4.13.16",
      major: 4,
      supported: true,
    });
    expect(d.runtime).toBe("node");
    expect(d.runtimes).toEqual([
      {
        runtime: "node",
        evidence: expect.arrayContaining(["package.json depends on @hono/node-server"]),
      },
    ]);
    expect(d.deployTargets).toEqual(["fly", "docker"]);
    expect(d.entry).toEqual({
      file: "src/index.ts",
      app: "src/app.ts#app",
      serve: "node-server",
      line: 5,
    });
    expect(d.configFiles).toEqual({
      packageJson: "package.json",
      denoJson: null,
      tsconfig: "tsconfig.json",
      wrangler: null,
      lockfile: "package-lock.json",
    });
    expect(d.confidence).toBe("high");
  });

  it("deno: import-map specifiers, deno.lock resolution, Deno.serve entry", async () => {
    const d = (await loadFixture("hono-deno")).detection;
    expect(d.isHono).toBe(true);
    expect(d.honoSpecifiers).toEqual(["jsr:@hono/hono@^4"]);
    expect(d.honoVersion).toEqual({
      declared: "^4",
      resolved: "4.13.16",
      major: 4,
      supported: true,
    });
    expect(d.runtime).toBe("deno");
    expect(d.entry).toEqual({
      file: "main.ts",
      app: "src/app.ts#app",
      serve: "deno-serve",
      line: 4,
    });
    expect(d.configFiles.denoJson).toBe("deno.json");
    expect(d.configFiles.lockfile).toBe("deno.lock");
    expect(d.deployTargets).toEqual(["docker"]);
  });

  it("workers: wrangler.jsonc, export default entry, cloudflare target", async () => {
    const d = (await loadFixture("hono-workers")).detection;
    expect(d.runtime).toBe("cloudflare-workers");
    expect(d.runtimes[0]).toEqual({ runtime: "cloudflare-workers", evidence: ["wrangler.jsonc"] });
    expect(d.configFiles.wrangler).toBe("wrangler.jsonc");
    expect(d.deployTargets).toEqual(["cloudflare"]);
    expect(d.entry).toMatchObject({
      file: "src/index.ts",
      app: "src/index.ts#app",
      serve: "export-default",
    });
    expect(d.honoVersion.declared).toBe("4.13.16");
  });

  it("bun: bun.lock and Bun.serve, version resolved from bun.lock", async () => {
    const idx = await loadProject({
      "package.json": `{"dependencies":{"hono":"^4.6.0"}}`,
      "bun.lock": `{\n  "lockfileVersion": 1,\n  "packages": {\n    "hono": ["hono@4.6.5", "", {}, "sha512-abc"],\n  },\n}\n`,
      "src/index.ts": `${APP}Bun.serve({ port: 3000, fetch: app.fetch });\n`,
    });
    const d = idx.detection;
    expect(d.runtime).toBe("bun");
    expect(d.honoVersion).toMatchObject({ declared: "^4.6.0", resolved: "4.6.5", major: 4 });
    expect(d.runtimes.find((r) => r.runtime === "bun")?.evidence).toEqual(
      expect.arrayContaining(["bun.lock", "src/index.ts:4 Bun.serve"]),
    );
    expect(d.entry).toMatchObject({
      file: "src/index.ts",
      serve: "bun-serve",
      app: "src/index.ts#app",
    });
  });

  it("bun: bunfig alone is evidence; export default object with fetch is the entry", async () => {
    const d = (
      await loadProject({
        "package.json": `{"dependencies":{"hono":"4.5.0"}}`,
        "bunfig.toml": `[install]\n`,
        "src/index.ts": `${APP}export default { port: 3000, fetch: app.fetch };\n`,
      })
    ).detection;
    expect(d.runtime).toBe("bun");
    expect(d.entry).toMatchObject({ serve: "export-default", app: "src/index.ts#app" });
  });

  it("resolves the version from pnpm-lock.yaml", async () => {
    const d = (
      await loadProject({
        "package.json": `{"dependencies":{"hono":"^4.2.0"}}`,
        "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      hono:\n        specifier: ^4.2.0\n        version: 4.7.11\n`,
        "src/app.ts": APP,
      })
    ).detection;
    expect(d.honoVersion.resolved).toBe("4.7.11");
    expect(d.configFiles.lockfile).toBe("pnpm-lock.yaml");
  });

  it("flags a Hono major that is not 4 as unsupported", async () => {
    const d = (
      await loadProject({
        "package.json": `{"dependencies":{"hono":"^3.12.0"}}`,
        "src/app.ts": APP,
      })
    ).detection;
    expect(d.honoVersion).toMatchObject({ major: 3, supported: false });
  });

  it("honours config.entry over the discovered serve call", async () => {
    const d = (
      await loadProject({
        "package.json": `{"dependencies":{"hono":"4.13.16","@hono/node-server":"2.1.5"}}`,
        ".hono-dev/config.json": `{ "entry": "src/other.ts" } // jsonc`,
        "src/app.ts": APP,
        "src/other.ts": `export const x = 1;\n`,
        "src/index.ts": `import { serve } from "@hono/node-server";\nimport { app } from "./app.ts";\nserve({ fetch: app.fetch });\n`,
      })
    ).detection;
    expect(d.entry?.file).toBe("src/other.ts");
  });

  it("not-hono: Express project is not a Hono project", async () => {
    const idx = await loadFixture("not-hono");
    expect(idx.detection.isHono).toBe(false);
    expect(idx.detection.honoVersion).toMatchObject({ declared: null, major: null });
    expect(idx.detection.confidence).toBe("low");
    expect(idx.detection.entry).toBeNull();
    expect(idx.routes).toEqual([]);
    expect(idx.apps).toEqual([]);
  });

  it("detects Hono from source imports even without a manifest entry", async () => {
    const d = (await loadProject({ "src/app.ts": APP })).detection;
    expect(d.isHono).toBe(true);
    expect(d.honoVersion.declared).toBeNull();
    expect(d.evidence).toContain("sources import hono without a manifest entry");
  });
});
