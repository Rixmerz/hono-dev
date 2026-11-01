import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE, bundle } from "../../../scripts/build.ts";
import { cleanupTemps, copyFixture, makeProject } from "../_helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const json = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

describe("TypeScript is pinned and bundled", () => {
  it("is pinned to exactly 6.0.3 as a runtime dependency", () => {
    const pkg = json("package.json");
    expect(pkg.dependencies.typescript).toBe("6.0.3");
    expect(pkg.devDependencies?.typescript).toBeUndefined();
    expect(pkg.overrides?.typescript ?? "6.0.3").toBe("6.0.3");
  });

  it("is locked to 6.0.3", () => {
    const lock = json("package-lock.json");
    expect(lock.packages["node_modules/typescript"].version).toBe("6.0.3");
    expect(lock.packages[""].dependencies.typescript).toBe("6.0.3");
  });

  it("is inside dist/entry.cjs, not required from outside", () => {
    const text = readFileSync(BUNDLE, "utf8");
    expect(text).toContain('"6.0.3"');
    expect(text).not.toMatch(/require\(["']typescript["']\)/);
    expect(text).not.toMatch(/from\s*["']typescript["']/);
  });
});

describe("dist/entry.cjs", () => {
  it("is up to date: rebuilding from mcp/ and hooks/ gives the committed bytes", async () => {
    // hashes, not strings: a failed string comparison would print the 4 MB bundle
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const stale = "dist/entry.cjs is stale: run `npm run build` and commit dist/";
    expect(sha(await bundle()), stale).toBe(sha(readFileSync(BUNDLE, "utf8")));
  });
});

describe("the plugin as installed: bin/ and dist/ only, no node_modules anywhere", () => {
  let plugin: string;
  let work: string;
  const ws = () => join(ROOT, "fixtures", "hono-mounted");

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "hono-dev-installed-"));
    plugin = join(work, "plugin");
    mkdirSync(plugin);
    cpSync(join(ROOT, "bin"), join(plugin, "bin"), { recursive: true });
    cpSync(join(ROOT, "dist"), join(plugin, "dist"), { recursive: true });
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    await cleanupTemps();
  });

  function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    const env = { ...process.env, ...opts.env } as Record<string, string>;
    delete env.NODE_PATH;
    return spawnSync(join(plugin, "bin", "hono-mcp"), args, {
      encoding: "utf8",
      cwd: opts.cwd,
      env,
    });
  }

  it("answers the CLI with the full composed paths", () => {
    const r = run(["routes", ws(), "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).routes.map((x: { fullPath: string }) => x.fullPath)).toContain(
      "/v1/contacts/:id",
    );
    expect(run(["rules"]).stdout).toContain("R001");
  });

  it("never loads the TypeScript of the project it analyses", async () => {
    const decoy = await makeProject({
      "package.json": JSON.stringify({ dependencies: { hono: "4.13.16", typescript: "5.0.0" } }),
      "node_modules/typescript/package.json": JSON.stringify({
        name: "typescript",
        main: "index.js",
      }),
      "node_modules/typescript/index.js": 'throw new Error("the project TypeScript was loaded");',
      "src/app.ts":
        'import { Hono } from "hono";\nexport const app = new Hono().get("/ping", (c) => c.text("pong"));\n',
    });
    const r = run(["routes", decoy, "--json"], { cwd: decoy });
    expect(r.stderr).not.toContain("the project TypeScript was loaded");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).routes.map((x: { fullPath: string }) => x.fullPath)).toEqual([
      "/ping",
    ]);
  });

  it("serves the 12 tools over stdio through hono-dev-run mcp", async () => {
    const client = new Client({ name: "hono-dev-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: join(plugin, "bin", "hono-dev-run"),
        args: ["mcp"],
        env: { ...process.env } as Record<string, string>,
        stderr: "pipe",
      }),
    );
    try {
      expect((await client.listTools()).tools).toHaveLength(12);
      const res = await client.callTool({ name: "hono_project", arguments: { workspace: ws() } });
      const text = (res.content as { text: string }[])[0]?.text ?? "";
      expect(JSON.parse(text)).toMatchObject({ ok: true, isHono: true });
    } finally {
      await client.close();
    }
  });

  it("keeps the cache in the plugin data directory, nothing in the project", async () => {
    const copy = await copyFixture("hono-mounted");
    const data = join(work, "plugin-data");
    const r = run(["validate", copy], {
      env: { CLAUDE_PLUGIN_DATA: data, HONO_DEV_STATE_DIR: "" },
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(data, "state"))).toBe(true);
    expect(existsSync(join(copy, ".hono-dev"))).toBe(false);
  });

  it("runs a hook through the launcher and always exits 0", () => {
    const r = spawnSync(join(plugin, "bin", "hono-dev-run"), ["hook", "detect"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: ws() }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("Hono 4.");
  });

  describe("without a usable Node", () => {
    let bin: string;
    beforeAll(() => {
      bin = join(work, "path-bin");
      mkdirSync(bin);
      for (const tool of ["dirname", "sh"]) {
        symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
      }
    });
    const launch = (mode: string[], path: string) =>
      spawnSync("/usr/bin/sh", [join(plugin, "bin", "hono-dev-run"), ...mode], {
        encoding: "utf8",
        env: { PATH: path },
      });

    it("mcp refuses to start and says why; hooks stay silent", () => {
      const missing = launch(["mcp"], bin);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("Node 24 or newer");
      expect(launch(["cli", "rules"], bin).status).toBe(3);
      expect(launch(["hook", "detect"], bin)).toMatchObject({ status: 0, stdout: "" });
    });

    it("an older Node is refused the same way", () => {
      const old = join(work, "old-node");
      mkdirSync(old);
      for (const tool of ["dirname", "sh"]) symlinkSync(`/usr/bin/${tool}`, join(old, tool));
      writeFileSync(join(old, "node"), "#!/bin/sh\necho v22.11.0\n");
      chmodSync(join(old, "node"), 0o755);
      const r = launch(["mcp"], old);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Node 24 or newer");
    });
  });
});
