/**
 * Headless CLI over the same tool functions the MCP server exposes:
 * `hono-mcp <command> <workspace> [--json] [flags]`.
 *
 * Exit codes: 0 ok (validate: no error-severity finding) | 1 validate found errors |
 * 2 not a Hono project, or a missing or invalid workspace | 3 internal error, unknown command, bad usage.
 */
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { IndexManager } from "./core/index.ts";
import type { Finding, ValidationResult } from "./core/types.ts";
import { TOOLS, callTool, type Outcome } from "./tools/index.ts";
import { catalogue } from "./validators/index.ts";
import { VERSION } from "./version.ts";

type FlagKind = "string" | "number" | "boolean" | "list";
interface FlagSpec {
  arg: string;
  kind: FlagKind;
}

interface Command {
  tool: string;
  flags: Record<string, FlagSpec>;
  help: string;
  /** Arguments to send when the user passed none (the CLI wants the whole table, not a page). */
  defaults?: Record<string, unknown>;
}

const COMMANDS: Record<string, Command> = {
  project: { tool: "hono_project", flags: {}, help: "detect Hono, runtime, entry, counts" },
  routes: {
    tool: "hono_routes",
    help: "route table under full paths   [--prefix p] [--file f] [--app file#local] [--middleware] [--limit n] [--offset n]",
    flags: {
      prefix: { arg: "prefix", kind: "string" },
      file: { arg: "file", kind: "string" },
      app: { arg: "app", kind: "string" },
      middleware: { arg: "include_middleware", kind: "boolean" },
      limit: { arg: "limit", kind: "number" },
      offset: { arg: "offset", kind: "number" },
    },
    defaults: { limit: 1000 },
  },
  route: {
    tool: "hono_route",
    help: "one route                     --method M --path /full/path",
    flags: { method: { arg: "method", kind: "string" }, path: { arg: "path", kind: "string" } },
  },
  middleware: {
    tool: "hono_middleware",
    help: "middleware of a request        [--method M] [--path /url]",
    flags: { method: { arg: "method", kind: "string" }, path: { arg: "path", kind: "string" } },
  },
  validators: {
    tool: "hono_validators",
    help: "validators per route           [--prefix p] [--missing-only]",
    flags: {
      prefix: { arg: "prefix", kind: "string" },
      "missing-only": { arg: "missing_only", kind: "boolean" },
    },
  },
  rpc: { tool: "hono_rpc", flags: {}, help: "app types and hc clients" },
  trace: {
    tool: "hono_trace",
    help: "request chain                 --path /url [--method GET]",
    flags: { path: { arg: "path", kind: "string" }, method: { arg: "method", kind: "string" } },
  },
  deps: {
    tool: "hono_dependencies",
    help: "imports of a file              --file f [--importers] [--depth n]",
    flags: {
      file: { arg: "file", kind: "string" },
      importers: { arg: "direction", kind: "boolean" },
      depth: { arg: "depth", kind: "number" },
    },
  },
  impact: {
    tool: "hono_impact",
    help: "impact of a change              --file f ... | --base <ref> [--head <ref>] [--depth n]",
    flags: {
      file: { arg: "files", kind: "list" },
      base: { arg: "base", kind: "string" },
      head: { arg: "head", kind: "string" },
      depth: { arg: "depth", kind: "number" },
    },
  },
  validate: {
    tool: "hono_validate",
    help: "rule catalogue (CI gate)       [--category c ...] [--file f ...] [--fast]",
    flags: {
      category: { arg: "categories", kind: "list" },
      file: { arg: "files", kind: "list" },
      fast: { arg: "fast", kind: "boolean" },
    },
  },
  export: {
    tool: "hono_graph_export",
    help: "write the livespec graph.json  [--path p]",
    flags: { path: { arg: "path", kind: "string" } },
  },
  reindex: {
    tool: "hono_reindex",
    help: "rebuild the index              [--force]",
    flags: { force: { arg: "force", kind: "boolean" } },
  },
};

const USAGE = `hono-mcp ${VERSION} — Hono analysis CLI

usage: hono-mcp <command> <workspace> [--json] [flags]

commands
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(11)}${c.help}`)
  .join("\n")}
  rules      list the rule catalogue [--json]

exit codes: 0 ok | 1 validate found errors | 2 not Hono / bad workspace | 3 internal or usage`;

/** Turn the parsed flags of a command into tool arguments; `importers` is a flag, `direction` the argument. */
function toolArgs(cmd: Command, values: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...cmd.defaults };
  for (const [flag, spec] of Object.entries(cmd.flags)) {
    const v = values[flag];
    if (v === undefined) continue;
    if (spec.arg === "direction") args.direction = v === true ? "importers" : "imports";
    else if (spec.kind === "number") args[spec.arg] = Number(v);
    else args[spec.arg] = v;
  }
  return args;
}

function printHuman(name: string, outcome: Outcome): void {
  const p = outcome.payload;
  if (outcome.status !== "ok" && p.ok === false && name !== "project") {
    console.error(`error: ${p.error}${p.hint ? `\nhint: ${p.hint}` : ""}`);
    for (const e of (p.evidence as string[] | undefined) ?? []) console.error(`  - ${e}`);
    return;
  }
  switch (name) {
    case "routes": {
      const routes = p.routes as {
        method: string;
        fullPath: string;
        file: string;
        line: number;
        reachable: boolean;
      }[];
      for (const r of routes) {
        console.log(
          `${r.method.padEnd(7)} ${r.fullPath}  ${r.file}:${r.line}${r.reachable ? "" : "  [unreachable]"}`,
        );
      }
      console.log(
        `${p.total} routes${p.truncated ? ` (showing ${routes.length}, next --offset ${p.next_offset})` : ""}`,
      );
      return;
    }
    case "validate": {
      const r = p as unknown as ValidationResult;
      for (const f of r.findings as Finding[]) {
        console.log(
          `${f.severity.padEnd(7)} ${f.id}  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}${f.hint ? `\n          hint: ${f.hint}` : ""}`,
        );
      }
      for (const u of r.summary.unverified) console.log(`unverified: ${u}`);
      console.log(
        `${r.ok ? "ok" : "not ok"} — ${r.summary.errors} errors, ${r.summary.warnings} warnings, ${r.summary.info} info`,
      );
      return;
    }
    case "project": {
      const v = p.honoVersion as { resolved: string | null; declared: string | null };
      console.log(
        `${p.isHono ? "Hono" : "not Hono"} ${v.resolved ?? v.declared ?? ""} (${p.runtime})`.trim(),
      );
      const c = p.counts as Record<string, number>;
      console.log(
        `apps ${c.apps}  routes ${c.routes}  middlewares ${c.middlewares}  mounts ${c.mounts}`,
      );
      for (const e of p.evidence as string[]) console.log(`  - ${e}`);
      return;
    }
    default:
      console.log(JSON.stringify(p, null, 2));
  }
}

const EXIT: Record<Outcome["status"], number> = {
  ok: 0,
  "not-hono": 2,
  "bad-workspace": 2,
  failed: 3,
};

export async function runCli(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (name === "rules") {
    const rules = catalogue();
    if (rest.includes("--json")) console.log(JSON.stringify(rules, null, 1));
    else
      for (const r of rules)
        console.log(`${r.id}  ${r.severity.padEnd(7)} ${r.category.padEnd(12)} ${r.title}`);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error(`unknown command: ${name}\n\n${USAGE}`);
    return 3;
  }
  const tool = TOOLS.find((t) => t.name === cmd.tool);
  if (!tool) throw new Error(`command ${name} maps to the missing tool ${cmd.tool}`);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        ...Object.fromEntries(
          Object.entries(cmd.flags).map(([flag, s]) => [
            flag,
            { type: s.kind === "boolean" ? "boolean" : "string", multiple: s.kind === "list" },
          ]),
        ),
      },
    });
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 3;
  }
  const json = parsed.values.json === true;
  const wsArg = parsed.positionals[0];
  if (!wsArg) {
    const error = `${name} needs a workspace: hono-mcp ${name} <workspace>`;
    if (json) console.log(JSON.stringify({ ok: false, error, hint: "pass the project root" }));
    else console.error(`error: ${error}`);
    return 2;
  }
  const workspace = isAbsolute(wsArg) ? wsArg : resolve(wsArg);
  const outcome = await callTool(
    new IndexManager(),
    tool,
    { workspace, ...toolArgs(cmd, parsed.values) },
    "cli",
  );
  if (json) console.log(JSON.stringify(outcome.payload, null, 1));
  else printHuman(name, outcome);
  if (outcome.status === "ok" && name === "validate" && outcome.payload.ok === false) return 1;
  return EXIT[outcome.status];
}
