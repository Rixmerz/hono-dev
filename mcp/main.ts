/**
 * The `hono` MCP server over stdio. stdout belongs to the protocol: anything that is not a JSON-RPC
 * frame written there corrupts the session, so diagnostics go to stderr only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IndexManager } from "./core/index.ts";
import { registerTools } from "./tools/index.ts";
import { VERSION } from "./version.ts";

export async function runMcp(args: string[]): Promise<void> {
  if (!args.includes("--stdio")) {
    console.error("hono-dev mcp: pass --stdio (the only transport). For the CLI use `cli`.");
    process.exitCode = 2;
    return;
  }
  const server = new McpServer(
    { name: "hono", version: VERSION },
    {
      instructions:
        "Every tool requires `workspace` (the absolute Hono project root). Start with hono_project. Routes are reported under their full composed path (route() and basePath() applied). Tools are read-only except hono_reindex (plugin state directory) and hono_graph_export (writes only the graph file in the workspace).",
    },
  );
  registerTools(server, new IndexManager());
  await server.connect(new StdioServerTransport());
  console.error(`hono-dev mcp ${VERSION} ready (stdio)`);
}
