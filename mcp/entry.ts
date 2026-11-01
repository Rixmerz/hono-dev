/**
 * The one entrypoint: `mcp --stdio` | `cli <command> ...` | `hook <detect|invalidate|validate>`.
 * The launcher (bin/hono-dev-run) runs the bundle of this file; `npm run dev:mcp` runs it from source.
 */
const USAGE =
  "usage: hono-dev-run mcp | cli <command> <workspace> [flags] | hook <detect|invalidate|validate>";

async function main(argv: string[]): Promise<void> {
  const [mode, ...rest] = argv;
  // each mode is imported on demand: a hook never loads the MCP SDK
  switch (mode) {
    case "mcp":
      return (await import("./main.ts")).runMcp(rest);
    case "cli":
      process.exitCode = await (await import("./cli.ts")).runCli(rest);
      return;
    case "hook":
      return (await import("../hooks/run.ts")).runHook(rest);
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`hono-dev: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = process.argv[2] === "hook" ? 0 : 3;
});
