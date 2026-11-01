/**
 * PostToolUse / FileChanged: mark what changed as dirty in the plugin's state directory (never in
 * the project) so the next hono_* call re-parses it even when mtime and size look unchanged.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_EXTS } from "../mcp/core/fs.ts";
import { markDirty, stateDir } from "../mcp/core/state.ts";
import { type HookInput, projectDir, relativeTo } from "./hook-io.ts";

// A shell command that can rewrite many files at once: the whole index is suspect afterwards.
const TREE_CHANGING =
  /\bgit\s+(checkout|switch|pull|merge|stash|rebase|reset|restore|cherry-pick)\b|\b(npm|pnpm|yarn|bun|deno)\s+(install|ci|add|remove|i)\b/;

const MANIFEST =
  /(^|\/)(package\.json|deno\.jsonc?|tsconfig[\w.-]*\.json|wrangler\.(toml|jsonc?)|\.hono-dev\/config\.json)$/;

function relevant(rel: string): boolean {
  return MANIFEST.test(rel) || SOURCE_EXTS.some((ext) => rel.endsWith(ext));
}

export async function invalidateIndex(input: HookInput, flags: string[]): Promise<void> {
  const dir = projectDir(input);
  // no index yet for this project: everything is parsed cold on first use, nothing can be stale
  if (!existsSync(join(stateDir(dir), "facts-cache.json"))) return;

  if (flags.includes("--from-bash")) {
    const command = input.tool_input?.command;
    if (typeof command === "string" && TREE_CHANGING.test(command)) await markDirty(dir);
    return;
  }
  const file = input.tool_input?.file_path ?? input.file_path;
  if (typeof file !== "string") return;
  const rel = relativeTo(dir, file);
  if (rel !== null && relevant(rel)) await markDirty(dir, [rel]);
}
