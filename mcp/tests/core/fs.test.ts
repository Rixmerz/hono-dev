import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  basename,
  dirname,
  globToRegExp,
  isSourceFile,
  joinRel,
  rel,
  stripExt,
  TEST_FILE_PATTERN,
  walkFiles,
} from "../../core/fs.ts";
import { cleanupTemps, makeProject } from "../_helpers.ts";

afterAll(cleanupTemps);

describe("path helpers", () => {
  it("joins ../ specifiers against a POSIX directory", () => {
    expect(joinRel("src/routes/v1", "../../services/a.ts")).toBe("src/services/a.ts");
    expect(joinRel("", "./a.ts")).toBe("a.ts");
    expect(joinRel("a/b", "../../../x")).toBe("x");
  });

  it("splits and strips names", () => {
    expect(dirname("src/a/b.ts")).toBe("src/a");
    expect(dirname("b.ts")).toBe("");
    expect(basename("src/a/b.ts")).toBe("b.ts");
    expect(stripExt("src/a.b/c.test.ts")).toBe("src/a.b/c.test");
    expect(stripExt("src/a.b/noext")).toBe("src/a.b/noext");
    expect(rel("/w", "/w/src/a.ts")).toBe("src/a.ts");
  });

  it("recognises source files and test files", () => {
    expect(isSourceFile("a.ts")).toBe(true);
    expect(isSourceFile("a.mjs")).toBe(true);
    expect(isSourceFile("a.d.ts")).toBe(false);
    expect(isSourceFile("a.json")).toBe(false);
    for (const t of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "tests/a.ts",
      "src/__tests__/a.ts",
      "a_test.js",
    ]) {
      expect(TEST_FILE_PATTERN.test(t)).toBe(true);
    }
    for (const n of ["src/latest.ts", "src/contest.ts", "src/testing/a.ts"]) {
      expect(TEST_FILE_PATTERN.test(n)).toBe(false);
    }
  });

  it("translates simple globs", () => {
    expect(globToRegExp("generated/").test("src/generated/a.ts")).toBe(true);
    expect(globToRegExp("*.min.js").test("a/b.min.js")).toBe(true);
    expect(globToRegExp("/dist").test("src/dist/a.ts")).toBe(false);
    expect(globToRegExp("**/gen/**").test("a/b/gen/c.ts")).toBe(true);
  });
});

describe("walkFiles", () => {
  it("lists source files sorted, skipping node_modules, dist and configured globs", async () => {
    const dir = await makeProject({
      "src/b.ts": "export {};",
      "src/a.ts": "export {};",
      "src/skip/x.ts": "export {};",
      "node_modules/pkg/i.ts": "export {};",
      "dist/out.js": "export {};",
      "README.md": "x",
    });
    const files = await walkFiles(dir, dir, { extensions: [".ts", ".js"], ignore: ["skip/"] });
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0].size).toBeGreaterThan(0);
  });

  it("survives unreadable and dangling entries", async () => {
    const dir = await makeProject({ "src/a.ts": "export {};" });
    await mkdir(join(dir, "empty"));
    await symlink(join(dir, "nope"), join(dir, "src", "dangling.ts"));
    await writeFile(join(dir, "src", "b.ts"), "export {};");
    const files = await walkFiles(dir, dir, { extensions: [".ts"] });
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
