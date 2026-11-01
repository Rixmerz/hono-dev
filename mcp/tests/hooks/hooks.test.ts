import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SOURCE_EXTS } from "../../core/fs.ts";
import { ProjectIndex } from "../../core/index.ts";
import { stateDir } from "../../core/state.ts";
import { TOOLS } from "../../tools/index.ts";
import { cleanupTemps, copyFixture, makeProject } from "../_helpers.ts";

afterAll(cleanupTemps);

const ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const ENTRY = join(ROOT, "mcp", "entry.ts");

function hook(
  name: string[],
  input: unknown,
  env: Record<string, string> = {},
): { code: number | null; out: string } {
  const { CLAUDE_PROJECT_DIR: _session, ...rest } = process.env;
  const r = spawnSync(process.execPath, [ENTRY, "hook", ...name], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    // a hook with no usable input falls back to its working directory: keep that out of this repo
    cwd: tmpdir(),
    env: { ...rest, ...env },
  });
  return { code: r.status, out: r.stdout };
}

function context(out: string): string {
  const parsed = JSON.parse(out);
  expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
  return parsed.hookSpecificOutput.additionalContext;
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

describe("hook: detect", () => {
  it("says once, with the workspace to pass, that this is a Hono project", async () => {
    const ws = await copyFixture("hono-mounted");
    const r = hook(["detect"], { hook_event_name: "SessionStart", cwd: ws });
    expect(r.code).toBe(0);
    const text = context(r.out);
    expect(JSON.parse(r.out).hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(text).toContain("Hono 4.");
    expect(text).toContain(`workspace="${ws}"`);
    expect(text).toContain("index not built yet");
  });

  it("reports the age of an existing index", async () => {
    const ws = await copyFixture("hono-mounted");
    await ProjectIndex.load(ws);
    expect(context(hook(["detect"], { cwd: ws }).out)).toMatch(/index built \d+ min ago/);
  });

  it("names the members of a monorepo root that declare Hono", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["packages/api", "packages/web"],
      }),
      "packages/api/package.json": JSON.stringify({ dependencies: { hono: "^4.6.0" } }),
      "packages/web/package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    });
    const text = context(hook(["detect"], { hook_event_name: "CwdChanged", cwd: root }).out);
    expect(text).toContain("packages/api");
    expect(text).not.toContain("packages/web");
  });

  it("is silent outside a Hono project, when disabled, and on garbage input", async () => {
    const plain = await makeProject({ "package.json": JSON.stringify({ name: "x" }) });
    expect(hook(["detect"], { cwd: plain })).toEqual({ code: 0, out: "" });
    const ws = await copyFixture("hono-mounted");
    for (const off of ["off", "0", "false", "OFF"]) {
      expect(hook(["detect"], { cwd: ws }, { HONO_DEV_HOOKS: off }), off).toEqual({
        code: 0,
        out: "",
      });
    }
    expect(hook(["detect"], "{ not json")).toEqual({ code: 0, out: "" });
    expect(hook(["detect"], { cwd: "/definitely/not/a/dir" })).toEqual({ code: 0, out: "" });
  });

  it("exits 0 for an unknown hook name and for none", () => {
    expect(hook(["frobnicate"], {})).toEqual({ code: 0, out: "" });
    expect(hook([], {})).toEqual({ code: 0, out: "" });
  });
});

describe("hook: invalidate", () => {
  async function indexed() {
    const ws = await copyFixture("hono-mounted");
    await ProjectIndex.load(ws);
    return ws;
  }
  const marker = (ws: string) => join(stateDir(ws), "dirty.json");

  it("marks the edited file dirty in the state directory, not in the project", async () => {
    const ws = await indexed();
    const before = await listing(ws);
    const file = join(ws, "src", "routes", "v1", "contacts.ts");
    const r = hook(["invalidate"], {
      hook_event_name: "PostToolUse",
      cwd: ws,
      tool_name: "Edit",
      tool_input: { file_path: file },
    });
    expect(r).toEqual({ code: 0, out: "" });
    expect(JSON.parse(await readFile(marker(ws), "utf8"))).toEqual({
      all: false,
      paths: ["src/routes/v1/contacts.ts"],
    });
    expect(await listing(ws)).toEqual(before);
  });

  it("marks a manifest from a FileChanged event", async () => {
    const ws = await indexed();
    hook(["invalidate"], {
      hook_event_name: "FileChanged",
      cwd: ws,
      file_path: join(ws, "package.json"),
    });
    expect(JSON.parse(await readFile(marker(ws), "utf8")).paths).toEqual(["package.json"]);
  });

  it("marks everything after a shell command that rewrites the tree, and ignores the rest", async () => {
    const ws = await indexed();
    hook(["invalidate", "--from-bash"], { cwd: ws, tool_input: { command: "ls -la" } });
    expect(existsSync(marker(ws))).toBe(false);
    hook(["invalidate", "--from-bash"], { cwd: ws, tool_input: { command: "git checkout main" } });
    expect(JSON.parse(await readFile(marker(ws), "utf8")).all).toBe(true);
  });

  it("ignores files that are not source or manifests, and files outside the project", async () => {
    const ws = await indexed();
    hook(["invalidate"], { cwd: ws, tool_input: { file_path: join(ws, "README.md") } });
    hook(["invalidate"], { cwd: ws, tool_input: { file_path: "/etc/hosts" } });
    expect(existsSync(marker(ws))).toBe(false);
  });

  it("creates no state for a project that was never indexed", async () => {
    const ws = await copyFixture("hono-mounted");
    hook(["invalidate"], { cwd: ws, tool_input: { file_path: join(ws, "src", "app.ts") } });
    expect(existsSync(stateDir(ws))).toBe(false);
  });

  it("makes the next index re-parse a file even when its size and mtime are unchanged", async () => {
    const ws = await indexed();
    const file = join(ws, "src", "app.ts");
    hook(["invalidate"], { cwd: ws, tool_input: { file_path: file } });
    const idx = await ProjectIndex.load(ws);
    expect(idx.stats.parsed).toBe(1);
  });
});

describe("hook: validate", () => {
  it("hands back the findings of the edited file and logs them in the state directory", async () => {
    const ws = await copyFixture("hono-violations");
    const before = await listing(ws);
    const r = hook(["validate"], {
      hook_event_name: "PostToolUse",
      cwd: ws,
      tool_name: "Edit",
      tool_input: { file_path: join(ws, "src", "routes", "items.ts") },
    });
    expect(r.code).toBe(0);
    const text = context(r.out);
    expect(JSON.parse(r.out).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(text).toContain("[hono-dev] src/routes/items.ts");
    expect(text).toMatch(/- [A-Z]\d{3} src\/routes\/items\.ts:\d+ /);
    const log = (await readFile(join(stateDir(ws), "warnings.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(log[0] as string)).toMatchObject({ file: "src/routes/items.ts" });
    expect(await listing(ws)).toEqual(before);
  });

  it("stays silent for a clean file, a non-source file and a non-Hono project", async () => {
    const clean = await copyFixture("hono-node");
    const r = hook(["validate"], {
      cwd: clean,
      tool_input: { file_path: join(clean, "src", "services", "post.service.ts") },
    });
    expect(r).toEqual({ code: 0, out: "" });
    expect(
      hook(["validate"], { cwd: clean, tool_input: { file_path: join(clean, "package.json") } })
        .out,
    ).toBe("");
    const notHono = await copyFixture("not-hono");
    const files = (await listing(notHono)).filter((f) => SOURCE_EXTS.some((e) => f.endsWith(e)));
    for (const f of files.slice(0, 1)) {
      expect(
        hook(["validate"], { cwd: notHono, tool_input: { file_path: join(notHono, f) } }).out,
      ).toBe("");
    }
  });

  it("fails open: bad input never blocks the edit", () => {
    expect(hook(["validate"], "garbage")).toEqual({ code: 0, out: "" });
    expect(
      hook(["validate"], {
        cwd: "/definitely/not/a/dir",
        tool_input: { file_path: "/definitely/not/a/dir/a.ts" },
      }),
    ).toEqual({
      code: 0,
      out: "",
    });
  });

  it("is silenced by HONO_DEV_HOOKS=off", async () => {
    const ws = await copyFixture("hono-violations");
    const r = hook(
      ["validate"],
      { cwd: ws, tool_input: { file_path: join(ws, "src", "routes", "items.ts") } },
      { HONO_DEV_HOOKS: "off" },
    );
    expect(r).toEqual({ code: 0, out: "" });
  });
});

describe("hooks/hooks.json", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { matcher?: string; if?: string; hooks: Record<string, unknown>[] }[]>;
  };

  const all = Object.entries(config.hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.map((h) => ({ event, group: g, hook: h }))),
  );

  it("wires the three behaviours to the events the README promises", () => {
    expect(Object.keys(config.hooks).sort()).toEqual(
      ["CwdChanged", "DirectoryAdded", "FileChanged", "PostToolUse", "SessionStart"].sort(),
    );
    const names = (event: string) =>
      all
        .filter((a) => a.event === event && a.hook.type === "command")
        .map((a) => String(a.hook.command).match(/hook (\w+)/)?.[1]);
    expect(names("SessionStart")).toEqual(["detect"]);
    expect(names("CwdChanged")).toEqual(["detect"]);
    expect(names("DirectoryAdded")).toEqual(["detect"]);
    expect(names("PostToolUse")).toEqual(["invalidate", "validate", "invalidate"]);
    expect(names("FileChanged")).toEqual(["invalidate"]);
  });

  it("runs every command through the launcher, with a timeout", () => {
    for (const { hook: h } of all.filter((a) => a.hook.type === "command")) {
      expect(h.command).toMatch(
        /^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hono-dev-run" hook (detect|invalidate|validate)/,
      );
      expect(typeof h.timeout).toBe("number");
    }
    expect(existsSync(join(ROOT, "bin", "hono-dev-run"))).toBe(true);
  });

  it("asks the plugin's own hono server to reindex the session's working directory", () => {
    const mcp = all.filter((a) => a.hook.type === "mcp_tool");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]?.hook).toMatchObject({
      server: "plugin:hono-dev:hono",
      tool: "hono_reindex",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code placeholder, not a template
      input: { workspace: "${cwd}" },
    });
    expect(TOOLS.map((t) => t.name)).toContain("hono_reindex");
  });

  it("only fires for edits to source files and manifests the index reads", () => {
    const edit = config.hooks.PostToolUse?.[0];
    expect(edit?.matcher).toBe("Edit|Write|MultiEdit");
    for (const ext of SOURCE_EXTS) expect(edit?.if, ext).toContain(`**/*${ext})`);
    for (const manifest of [
      "package.json",
      "deno.json",
      "deno.jsonc",
      "tsconfig*.json",
      "wrangler.*",
    ]) {
      expect(edit?.if, manifest).toContain(`**/${manifest})`);
    }
  });
});
