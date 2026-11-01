import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Directories whose content is not ours to police: installed or built code and generated results.
// Sample projects under fixtures/ are scanned for their Markdown only: their source imports are the
// subject of the tests, but docs such as EXPECTED.md do cite this repo.
// Generated results are gitignored, so a README may name them without them being in the tree.
const GENERATED = new Set(["evals/results"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "results", ".hono-dev"]);
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".json", ".jsonc", ".yaml", ".yml", ".snippet"]);
// This file spells made-up paths on purpose.
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

// A path-looking token is a repo citation when it starts at one of the repo's top-level
// directories or is explicitly relative (./ or ../). The roots are read from the tree so a new
// top-level directory is covered without editing this file.
const REPO_ROOTS = new Set(
  readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name),
);

const PATH_TOKEN =
  /(?<![\w@$./-])((?:\$\{CLAUDE_PLUGIN_ROOT\}\/|(?:\.\.?\/)+)?[\w.-]*\w(?:\/[\w.-]*\w)+)\/?(?![\w*/-])/g;
// `/hono-dev:init` style slash commands; each is a skills/<name>/SKILL.md.
const SLASH_COMMAND = /(?<![\w/])\/hono-dev:([a-z][a-z-]*)/g;

function inFixtures(file: string): boolean {
  return relative(ROOT, file).split(sep)[0] === "fixtures";
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...sourceFiles(join(dir, entry.name)));
    } else if (!entry.isFile() || SKIP_FILES.has(entry.name)) {
      // Symlinks (including ones to directories) and other non-regular entries are not read.
    } else if (inFixtures(join(dir, entry.name)) && extname(entry.name) !== ".md") {
      // Fixture sources are the analysed project, not ours.
    } else if (TEXT_EXTENSIONS.has(extname(entry.name)) || !entry.name.includes(".")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

/** A cited path resolves when it exists; an ADR cited by number (`docs/adr/0002`) when a file starts with it. */
function resolves(target: string): boolean {
  if (existsSync(target)) return true;
  const dir = dirname(target);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const stem = target.slice(dir.length + 1);
  return /^\d+$/.test(stem) && readdirSync(dir).some((name) => name.startsWith(`${stem}-`));
}

function dangling(): string[] {
  const missing: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const rel = relative(ROOT, file);
    if (rel === SELF) continue;
    const text = readFileSync(file, "utf8");
    for (const [, token] of text.matchAll(PATH_TOKEN)) {
      if (token === undefined) continue;
      const cited = token.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, "");
      const relativeCite = cited.startsWith("../");
      // Relative paths are citations only between docs; elsewhere they are the analysed project's own files.
      if (relativeCite && (extname(file) !== ".md" || !cited.endsWith(".md"))) continue;
      if (GENERATED.has(cited)) continue;
      if (!relativeCite && !REPO_ROOTS.has(cited.split("/")[0] ?? "")) continue;
      const target = relativeCite ? normalize(join(dirname(file), cited)) : join(ROOT, cited);
      if (!resolves(target)) missing.push(`${rel}: ${token}`);
    }
    for (const [, name] of text.matchAll(SLASH_COMMAND)) {
      if (!existsSync(join(ROOT, "skills", name ?? "", "SKILL.md"))) {
        missing.push(`${rel}: /hono-dev:${name}`);
      }
    }
  }
  return [...new Set(missing)].sort();
}

describe("repo citations", () => {
  it("scans the files that hold citations", () => {
    const scanned = sourceFiles(ROOT).map((f) => relative(ROOT, f));
    expect(scanned).toContain("README.md");
    expect(scanned).toContain("skills/hono-development/SKILL.md");
    expect(scanned).toContain("mcp/core/state.ts");
    expect(scanned).toContain("evals/README.md");
    expect(scanned).toContain("fixtures/hono-mounted/EXPECTED.md");
  });

  it("recognises a citation to a missing file", () => {
    expect(resolves(join(ROOT, "docs/adr/9999"))).toBe(false);
    expect(resolves(join(ROOT, "skills/_shared/references/does-not-exist.md"))).toBe(false);
    expect(resolves(join(ROOT, "skills/_shared/references/tools.md"))).toBe(true);
  });

  it("cites only paths, ADRs and commands that exist", () => {
    expect(dangling()).toEqual([]);
  });
});
