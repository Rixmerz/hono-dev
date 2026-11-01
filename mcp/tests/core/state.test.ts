import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  appendWarning,
  consumeDirty,
  markDirty,
  stateDir,
  workspaceKey,
} from "../../core/state.ts";
import { cleanupTemps, makeProject } from "../_helpers.ts";

afterAll(cleanupTemps);

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["HONO_DEV_STATE_DIR", "CLAUDE_PLUGIN_DATA", "XDG_CACHE_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("stateDir", () => {
  it("keys by the first 16 hex chars of sha256(realpath(ws))", async () => {
    const ws = await makeProject({ "a.ts": "" });
    const expected = createHash("sha256")
      .update(await realpath(ws))
      .digest("hex")
      .slice(0, 16);
    expect(workspaceKey(ws)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a symlink to the workspace shares its state", async () => {
    const ws = await makeProject({ "a.ts": "" });
    const link = join(await mkdtemp(join(tmpdir(), "hono-dev-link-")), "ws");
    await symlink(ws, link);
    expect(workspaceKey(link)).toBe(workspaceKey(ws));
  });

  it("takes the first match: HONO_DEV_STATE_DIR, CLAUDE_PLUGIN_DATA/state, then XDG cache", async () => {
    const ws = await makeProject({ "a.ts": "" });
    const key = workspaceKey(ws);
    process.env.HONO_DEV_STATE_DIR = "/s/explicit";
    process.env.CLAUDE_PLUGIN_DATA = "/s/plugin";
    process.env.XDG_CACHE_HOME = "/s/xdg";
    expect(stateDir(ws)).toBe(`/s/explicit/${key}`);
    delete process.env.HONO_DEV_STATE_DIR;
    expect(stateDir(ws)).toBe(`/s/plugin/state/${key}`);
    delete process.env.CLAUDE_PLUGIN_DATA;
    expect(stateDir(ws)).toBe(`/s/xdg/hono-dev/${key}`);
  });

  it("never points inside the workspace under the default tests setup", async () => {
    const ws = await makeProject({ "a.ts": "" });
    expect(stateDir(ws).startsWith(ws)).toBe(false);
  });
});

describe("dirty marker", () => {
  it("collects files, merges marks, and clears on consume", async () => {
    const ws = await makeProject({ "a.ts": "" });
    await markDirty(ws, ["./src/a.ts"]);
    await markDirty(ws, ["src/b.ts", "src/a.ts"]);
    expect(await consumeDirty(ws)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    expect(await consumeDirty(ws)).toEqual(new Set());
  });

  it("marking without files means everything is stale", async () => {
    const ws = await makeProject({ "a.ts": "" });
    await markDirty(ws, ["src/a.ts"]);
    await markDirty(ws);
    expect(await consumeDirty(ws)).toBe("all");
  });

  it("writes nothing into the workspace", async () => {
    const ws = await makeProject({ "a.ts": "" });
    await markDirty(ws, ["a.ts"]);
    await appendWarning(ws, { rule: "x" });
    await expect(readFile(join(ws, ".hono-dev", "dirty.json"))).rejects.toThrow();
    await expect(readFile(join(ws, ".hono-dev", "warnings.jsonl"))).rejects.toThrow();
  });
});

describe("appendWarning", () => {
  it("appends one JSON line per record, with a timestamp", async () => {
    const ws = await makeProject({ "a.ts": "" });
    await appendWarning(ws, { file: "a.ts", rule: "M001" });
    await appendWarning(ws, { file: "b.ts", rule: "S001" });
    const lines = (await readFile(join(stateDir(ws), "warnings.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ file: "a.ts", rule: "M001" });
    expect(typeof JSON.parse(lines[1]).ts).toBe("string");
  });
});
