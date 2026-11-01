import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../version.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// The 12 tools of the plugin contract; the README must list exactly these.
const TOOLS = [
  "hono_project",
  "hono_routes",
  "hono_route",
  "hono_middleware",
  "hono_validators",
  "hono_rpc",
  "hono_trace",
  "hono_dependencies",
  "hono_impact",
  "hono_validate",
  "hono_graph_export",
  "hono_reindex",
];

// The 13 commands of bin/hono-mcp.
const COMMANDS = [
  "project",
  "routes",
  "route",
  "middleware",
  "validators",
  "rpc",
  "trace",
  "deps",
  "impact",
  "validate",
  "export",
  "reindex",
  "rules",
];

function toolNames(text: string): string[] {
  return [...new Set(text.match(/\bhono_[a-z]+(?:_[a-z]+)*\b/g) ?? [])].sort();
}

const DOCS = ["README.md", "CHANGELOG.md", "skills/init/SKILL.md"];

describe("README.md", () => {
  const readme = read("README.md");

  it("lists exactly the 12 tools of the contract", () => {
    expect(toolNames(readme)).toEqual([...TOOLS].sort());
  });

  it("documents the 13 CLI commands", () => {
    expect(COMMANDS).toHaveLength(13);
    for (const command of COMMANDS) expect(readme).toContain(`\`${command}\``);
  });

  it("states the constraints and the pointers it promises", () => {
    for (const fact of [
      "6.0.3",
      "HONO_DEV_HOOKS=off",
      "skills/_shared/references/rules.md",
      "HONO_DEV_STATE_DIR",
      ".hono-dev/graph.json",
      "hono-dev-local",
    ]) {
      expect(readme, fact).toContain(fact);
    }
  });
});

describe("CHANGELOG.md", () => {
  it("opens with the current version and its release date", () => {
    const heading = read("CHANGELOG.md").match(/^## (\S+) — (\d{4}-\d{2}-\d{2})$/m);
    expect(heading?.slice(1)).toEqual([VERSION, "2026-11-01"]);
  });
});

describe("skills/init/SKILL.md", () => {
  const init = read("skills/init/SKILL.md");

  it("is a user command named init that calls hono_project", () => {
    expect(init).toMatch(/^name: init$/m);
    expect(init).toMatch(/^disable-model-invocation: true$/m);
    expect(init).toContain("hono_project");
  });

  it("prints snippets that exist in integrations/ and never writes into the project", () => {
    for (const snippet of [
      "integrations/livespec/livespec.toml.snippet",
      "integrations/gitignore.snippet",
    ]) {
      expect(init).toContain(snippet);
      expect(existsSync(join(ROOT, snippet)), snippet).toBe(true);
    }
    expect(init).toMatch(/never writes|writes nothing|do not (edit|write|create)/i);
  });
});

describe.each(DOCS)("%s", (rel) => {
  const text = read(rel);

  it("names only tools of the contract", () => {
    for (const name of toolNames(text)) expect(TOOLS, name).toContain(name);
  });

  it("never spells a prefixed plugin tool id or a tool glob", () => {
    expect(text).not.toContain("mcp__");
    expect(text).not.toMatch(/hono_\*/);
  });
});
