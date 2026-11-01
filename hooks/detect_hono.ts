/**
 * SessionStart / CwdChanged / DirectoryAdded: say once, briefly, that this is a Hono project and how
 * to work in it. Silent when it is not. Reads manifests only (no source parse), so it fits the 5 s hook budget.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readManifests } from "../mcp/core/config.ts";
import { detectStatic } from "../mcp/core/detect.ts";
import { stateDir } from "../mcp/core/state.ts";
import { type HookInput, emitContext, projectDir } from "./hook-io.ts";

async function indexNote(dir: string): Promise<string> {
  try {
    const { mtimeMs } = await stat(join(stateDir(dir), "facts-cache.json"));
    return `index built ${Math.round((Date.now() - mtimeMs) / 60000)} min ago`;
  } catch {
    return "index not built yet (the first hono_* call builds it)";
  }
}

/** Members of a monorepo root that declare Hono; only literal member paths, globs are not expanded. */
async function honoMembers(dir: string, members: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const m of members.filter((m) => !/[*?[]/.test(m))) {
    const member = join(dir, m);
    try {
      if ((await detectStatic(member, await readManifests(member))).declaredInManifest)
        found.push(m);
    } catch {
      // an unreadable member is simply not reported
    }
  }
  return found;
}

export async function detectHono(input: HookInput): Promise<void> {
  const dir = projectDir(input);
  const st = await detectStatic(dir, await readManifests(dir));
  const members = st.declaredInManifest ? [] : await honoMembers(dir, st.workspaceMembers);
  if (!st.declaredInManifest && members.length === 0) return;

  const runtime = [...st.runtimes.keys()].join("/") || "unknown runtime";
  const lines = st.declaredInManifest
    ? [
        `[hono-dev] Hono ${st.resolved ?? st.declared ?? "?"} project (${runtime}${
          st.deployTargets.length ? `, deploys: ${st.deployTargets.join(", ")}` : ""
        }) at ${dir}; ${await indexNote(dir)}.`,
        `- Use the hono MCP tools with workspace="${dir}" (required on every call): hono_project first, then hono_route / hono_trace for a URL, hono_validate after an edit.`,
      ]
    : [
        `[hono-dev] ${dir} is a workspace root; these members declare Hono: ${members.join(", ")}.`,
        "- Pass the member directory as `workspace` to the hono MCP tools.",
      ];
  lines.push(
    "- A mounted route is served under its full composed path (/v1/contacts/:id), not the local path its handler was registered with: ask hono_routes instead of reading one file.",
    '- When briefing a vise subagent, name the skill: "Load the hono-dev:hono-development skill before your first edit", and paste hono_route / hono_impact facts as path:line.',
  );
  emitContext(input.hook_event_name ?? "SessionStart", lines.join("\n"));
}
