/** `traceRequest`: which entries a request runs, in table order, and where the chain ends. */
import type { RootTable } from "./compose.ts";
import type { ProjectIndex } from "./index.ts";
import type { MiddlewareEntry, RouteEntry, TraceResult } from "./types.ts";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "QUERY"];

function isRoute(e: RouteEntry | MiddlewareEntry): e is RouteEntry {
  return "chain" in e;
}

/** The table to trace in: the served entry app first, then live roots, then orphans. */
function pickTable(idx: ProjectIndex, method: string, pathname: string): RootTable | null {
  const tables = [...idx.composition.tables.values()];
  if (tables.length === 0) return null;
  const entryApp = idx.detection.entry?.app ?? null;
  const entryRoot = entryApp ? idx.apps.find((a) => a.id === entryApp) : undefined;
  let ownerRoot = entryApp;
  while (entryRoot && ownerRoot) {
    const node = idx.apps.find((a) => a.id === ownerRoot);
    if (!node?.derivedFrom) break;
    ownerRoot = node.derivedFrom;
  }
  const ordered = [
    ...tables.filter((t) => t.root === ownerRoot),
    ...tables.filter((t) => t.root !== ownerRoot && t.live),
    ...tables.filter((t) => t.root !== ownerRoot && !t.live),
  ];
  const withHandler = ordered.find((t) =>
    t.matcher.match(method, pathname).some((h) => isRoute(t.entries[h.index])),
  );
  return withHandler ?? ordered[0];
}

export function traceRequest(idx: ProjectIndex, methodIn: string, rawPath: string): TraceResult {
  const method = methodIn.toUpperCase();
  const pathname = new URL(rawPath, "http://hono.local").pathname || "/";
  const table = pickTable(idx, method, pathname);
  const empty: TraceResult = {
    method,
    path: pathname,
    root: null,
    steps: [],
    handler: null,
    params: {},
    errorHandler: null,
    notFound: true,
    allowedMethods: [],
  };
  if (!table) return empty;

  const steps: TraceResult["steps"] = [];
  let ended = false;
  let handler: RouteEntry | null = null;
  let params: Record<string, string> = {};
  for (const hit of table.matcher.match(method, pathname)) {
    const e = table.entries[hit.index];
    const route = isRoute(e);
    steps.push({
      kind: route ? "handler" : "middleware",
      entryId: e.id,
      name: route ? (e.handler?.resolved?.split("#")[1] ?? null) : e.name,
      file: e.file,
      line: e.line,
      params: hit.params,
      reached: !ended,
    });
    if (ended) continue;
    if (route) {
      handler = e;
      params = hit.params;
      ended = true; // the first handler to match responds (hono compose, contract 7e)
    } else if (e.fn && !e.fn.callsNext) {
      ended = true; // a middleware that never calls next() ends the chain itself
    }
  }

  const allowed = new Set<string>();
  for (const m of METHODS) {
    if (table.matcher.match(m, pathname).some((h) => isRoute(table.entries[h.index])))
      allowed.add(m);
  }
  if (allowed.has("GET")) allowed.add("HEAD");

  const rootApp = idx.apps.find((a) => a.id === table.root);
  return {
    method,
    path: pathname,
    root: table.live ? table.root : null,
    steps,
    handler,
    params,
    errorHandler: handler?.errorHandler ?? rootApp?.errorHandler ?? null,
    notFound: handler === null,
    allowedMethods: [...allowed].sort(),
  };
}
