import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../version.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as Record<string, unknown>;
}

const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".mcp.json"];

// Claude Code's own placeholders: expanded when the plugin loads, never by JavaScript.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder, not a template
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder, not a template
const PLUGIN_DATA = "${CLAUDE_PLUGIN_DATA}";

describe("release manifests", () => {
  it.each(MANIFESTS)("%s parses as JSON", (rel) => {
    expect(() => readJson(rel)).not.toThrow();
  });

  describe(".claude-plugin/plugin.json", () => {
    const plugin = readJson(".claude-plugin/plugin.json");

    it("carries the identity fields", () => {
      expect(plugin.name).toBe("hono-dev");
      expect(plugin.author).toEqual({ name: "Juan Pablo Diaz" });
      expect(plugin.homepage).toBe("https://github.com/Rixmerz/hono-dev");
      expect(plugin.repository).toBe("https://github.com/Rixmerz/hono-dev");
      expect(plugin.license).toBe("MIT");
      expect(typeof plugin.description).toBe("string");
      expect(plugin.keywords).toEqual(expect.arrayContaining(["hono", "mcp"]));
    });

    it("has the same version as mcp/version.ts and package.json", () => {
      const pkg = readJson("package.json");
      expect(plugin.version).toBe(VERSION);
      expect(plugin.version).toBe(pkg.version);
    });
  });

  describe(".claude-plugin/marketplace.json", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const entries = marketplace.plugins as Record<string, unknown>[];

    it("is the local dev marketplace and does not claim the published rixmerz name", () => {
      expect(marketplace.name).toBe("hono-dev-local");
      expect(marketplace.name).not.toBe("rixmerz");
    });

    it("lists this repository as the only plugin, from the repo root", () => {
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ name: "hono-dev", source: "./", version: VERSION });
    });
  });

  describe(".mcp.json", () => {
    const servers = readJson(".mcp.json").mcpServers as Record<string, Record<string, unknown>>;

    it("declares exactly one server, named hono", () => {
      expect(Object.keys(servers)).toEqual(["hono"]);
    });

    it("starts it through bin/hono-dev-run mcp", () => {
      expect(servers.hono?.command).toBe(`${PLUGIN_ROOT}/bin/hono-dev-run`);
      expect(servers.hono?.args).toEqual(["mcp"]);
    });

    it("keeps the state under the plugin data directory", () => {
      expect(servers.hono?.env).toEqual({ HONO_DEV_STATE_DIR: `${PLUGIN_DATA}/state` });
    });
  });
});
