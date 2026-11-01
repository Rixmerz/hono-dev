import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseJsonc, readHonoDevConfig, readManifests } from "../../core/config.ts";
import { cleanupTemps, makeProject } from "../_helpers.ts";

afterAll(cleanupTemps);

describe("parseJsonc", () => {
  it("accepts comments and trailing commas through the TypeScript parser", () => {
    expect(parseJsonc(`{ // c\n "a": [1, 2,], /* x */ "b": "// not a comment", }`)).toEqual({
      a: [1, 2],
      b: "// not a comment",
    });
  });

  it("returns null for text that is not an object-shaped JSON document", () => {
    expect(parseJsonc("{ nope")).toBeNull();
  });
});

describe("readHonoDevConfig", () => {
  it("returns the defaults when the file is absent", async () => {
    const ws = await makeProject({ "a.ts": "" });
    expect(await readHonoDevConfig(ws)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.serviceDirs).toEqual(["src/services", "services", "src/lib"]);
    expect(DEFAULT_CONFIG.maxFileBytes).toBe(1_000_000);
  });

  it("reads overrides, ignoring wrongly typed values", async () => {
    const ws = await makeProject({
      ".hono-dev/config.json": `{ "ignore": ["gen/"], "maxFileBytes": 10, "entry": "src/x.ts", "dbSpecifiers": ["my-orm"], "authMiddleware": ["gate"], "serviceDirs": ["svc"], "envValidationModules": ["src/env.ts"], "extra": 1, }`,
    });
    expect(await readHonoDevConfig(ws)).toEqual({
      ignore: ["gen/"],
      maxFileBytes: 10,
      entry: "src/x.ts",
      dbSpecifiers: ["my-orm"],
      authMiddleware: ["gate"],
      serviceDirs: ["svc"],
      envValidationModules: ["src/env.ts"],
    });
    const bad = await makeProject({
      ".hono-dev/config.json": `{ "ignore": "oops", "maxFileBytes": "big" }`,
    });
    expect(await readHonoDevConfig(bad)).toEqual(DEFAULT_CONFIG);
  });

  it("falls back to defaults on a corrupt file", async () => {
    const ws = await makeProject({ ".hono-dev/config.json": "{ nope" });
    expect(await readHonoDevConfig(ws)).toEqual(DEFAULT_CONFIG);
  });
});

describe("readManifests", () => {
  it("merges deno.json imports with an external importMap and reads workspace members", async () => {
    const ws = await makeProject({
      "deno.jsonc": `{ // jsonc\n "importMap": "./map.json", "imports": { "hono": "npm:hono@4" }, "workspace": ["./packages/api/"] }`,
      "map.json": `{ "imports": { "hono": "npm:hono@3", "zod": "npm:zod@3" } }`,
    });
    const m = await readManifests(ws);
    expect(m.denoJson?.path).toBe("deno.jsonc");
    expect(m.denoImports).toEqual({ hono: "npm:hono@4", zod: "npm:zod@3" });
    expect(m.workspaceMembers).toEqual(["packages/api"]);
  });

  it("collects every dependency group and package.json workspaces", async () => {
    const ws = await makeProject({
      "package.json": `{ "dependencies": {"hono":"^4"}, "devDependencies": {"vitest":"5"}, "peerDependencies": {"zod":"4"}, "workspaces": {"packages": ["apps/*"]}, "imports": {"#x": "./x.ts"} }`,
    });
    const m = await readManifests(ws);
    expect(Object.keys(m.deps).sort()).toEqual(["hono", "vitest", "zod"]);
    expect(m.workspaceMembers).toEqual(["apps/*"]);
    expect(m.pkgImports).toEqual({ "#x": "./x.ts" });
  });

  it("follows tsconfig extends to find paths", async () => {
    const ws = await makeProject({
      "tsconfig.json": `{ "extends": "./base", }`,
      "base.json": `{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"] } } }`,
    });
    const m = await readManifests(ws);
    expect(m.tsPaths).toEqual({ baseDir: "src", paths: { "@/*": ["*"] } });
  });

  it("reports nothing for a bare directory", async () => {
    const m = await readManifests(await makeProject({ "a.ts": "" }));
    expect(m.packageJson).toBeNull();
    expect(m.denoJson).toBeNull();
    expect(m.tsPaths).toBeNull();
    expect(m.workspaceMembers).toEqual([]);
  });
});
