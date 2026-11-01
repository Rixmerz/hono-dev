import { describe, expect, it } from "vitest";
import { traceRequest } from "../../core/trace.ts";
import { loadFixture } from "../_helpers.ts";

describe("traceRequest", () => {
  it("runs middleware in table order, then the handler, with params", async () => {
    const idx = await loadFixture("hono-mounted");
    const t = traceRequest(idx, "GET", "/v1/contacts/42?x=1");
    expect(t.path).toBe("/v1/contacts/42");
    expect(t.root).toBe("src/app.ts#app");
    expect(t.steps.map((s) => [s.kind, s.name, s.reached])).toEqual([
      ["middleware", "logger", true],
      ["middleware", "cors", true],
      ["middleware", "secureHeaders", true],
      ["middleware", "authMiddleware", true],
      ["middleware", "tenantMiddleware", true],
      ["handler", null, true],
    ]);
    expect(t.handler?.fullPath).toBe("/v1/contacts/:id");
    expect(t.params).toEqual({ id: "42" });
    expect(t.notFound).toBe(false);
    expect(t.allowedMethods).toEqual(["DELETE", "GET", "HEAD"]);
  });

  it("picks the first matching handler: /export before /:id", async () => {
    const idx = await loadFixture("hono-mounted");
    const t = traceRequest(idx, "GET", "/v1/contacts/export");
    expect(t.handler?.fullPath).toBe("/v1/contacts/export");
    const second = t.steps.filter((s) => s.kind === "handler");
    expect(second.map((s) => [s.entryId, s.reached])).toEqual([
      [t.handler?.id, true],
      [expect.any(String), false],
    ]);
  });

  it("proof case: the integrations auth step is reached:false for google-calendar", async () => {
    const idx = await loadFixture("hono-mounted");
    const t = traceRequest(idx, "GET", "/v1/integrations/google-calendar/callback");
    const auth = t.steps.find((s) => s.name === "authMiddleware");
    expect(auth).toBeDefined();
    expect(auth?.reached).toBe(false);
    expect(t.handler?.fullPath).toBe("/v1/integrations/google-calendar/callback");
    expect(t.steps.filter((s) => s.reached).some((s) => s.name === "authMiddleware")).toBe(false);
    // the sibling route on the same prefix does pass through auth
    const sibling = traceRequest(idx, "GET", "/v1/integrations/slack");
    expect(sibling.steps.find((s) => s.name === "authMiddleware")?.reached).toBe(true);
  });

  it("reports the sub-app error handler that wraps the route", async () => {
    const idx = await loadFixture("hono-mounted");
    expect(traceRequest(idx, "GET", "/v1/reports/summary").errorHandler?.file).toBe(
      "src/routes/v1/reports.ts",
    );
    expect(traceRequest(idx, "GET", "/v1/contacts").errorHandler?.file).toBe("src/app.ts");
  });

  it("reports notFound, still listing the middleware that would run", async () => {
    const idx = await loadFixture("hono-mounted");
    const t = traceRequest(idx, "GET", "/nope");
    expect(t.notFound).toBe(true);
    expect(t.handler).toBeNull();
    expect(t.steps.map((s) => s.name)).toEqual(["logger", "cors"]);
    expect(t.errorHandler?.file).toBe("src/app.ts");
  });

  it("method mismatch is not a handler but lists the allowed methods", async () => {
    const idx = await loadFixture("hono-mounted");
    const t = traceRequest(idx, "PUT", "/v1/contacts");
    expect(t.notFound).toBe(true);
    expect(t.allowedMethods).toEqual(["GET", "HEAD", "POST"]);
  });

  it("dispatches HEAD as GET like hono-base", async () => {
    const idx = await loadFixture("hono-mounted");
    expect(traceRequest(idx, "HEAD", "/api/ping").handler?.fullPath).toBe("/api/ping");
  });

  it("returns an empty trace for a project without Hono apps", async () => {
    const idx = await loadFixture("not-hono");
    const t = traceRequest(idx, "GET", "/health");
    expect(t).toMatchObject({ root: null, steps: [], handler: null, notFound: true });
  });
});
