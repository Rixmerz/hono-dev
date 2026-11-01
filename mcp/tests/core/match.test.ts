import { describe, expect, it } from "vitest";
import { samplePaths, TableMatcher } from "../../core/match.ts";

describe("TableMatcher (hono's SmartRouter)", () => {
  const entries = [
    { method: "ALL", path: "/*" },
    { method: "ALL", path: "/v1/contacts/*" },
    { method: "GET", path: "/v1/contacts/export" },
    { method: "GET", path: "/v1/contacts/:id" },
    { method: "POST", path: "/v1/contacts" },
    null,
    { method: "GET", path: "/files/:name{[a-z]+\\.png}" },
  ];

  it("returns every matching entry in table order, with params", () => {
    const m = new TableMatcher(entries);
    expect(m.match("GET", "/v1/contacts/42").map((h) => h.index)).toEqual([0, 1, 3]);
    expect(m.match("GET", "/v1/contacts/42")[2].params).toEqual({ id: "42" });
    expect(m.match("GET", "/v1/contacts/export").map((h) => h.index)).toEqual([0, 1, 2, 3]);
    expect(m.match("POST", "/v1/contacts").map((h) => h.index)).toEqual([0, 1, 4]);
  });

  it("matches ALL entries for any method and dispatches HEAD as GET", () => {
    const m = new TableMatcher(entries);
    expect(m.match("DELETE", "/anything").map((h) => h.index)).toEqual([0]);
    expect(m.match("HEAD", "/v1/contacts/7").map((h) => h.index)).toEqual([0, 1, 3]);
  });

  it("honours regex-constrained params and skips null slots", () => {
    const m = new TableMatcher(entries);
    expect(m.match("GET", "/files/logo.png").map((h) => h.index)).toContain(6);
    expect(m.match("GET", "/files/logo.gif").map((h) => h.index)).not.toContain(6);
  });

  it("falls back to the trie router when the regexp router cannot hold the table", () => {
    const m = new TableMatcher([
      { method: "GET", path: "/:a/x" },
      { method: "GET", path: "/:b/y" },
    ]);
    expect(m.match("GET", "/q/y")).toEqual([{ index: 1, params: { b: "q" } }]);
    expect(m.error).toBeNull();
  });
});

describe("samplePaths", () => {
  it("replaces params and wildcards with concrete segments", () => {
    expect(samplePaths("/v1/contacts/:id")[0]).toBe("/v1/contacts/x1");
    expect(samplePaths("/files/*")[0]).toBe("/files/x");
    expect(samplePaths("/")[0]).toBe("/");
  });

  it("generates values that satisfy {regex} constraints", () => {
    for (const p of samplePaths("/n/:id{[0-9]+}")) expect(p).toMatch(/^\/n\/[0-9]+$/);
    for (const p of samplePaths("/f/:name{[a-z]+\\.png}")) expect(p).toMatch(/^\/f\/[a-z]+\.png$/);
  });
});
