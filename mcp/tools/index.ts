/** Tool registry: runs a tool against a workspace and registers all of them on an MCP server. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IndexError, type IndexManager } from "../core/index.ts";
import { type Caller, TOOLS, type ToolDef, ToolFailure } from "./definitions.ts";

export { TOOLS } from "./definitions.ts";

export type Outcome = {
  /** ok: answered; not-hono / bad-workspace: the CLI exits 2; failed: it exits 3. */
  status: "ok" | "not-hono" | "bad-workspace" | "failed";
  payload: Record<string, unknown>;
};

const failure = (error: string, hint: string | null, extra: Record<string, unknown> = {}) => ({
  ok: false,
  error,
  hint,
  ...extra,
});

/** Validate the arguments, load the index, gate on Hono, run. Never throws. */
export async function callTool(
  manager: IndexManager,
  tool: ToolDef,
  input: { workspace: string } & Record<string, unknown>,
  caller: Caller,
): Promise<Outcome> {
  try {
    const { workspace, ...rest } = input;
    const parsed = z.object(tool.shape).safeParse(rest);
    if (!parsed.success) {
      const error = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
        .join("; ");
      return { status: "failed", payload: failure(`invalid arguments: ${error}`, null) };
    }
    const args = parsed.data as never;
    const idx = await manager.get(workspace, { force: tool.forceReload?.(args) ?? false });
    if (tool.requiresHono && !idx.detection.isHono) {
      return {
        status: "not-hono",
        payload: failure(
          `${idx.workspace} is not a Hono project`,
          "pass the directory that holds the package.json or deno.json declaring hono; hono_project explains what was looked for",
          { evidence: idx.detection.evidence },
        ),
      };
    }
    const payload = (await tool.run(idx, args, caller)) as Record<string, unknown>;
    // only hono_project gets here on a workspace that is not Hono: it answers, with ok: false
    return { status: idx.detection.isHono ? "ok" : "not-hono", payload };
  } catch (e) {
    if (e instanceof IndexError) {
      return { status: "bad-workspace", payload: failure(e.message, e.hint) };
    }
    if (e instanceof ToolFailure) {
      return { status: "failed", payload: failure(e.message, e.hint, e.extra) };
    }
    return {
      status: "failed",
      payload: failure(e instanceof Error ? e.message : String(e), null),
    };
  }
}

const workspaceArg = z
  .string()
  .describe(
    "Absolute path of the Hono project root (the directory holding package.json or deno.json). Required on every call; there is no cwd fallback.",
  );

export function registerTools(server: McpServer, manager: IndexManager): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: { workspace: workspaceArg, ...tool.shape },
        annotations: { readOnlyHint: tool.writes === "nothing", openWorldHint: false },
      },
      async (input: { workspace: string } & Record<string, unknown>) => {
        const { status, payload } = await callTool(manager, tool, input, "mcp");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }],
          ...(status === "ok" ? {} : { isError: true }),
        };
      },
    );
  }
}
