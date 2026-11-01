/** Rule contract shared by every validator file, plus the lookups several rules need. */
import type { RootTable } from "../core/compose.ts";
import type { ProjectIndex } from "../core/index.ts";
import type {
  AppId,
  Category,
  Confidence,
  Finding,
  MiddlewareEntry,
  ModuleFacts,
  MountHop,
  OpFact,
  RouteEntry,
  Severity,
} from "../core/types.ts";

export interface RuleContext {
  index: ProjectIndex;
  /** When set, only findings on these files are reported (hook fast path). */
  files: Set<string> | null;
}

export interface Rule {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  /** Reads extra files or walks the whole import graph; skipped by the `fast` option. */
  slow?: boolean;
  run(ctx: RuleContext): Promise<Finding[]> | Finding[];
}

export function finding(
  rule: Rule,
  file: string,
  message: string,
  opts: {
    line?: number | null;
    hint?: string | null;
    confidence?: Confidence;
    severity?: Severity;
    route?: string;
  } = {},
): Finding {
  const out: Finding = {
    id: rule.id,
    severity: opts.severity ?? rule.severity,
    category: rule.category,
    file,
    line: opts.line ?? null,
    message,
    hint: opts.hint ?? null,
    confidence: opts.confidence ?? "extracted",
    source: "hono-dev",
  };
  if (opts.route !== undefined) out.route = opts.route;
  return out;
}

export function inScope(ctx: RuleContext, file: string): boolean {
  return ctx.files === null || ctx.files.has(file);
}

// ---------------------------------------------------------------------------
// lookups over the index, shared by the category files
// ---------------------------------------------------------------------------

export type TableEntry = RouteEntry | MiddlewareEntry;
export type HostOp = Exclude<OpFact, { op: "decl" }>;

export function isRoute(e: TableEntry): e is RouteEntry {
  return "chain" in e;
}

export function routeLabel(r: { method: string; fullPath: string }): string {
  return `${r.method} ${r.fullPath}`;
}

export function where(file: string, line: number): string {
  return `${file}:${line}`;
}

/** The instance's local name: `src/app.ts#api` → `api`. */
export function localName(id: AppId): string {
  return id.slice(id.indexOf("#") + 1);
}

export function tablesOf(index: ProjectIndex): RootTable[] {
  return [...index.composition.tables.values()];
}

/** Plain route entries of one table in registration order, with their position in the table. */
export function tableRoutes(entries: RootTable["entries"]): { at: number; route: RouteEntry }[] {
  const out: { at: number; route: RouteEntry }[] = [];
  entries.forEach((e, at) => {
    if (isRoute(e) && e.kind === "route") out.push({ at, route: e });
  });
  return out;
}

/** Routes that are served (or have no serve evidence at all) and are plain `route` entries. */
export function liveRoutes(index: ProjectIndex): RouteEntry[] {
  return index.routes.filter((r) => r.kind === "route" && r.reachable);
}

/** A literal path registered inside an `if`, loop or `try` is only "inferred" by the composer. */
export function isConditional(e: TableEntry): boolean {
  return e.confidence === "inferred" && !e.pathNonLiteral;
}

/** Every registration-like op of non-test code that acts on a known Hono instance. */
export function* hostOps(
  index: ProjectIndex,
): Generator<{ mod: ModuleFacts; op: HostOp; app: AppId }> {
  for (const mod of index.facts.values()) {
    if (mod.isTest) continue;
    for (const op of mod.ops) {
      if (op.op === "decl") continue;
      const app = index.composition.resolveApp(mod.path, op.target);
      if (app) yield { mod, op, app };
    }
  }
}

interface Lookups {
  entryById: Map<string, TableEntry>;
  routeHops: Set<string>;
  argTexts: Map<string, string>;
}

const cache = new WeakMap<ProjectIndex, Lookups>();

function lookups(index: ProjectIndex): Lookups {
  const hit = cache.get(index);
  if (hit) return hit;
  const entryById = new Map<string, TableEntry>();
  for (const e of [...index.routes, ...index.middlewares]) entryById.set(e.id, e);
  const routeHops = new Set<string>();
  for (const m of index.mounts) {
    if (m.kind === "route") routeHops.add(`${m.child}|${m.file}|${m.line}`);
  }
  const argTexts = new Map<string, string>();
  for (const mod of index.facts.values()) {
    for (const op of mod.ops) {
      if (op.op !== "reg") continue;
      for (const a of op.args) {
        if (a.name === null) continue;
        argTexts.set(`${mod.path}:${op.line}:${a.name}`, a.text);
        argTexts.set(`${mod.path}:${a.line}:${a.name}`, a.text);
      }
    }
  }
  const made = { entryById, routeHops, argTexts };
  cache.set(index, made);
  return made;
}

export function entryById(index: ProjectIndex, id: string): TableEntry | undefined {
  return lookups(index).entryById.get(id);
}

/** A hop made by `route()`; the other hops come from `basePath()`, which shares the table. */
export function isRouteHop(index: ProjectIndex, hop: MountHop): boolean {
  return lookups(index).routeHops.has(`${hop.app}|${hop.file}|${hop.line}`);
}

/** Source text of the argument a registration was made with, to tell `auth("a")` from `auth("b")`. */
export function argText(index: ProjectIndex, file: string, line: number, name: string): string {
  return lookups(index).argTexts.get(`${file}:${line}:${name}`) ?? name;
}

/** Does the registration of this route pass a spread argument (validators may hide in it)? */
export function hasSpreadArgs(index: ProjectIndex, route: RouteEntry): boolean {
  const mod = index.facts.get(route.file);
  if (!mod) return false;
  return mod.ops.some(
    (op) =>
      op.op === "reg" &&
      op.line === route.line &&
      op.paths.some((p) => p.value === route.localPath) &&
      op.args.some((a) => a.spread),
  );
}

/** Canonical specifier a local name was imported from (`jwt` → `hono/jwt`), or null. */
export function importedFrom(mod: ModuleFacts, local: string | null): string | null {
  if (!local) return null;
  for (const imp of mod.imports) {
    if (imp.reexport || imp.dynamic) continue;
    if (
      imp.default === local ||
      imp.namespace === local ||
      imp.names.some((n) => n.local === local)
    )
      return imp.canonical ?? imp.resolved;
  }
  return null;
}
