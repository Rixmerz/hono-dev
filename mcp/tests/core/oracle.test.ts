/**
 * ORACLE: the static table must equal what real Hono registers. The fixture apps are imported
 * and executed, then `app.routes` (method, path, order) is compared with the table the engine
 * built by reading the sources only.
 */
import { describe, expect, it } from "vitest";
import { expandedTable, loadFixture } from "../_helpers.ts";

type RealRoute = { method: string; path: string };

async function realRoutes(modulePath: string): Promise<RealRoute[]> {
  const mod = (await import(modulePath)) as { app: { routes: RealRoute[] } };
  return mod.app.routes.map((r) => ({ method: r.method, path: r.path }));
}

describe("oracle: static table equals app.routes", () => {
  it("hono-mounted (multi-level mounts, basePath, two-level mount, chained rpc)", async () => {
    const idx = await loadFixture("hono-mounted");
    const real = await realRoutes("../../../fixtures/hono-mounted/src/app.ts");
    const root = "src/app.ts#app";
    expect(idx.roots).toContain(root);
    expect(real.length).toBeGreaterThan(20);
    expect(expandedTable(idx, root)).toEqual(real);
  });

  it("hono-node (plain mounts)", async () => {
    const idx = await loadFixture("hono-node");
    const real = await realRoutes("../../../fixtures/hono-node/src/app.ts");
    expect(expandedTable(idx, "src/app.ts#app")).toEqual(real);
  });

  it("pins the proof case: google-calendar is copied before the integrations auth middleware", async () => {
    const real = await realRoutes("../../../fixtures/hono-mounted/src/app.ts");
    const paths = real.map((r) => `${r.method} ${r.path}`);
    const callback = paths.indexOf("GET /v1/integrations/google-calendar/callback");
    const integrationsAuth = paths.indexOf("ALL /v1/integrations/*");
    expect(callback).toBeGreaterThan(-1);
    expect(integrationsAuth).toBeGreaterThan(callback);
  });
});
