import { describe, expect, it } from "vitest";
import type { Manifests } from "../../core/config.ts";
import {
  canonicalSpecifier,
  isHonoSpecifier,
  packageOf,
  resolveSpecifier,
} from "../../core/resolve.ts";

const manifests = (over: Partial<Manifests> = {}): Manifests => ({
  packageJson: null,
  denoJson: null,
  tsconfig: null,
  denoImports: {},
  denoDir: "",
  deps: {},
  pkgImports: {},
  tsPaths: null,
  workspaceMembers: [],
  ...over,
});
const ctx = (files: string[], over: Partial<Manifests> = {}) => ({
  manifests: manifests(over),
  files: new Set(files),
});

describe("canonicalSpecifier", () => {
  it.each([
    ["npm:hono@4", "hono"],
    ["jsr:@hono/hono@^4", "hono"],
    ["@hono/hono", "hono"],
    ["hono", "hono"],
    ["npm:hono@4.6.0/cors", "hono/cors"],
    ["jsr:@hono/hono@^4/cors", "hono/cors"],
    ["hono/cors", "hono/cors"],
    ["npm:@hono/zod-validator@0.4.2", "@hono/zod-validator"],
    ["@hono/zod-validator", "@hono/zod-validator"],
    ["npm:zod@3.24.1", "zod"],
    ["node:fs", "node:fs"],
    ["https://deno.land/x/hono@v4.0.0/mod.ts", "hono"],
    ["https://deno.land/x/hono@v4.0.0/middleware/cors/index.ts", "hono/cors"],
    ["https://esm.sh/hono@4/cors", "hono/cors"],
    ["./local.ts", "./local.ts"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalSpecifier(input)).toBe(expected);
  });

  it("knows the Hono family", () => {
    expect(isHonoSpecifier("hono")).toBe(true);
    expect(isHonoSpecifier("hono/jwt")).toBe(true);
    expect(isHonoSpecifier("@hono/zod-validator")).toBe(false);
    expect(isHonoSpecifier("honey")).toBe(false);
    expect(packageOf("@hono/zod-validator/x")).toBe("@hono/zod-validator");
    expect(packageOf("hono/cors")).toBe("hono");
  });
});

describe("resolveSpecifier", () => {
  const files = [
    "src/app.ts",
    "src/routes/a.ts",
    "src/util/index.ts",
    "src/lib/x.ts",
    "src/types.mts",
  ];

  it("resolves relative imports with explicit extensions, .js → .ts, extensionless and index", () => {
    const c = ctx(files);
    expect(resolveSpecifier("./routes/a.ts", "src/app.ts", c)).toEqual({
      kind: "local",
      path: "src/routes/a.ts",
      viaMap: false,
    });
    expect(resolveSpecifier("./routes/a.js", "src/app.ts", c)).toMatchObject({
      kind: "local",
      path: "src/routes/a.ts",
    });
    expect(resolveSpecifier("./routes/a", "src/app.ts", c)).toMatchObject({
      kind: "local",
      path: "src/routes/a.ts",
    });
    expect(resolveSpecifier("./util", "src/app.ts", c)).toMatchObject({
      kind: "local",
      path: "src/util/index.ts",
    });
    expect(resolveSpecifier("./types.mjs", "src/app.ts", c)).toMatchObject({
      kind: "local",
      path: "src/types.mts",
    });
    expect(resolveSpecifier("../app.ts", "src/routes/a.ts", c)).toMatchObject({
      path: "src/app.ts",
    });
  });

  it("separates missing files from assets", () => {
    const c = ctx(files);
    expect(resolveSpecifier("./missing.ts", "src/app.ts", c)).toEqual({
      kind: "unresolved",
      specifier: "./missing.ts",
      reason: "file not found",
    });
    expect(resolveSpecifier("./data.json", "src/app.ts", c)).toEqual({
      kind: "asset",
      path: "src/data.json",
    });
  });

  it("resolves deno.json imports: exact keys, prefix maps and jsr/npm expansion", () => {
    const c = ctx(files, {
      denoImports: {
        hono: "jsr:@hono/hono@^4",
        "hono/": "jsr:@hono/hono@^4/",
        "@/": "./src/",
        zod: "npm:zod@3",
      },
    });
    expect(resolveSpecifier("hono", "src/app.ts", c)).toEqual({
      kind: "external",
      specifier: "jsr:@hono/hono@^4",
      canonical: "hono",
    });
    expect(resolveSpecifier("hono/cors", "src/app.ts", c)).toMatchObject({
      kind: "external",
      canonical: "hono/cors",
    });
    expect(resolveSpecifier("@/lib/x.ts", "src/app.ts", c)).toEqual({
      kind: "local",
      path: "src/lib/x.ts",
      viaMap: true,
    });
    expect(resolveSpecifier("zod", "src/app.ts", c)).toMatchObject({ canonical: "zod" });
  });

  it("expands a bare npm key to its subpaths without a prefix entry", () => {
    const c = ctx(files, { denoImports: { hono: "npm:hono@4" } });
    expect(resolveSpecifier("hono/jwt", "src/app.ts", c)).toMatchObject({
      kind: "external",
      canonical: "hono/jwt",
    });
  });

  it("resolves package.json #imports with wildcards and conditions", () => {
    const c = ctx(files, {
      pkgImports: {
        "#lib/*": { node: "./src/lib/*.ts", default: "./nope/*.ts" },
        "#app": "./src/app.ts",
      },
    });
    expect(resolveSpecifier("#lib/x", "src/routes/a.ts", c)).toEqual({
      kind: "local",
      path: "src/lib/x.ts",
      viaMap: true,
    });
    expect(resolveSpecifier("#app", "src/routes/a.ts", c)).toMatchObject({ path: "src/app.ts" });
    expect(resolveSpecifier("#missing", "src/app.ts", c)).toMatchObject({ kind: "unresolved" });
  });

  it("resolves tsconfig paths relative to their base", () => {
    const c = ctx(files, { tsPaths: { baseDir: "src", paths: { "~/*": ["*"], lib: ["lib/x"] } } });
    expect(resolveSpecifier("~/app", "src/routes/a.ts", c)).toEqual({
      kind: "local",
      path: "src/app.ts",
      viaMap: true,
    });
    expect(resolveSpecifier("lib", "src/routes/a.ts", c)).toMatchObject({ path: "src/lib/x.ts" });
  });

  it("treats everything else as external with a canonical specifier", () => {
    const c = ctx(files);
    expect(resolveSpecifier("npm:hono@4", "src/app.ts", c)).toEqual({
      kind: "external",
      specifier: "npm:hono@4",
      canonical: "hono",
    });
    expect(resolveSpecifier("node:fs", "src/app.ts", c)).toMatchObject({ canonical: "node:fs" });
    expect(resolveSpecifier("@prisma/client", "src/app.ts", c)).toMatchObject({
      canonical: "@prisma/client",
    });
  });
});
