/**
 * The twelve tools as plain functions over the index. The MCP server and the headless CLI both
 * call these, so the two surfaces cannot drift: one answers what the other prints.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { exportGraph } from "../core/export.ts";
import { exists } from "../core/fs.ts";
import type { ProjectIndex } from "../core/index.ts";
import { computeImpact, gitChangedFiles } from "../core/impact.ts";
import { traceRequest } from "../core/trace.ts";
import type { MiddlewareEntry, RouteEntry } from "../core/types.ts";
import { CATEGORIES, validate } from "../validators/index.ts";
import { VERSION } from "../version.ts";

/** A domain failure the caller can act on (bad argument, nothing found); not a crash. */
export class ToolFailure extends Error {
  readonly hint: string | null;
  readonly extra: Record<string, unknown>;

  constructor(message: string, hint: string | null = null, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolFailure";
    this.hint = hint;
    this.extra = extra;
  }
}

export type Caller = "mcp" | "cli";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Arguments besides `workspace`. */
  shape: z.ZodRawShape;
  /** False only for hono_project, which also answers on a workspace that is not Hono. */
  requiresHono: boolean;
  /** Only hono_reindex: rebuild every file instead of the changed ones. */
  forceReload?: (args: never) => boolean;
  /** What the tool may write: nothing, the plugin's state directory, or the graph file. */
  writes: "nothing" | "state" | "graph";
  run(idx: ProjectIndex, args: never, caller: Caller): Promise<unknown> | unknown;
}

function defineTool<S extends z.ZodRawShape>(
  def: Omit<ToolDef, "shape" | "run" | "forceReload"> & {
    shape: S;
    forceReload?: (args: z.infer<z.ZodObject<S>>) => boolean;
    run(
      idx: ProjectIndex,
      args: z.infer<z.ZodObject<S>>,
      caller: Caller,
    ): Promise<unknown> | unknown;
  },
): ToolDef {
  return def as unknown as ToolDef;
}

function page<T>(items: T[], limit: number, offset: number) {
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    total: items.length,
    offset,
    limit,
    truncated: end < items.length,
    next_offset: end < items.length ? end : null,
  };
}

/** Workspace-relative POSIX path; an absolute path inside the workspace is accepted. */
function relPath(idx: ProjectIndex, file: string): string {
  const rel = isAbsolute(file) ? relative(idx.workspace, file) : file;
  return rel.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

const handlerName = (r: RouteEntry) => r.handler?.resolved?.split("#")[1] ?? null;

function routeSummary(r: RouteEntry) {
  return {
    id: r.id,
    method: r.method,
    fullPath: r.fullPath,
    localPath: r.localPath,
    kind: r.kind,
    file: r.file,
    line: r.line,
    app: r.app,
    root: r.root,
    reachable: r.reachable,
    confidence: r.confidence,
    params: r.params,
    validators: r.validators.map((v) => v.target),
    handler: r.handler
      ? { file: r.handler.file, line: r.handler.line, name: handlerName(r) }
      : null,
    ...(r.notes.length ? { notes: r.notes } : {}),
  };
}

function middlewareSummary(m: MiddlewareEntry) {
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    source: m.source,
    isAuth: m.isAuth,
    method: m.method,
    fullPath: m.fullPath,
    file: m.file,
    line: m.line,
    seq: m.seq,
    root: m.root,
    reachable: m.reachable,
    registeredAfterRoutes: m.registeredAfterRoutes,
    callsNext: m.fn ? m.fn.callsNext : null,
  };
}

/** The graph file must land inside the workspace, even through a symlinked directory. */
async function assertInsideWorkspace(workspace: string, target: string): Promise<void> {
  const abs = resolve(workspace, target);
  let probe = abs;
  while (!(await exists(probe))) probe = dirname(probe);
  const outside = (p: string) => {
    const rel = relative(workspace, p);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  if (outside(abs) || outside(await realpath(probe))) {
    throw new ToolFailure(
      `path escapes the workspace: ${target}`,
      "pass a path inside the workspace; the default is .hono-dev/graph.json",
    );
  }
}

const pathPattern = z
  .string()
  .describe("Full composed path, e.g. /v1/contacts/:id (a request path for trace and middleware)");

export const TOOLS: ToolDef[] = [
  defineTool({
    name: "hono_project",
    title: "Detect and summarise a Hono project",
    description:
      "Is `workspace` a Hono project? Hono version (declared and resolved), runtime, deploy targets, entry file, the Hono apps, workspace members, counts and the index status. Call this first. The only tool that also answers on a workspace that is not Hono (ok: false plus the detection evidence).",
    shape: {},
    requiresHono: false,
    writes: "nothing",
    run(idx) {
      const d = idx.detection;
      const routes = idx.routes.filter((r) => r.kind === "route");
      return {
        ok: d.isHono,
        ...(d.isHono
          ? {}
          : {
              error: `${idx.workspace} is not a Hono project`,
              hint: "pass the directory that holds the package.json or deno.json declaring hono",
            }),
        workspace: idx.workspace,
        isHono: d.isHono,
        honoVersion: d.honoVersion,
        honoSpecifiers: d.honoSpecifiers,
        runtime: d.runtime,
        runtimes: d.runtimes,
        deployTargets: d.deployTargets,
        entry: d.entry,
        configFiles: d.configFiles,
        workspaceMembers: d.workspaceMembers,
        confidence: d.confidence,
        evidence: d.evidence,
        apps: idx.apps.map((a) => ({
          id: a.id,
          file: a.file,
          line: a.line,
          ctor: a.ctor,
          basePath: a.basePath,
          isRoot: a.isRoot,
          exportedAs: a.exportedAs,
        })),
        counts: {
          files: idx.files.size,
          apps: idx.apps.length,
          routes: routes.length,
          unreachableRoutes: routes.filter((r) => !r.reachable).length,
          mounts: idx.mounts.length,
          middlewares: idx.middlewares.length,
          routesWithoutValidator: routes.filter((r) => r.validators.length === 0).length,
          rpcAppTypes: idx.rpc.appTypes.length,
          hcClients: idx.rpc.clients.length,
          unresolvedImports: idx.graph.unresolved.length,
        },
        index: idx.stats,
        skipped: idx.skipped,
        pluginVersion: VERSION,
      };
    },
  }),

  defineTool({
    name: "hono_routes",
    title: "List routes under their full composed path",
    description:
      "The route table with every route under the path a client requests (`route()` and `basePath()` mounts applied), not the local path its handler was registered with. Filter by `prefix` (full path), `file` (registered or handled there) or `app` (`file#local`). `include_middleware` adds the middleware chain and the steps that never run (`unreached`).",
    shape: {
      prefix: z.string().optional().describe("Only routes whose full path starts with this"),
      file: z.string().optional().describe("Workspace-relative file that registers or handles"),
      app: z.string().optional().describe("App id as `file#local`, e.g. src/app.ts#app"),
      include_middleware: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(1000).optional().default(100),
      offset: z.number().int().min(0).optional().default(0),
    },
    requiresHono: true,
    writes: "nothing",
    run(idx, { prefix, file, app, include_middleware, limit, offset }) {
      let routes = idx.routes;
      if (prefix) routes = routes.filter((r) => r.fullPath.startsWith(prefix));
      if (file) {
        const wanted = relPath(idx, file);
        routes = routes.filter((r) => r.file === wanted || r.handler?.file === wanted);
      }
      if (app) routes = routes.filter((r) => r.app === app);
      const p = page(routes, limit ?? 100, offset ?? 0);
      return {
        ok: true,
        routes: p.items.map((r) =>
          include_middleware
            ? { ...routeSummary(r), chain: r.chain, unreached: r.unreached }
            : routeSummary(r),
        ),
        total: p.total,
        offset: p.offset,
        limit: p.limit,
        truncated: p.truncated,
        next_offset: p.next_offset,
      };
    },
  }),

  defineTool({
    name: "hono_route",
    title: "Inspect one route",
    description:
      "One route by method and full path: where it is registered, the mount chain it was composed through, the chain of middleware and validators that wrap it, the steps that never run (`unreached`), inline middleware, the handler facts and the tests that import the file.",
    shape: { method: z.string().describe("HTTP method, e.g. GET"), path: pathPattern },
    requiresHono: true,
    writes: "nothing",
    run(idx, { method, path }) {
      const route = idx.findRoute(method, path);
      if (!route) {
        const samePath = idx.routes.filter((r) => r.fullPath === path);
        throw new ToolFailure(
          `no route ${method.toUpperCase()} ${path}`,
          "list the table with hono_routes, or use hono_trace for a concrete URL such as /v1/contacts/42",
          {
            registeredMethods: samePath.map((r) => r.method),
            didYouMean: idx.routes
              .filter((r) => r.fullPath.startsWith(path.replace(/\/[^/]*$/, "") || "/"))
              .slice(0, 5)
              .map((r) => `${r.method} ${r.fullPath}`),
          },
        );
      }
      const others = idx.routes.filter(
        (r) => r !== route && r.method === route.method && r.fullPath === route.fullPath,
      );
      const tests = [...idx.importersOf(route.file, 6).keys()].filter(
        (f) => idx.facts.get(f)?.isTest,
      );
      return {
        ok: true,
        ...route,
        alsoRegistered: others.map((r) => ({ file: r.file, line: r.line, reachable: r.reachable })),
        tests,
      };
    },
  }),

  defineTool({
    name: "hono_middleware",
    title: "Middleware that applies to a request",
    description:
      "With `path`: the middleware that runs for that method and request path, in execution order, each with `reached` (false when an earlier step ended the request). Without `path`: every middleware registration of the project.",
    shape: {
      method: z.string().optional().default("GET"),
      path: z.string().optional().describe("Request path, e.g. /v1/contacts/42"),
    },
    requiresHono: true,
    writes: "nothing",
    run(idx, { method, path }) {
      if (!path) {
        return {
          ok: true,
          middleware: idx.middlewares.map(middlewareSummary),
          total: idx.middlewares.length,
        };
      }
      const t = traceRequest(idx, method ?? "GET", path);
      const byId = new Map(idx.middlewares.map((m) => [m.id, m]));
      const steps = t.steps.filter((s) => s.kind === "middleware");
      return {
        ok: true,
        method: t.method,
        path: t.path,
        middleware: steps.map((s) => {
          const m = byId.get(s.entryId);
          return m
            ? { ...middlewareSummary(m), reached: s.reached }
            : { id: s.entryId, name: s.name, file: s.file, line: s.line, reached: s.reached };
        }),
        total: steps.length,
      };
    },
  }),

  defineTool({
    name: "hono_validators",
    title: "Validators per route and target",
    description:
      "The validators of each route (target json, form, query, param, header or cookie; library; schema; whether it comes from the route or a mount). `missing_only` lists the routes that have none, with whether their handler reads a request body.",
    shape: {
      prefix: z.string().optional().describe("Only routes whose full path starts with this"),
      missing_only: z.boolean().optional().default(false),
    },
    requiresHono: true,
    writes: "nothing",
    run(idx, { prefix, missing_only }) {
      let routes = idx.routes.filter((r) => r.kind === "route");
      if (prefix) routes = routes.filter((r) => r.fullPath.startsWith(prefix));
      if (missing_only) routes = routes.filter((r) => r.validators.length === 0);
      return {
        ok: true,
        routes: routes.map((r) => ({
          method: r.method,
          fullPath: r.fullPath,
          file: r.file,
          line: r.line,
          reachable: r.reachable,
          validators: r.validators,
          readsBody: (r.handler?.bodyReads.length ?? 0) > 0,
        })),
        total: routes.length,
      };
    },
  }),

  defineTool({
    name: "hono_rpc",
    title: "RPC app types and hc clients",
    description:
      "The exported app types (`typeof app`) and the `hc` client uses. For each app type: whether it is built as one chain, and whether it carries every route of its app. A route registered in a separate statement is missing from the type, so the client cannot call it.",
    shape: {},
    requiresHono: true,
    writes: "nothing",
    run(idx) {
      return {
        ok: true,
        appTypes: idx.rpc.appTypes.map((t) => {
          const appRoutes = idx.routes.filter(
            (r) =>
              r.kind === "route" &&
              t.target !== null &&
              (r.app === t.target || r.mountChain.some((h) => h.app === t.target)),
          );
          // P001: a type from a non-chained instance carries none of the routes registered apart
          const carriesEveryRoute = t.target === null ? null : t.chained || appRoutes.length === 0;
          return { ...t, appRoutes: appRoutes.length, carriesEveryRoute };
        }),
        clients: idx.rpc.clients,
      };
    },
  }),

  defineTool({
    name: "hono_trace",
    title: "Trace a request",
    description:
      "What a request goes through, in table order: each middleware and the handler with `reached` (false after a step that ends the request), the path params, the error handler, and the methods that path does serve. When nothing answers, `reason` says why (no route, wrong method, or a middleware that ends the request).",
    shape: {
      path: z.string().describe("Request path, e.g. /v1/contacts/42?x=1"),
      method: z.string().optional().default("GET"),
    },
    requiresHono: true,
    writes: "nothing",
    run(idx, { path, method }) {
      const t = traceRequest(idx, method ?? "GET", path);
      let reason: string | null = null;
      if (t.notFound) {
        const stopped = t.steps.find((s) => s.kind === "handler" && !s.reached);
        const ender = [...t.steps].reverse().find((s) => s.reached && s.kind === "middleware");
        if (stopped && ender) {
          reason = `${ender.name ?? "a middleware"} (${ender.file}:${ender.line}) does not call next(), so the handler at ${stopped.file}:${stopped.line} is never reached`;
        } else if (t.allowedMethods.length > 0) {
          reason = `no ${t.method} handler for ${t.path}; it is served for ${t.allowedMethods.join(", ")} (Hono answers 404, not 405)`;
        } else {
          reason = `no route matches ${t.path}`;
        }
      }
      return {
        ok: true,
        method: t.method,
        path: t.path,
        root: t.root,
        steps: t.steps,
        handler: t.handler ? routeSummary(t.handler) : null,
        params: t.params,
        errorHandler: t.errorHandler,
        notFound: t.notFound,
        reason,
        allowedMethods: t.allowedMethods,
      };
    },
  }),

  defineTool({
    name: "hono_dependencies",
    title: "Import graph around a file",
    description:
      "The files a file imports, or the files that import it, up to `depth` hops, with tsconfig paths and the Deno import map applied. Also the external packages and the specifiers that did not resolve.",
    shape: {
      file: z.string().describe("Workspace-relative file"),
      direction: z.enum(["imports", "importers"]).optional().default("imports"),
      depth: z.number().int().min(1).max(10).optional().default(1),
    },
    requiresHono: true,
    writes: "nothing",
    run(idx, { file, direction, depth }) {
      const start = relPath(idx, file);
      if (!idx.files.has(start)) {
        throw new ToolFailure(
          `file not indexed: ${start}`,
          "paths are workspace-relative; only .ts, .tsx, .js, .jsx, .mts, .cts, .mjs and .cjs files are indexed",
        );
      }
      const dir = direction ?? "imports";
      const files: { file: string; distance: number; via: string; typeOnly?: boolean }[] = [];
      const seen = new Set([start]);
      let frontier = [start];
      for (let d = 1; d <= (depth ?? 1) && frontier.length; d++) {
        const next: string[] = [];
        for (const f of frontier) {
          const edges =
            dir === "imports"
              ? (idx.graph.importsOf.get(f) ?? []).map((e) => ({
                  target: e.target,
                  typeOnly: e.typeOnly,
                }))
              : (idx.graph.importedBy.get(f) ?? []).map((target) => ({ target, typeOnly: false }));
          for (const e of edges) {
            if (seen.has(e.target)) continue;
            seen.add(e.target);
            files.push({
              file: e.target,
              distance: d,
              via: f,
              ...(e.typeOnly ? { typeOnly: true } : {}),
            });
            next.push(e.target);
          }
        }
        frontier = next;
      }
      return {
        ok: true,
        file: start,
        direction: dir,
        files,
        external: [...seen].flatMap((f) =>
          (idx.graph.externalsOf.get(f) ?? []).map((e) => ({ from: f, ...e })),
        ),
        unresolved: idx.graph.unresolved.filter((u) => seen.has(u.file)),
      };
    },
  }),

  defineTool({
    name: "hono_impact",
    title: "Impact of a change",
    description:
      "Given changed files (`files`) or a git range (`base`, optionally `head`): the routes, apps, middleware and RPC types affected and why, the tests that import the changed code, and the checks to run next.",
    shape: {
      files: z.array(z.string()).optional().describe("Workspace-relative changed files"),
      base: z.string().optional().describe("Git ref: changed files are `git diff base[...head]`"),
      head: z.string().optional(),
      depth: z.number().int().min(1).max(10).optional().default(3),
    },
    requiresHono: true,
    writes: "nothing",
    async run(idx, { files, base, head, depth }) {
      if (head && !base) throw new ToolFailure("`head` needs `base`", "pass both refs");
      const changed = [
        ...(files ?? []).map((f) => relPath(idx, f)),
        ...(base ? await gitChangedFiles(idx.workspace, base, head) : []),
      ];
      if (changed.length === 0) {
        throw new ToolFailure(
          "no changed files",
          "pass `files`, or a `base` ref that differs from the tree",
        );
      }
      return { ok: true, ...computeImpact(idx, changed, depth ?? 3) };
    },
  }),

  defineTool({
    name: "hono_validate",
    title: "Validate the project against the rule catalogue",
    description:
      "Runs the 36-rule catalogue (routes, middleware, validation, security, architecture, rpc, conventions). `ok` is false when any finding has severity error. `summary.unverified` lists what could not be checked, so a silent skip is never read as a pass. `fast` skips the slow rules A004 and C004.",
    shape: {
      categories: z.array(z.enum(CATEGORIES as [string, ...string[]])).optional(),
      files: z.array(z.string()).optional().describe("Only findings located in these files"),
      fast: z.boolean().optional().default(false),
    },
    requiresHono: true,
    writes: "nothing",
    run(idx, { categories, files, fast }) {
      return validate(idx, {
        categories: categories as (typeof CATEGORIES)[number][] | undefined,
        files: files?.map((f) => relPath(idx, f)),
        fast: fast ?? false,
      });
    },
  }),

  defineTool({
    name: "hono_graph_export",
    title: "Export the graph for livespec",
    description:
      "Writes a Graphify node-link graph.json (default `.hono-dev/graph.json`) for livespec's external-graph ingest: apps, routes under their composed path, middleware, validators and imports. Returns the counts and the .livespec.toml snippet. The only tool that writes inside the project, and only this file.",
    shape: {
      path: z
        .string()
        .optional()
        .describe("Output path inside the workspace (default .hono-dev/graph.json)"),
    },
    requiresHono: true,
    writes: "graph",
    async run(idx, { path }, caller) {
      // the CLI user typed the path themselves; a model-supplied one must stay inside the project
      if (path && caller === "mcp") await assertInsideWorkspace(idx.workspace, path);
      return exportGraph(idx, { path });
    },
  }),

  defineTool({
    name: "hono_reindex",
    title: "Rebuild the index",
    description:
      "Re-scan the workspace. Only files whose size or mtime changed (or that the hooks marked dirty) are re-parsed; `force` re-parses everything. Every tool refreshes lazily, so this is for the hooks and for a forced rebuild. Writes the plugin's state directory only.",
    shape: { force: z.boolean().optional().default(false) },
    requiresHono: true,
    forceReload: ({ force }) => force === true,
    writes: "state",
    run(idx) {
      return {
        ok: true,
        ...idx.stats,
        skipped: idx.skipped.slice(0, 50),
        skippedTotal: idx.skipped.length,
      };
    },
  }),
];
