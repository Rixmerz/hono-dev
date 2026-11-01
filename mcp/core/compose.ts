/**
 * The Hono app simulator. Every instance owns an ordered table, exactly like `app.routes` in
 * hono-base.js (docs/adr/0002): registrations append, `route()` copies the child's entries as they
 * are at call time, `basePath()` shares the table. Modules are evaluated in ESM order, so a
 * sub-app mounted before it is filled serves nothing, and `/v1/integrations/google-calendar`
 * mounted before `/v1/integrations` never reaches the latter's auth middleware.
 */
import { mergePath } from "hono/utils/url";
import { matchesSpecifier } from "./graph.ts";
import { DEFAULT_DB_SPECIFIERS } from "./graph.ts";
import { samplePaths, TableMatcher } from "./match.ts";
import type {
  AppId,
  AppNode,
  ArgFact,
  ChainStep,
  Confidence,
  EnvRead,
  HandlerFacts,
  HandlerRef,
  HonoDevConfig,
  ImportFact,
  LiteralValue,
  MiddlewareEntry,
  MiddlewareFnFacts,
  MiddlewareRef,
  ModuleFacts,
  MountEdge,
  MountHop,
  OpenApiMeta,
  RawFn,
  RegVia,
  RouteEntry,
  ValidatorRef,
} from "./types.ts";

// ---------------------------------------------------------------------------
// simulation state
// ---------------------------------------------------------------------------

interface Origin {
  app: AppId;
  via: RegVia;
  method: string;
  localPath: string;
  pathNonLiteral: boolean;
  file: string;
  line: number;
  args: ArgFact[];
  openapi: OpenApiMeta | null;
  conditional: boolean;
  /** Derived-instance hops from the table owner to the defining instance. */
  hops: MountHop[];
}

interface SimEntry {
  origin: Origin;
  path: string;
  chain: MountHop[];
  /** Error handlers of the sub-apps this entry was copied out of, innermost first. */
  wraps: HandlerRef[];
}

interface MountRecord {
  parentOwner: SimApp;
  parentBase: string;
  prefix: string;
  atLen: number;
}

interface SimApp {
  id: AppId;
  file: string;
  local: string;
  line: number;
  ctor: AppNode["ctor"];
  strict: boolean;
  basePath: string;
  derivedFrom: SimApp | null;
  owner: SimApp;
  table: SimEntry[];
  hops: MountHop[];
  errorHandler: HandlerRef | null;
  notFoundHandler: HandlerRef | null;
  mountRecords: MountRecord[];
  fetchMounted: boolean;
  conditional: boolean;
  /** Route-registering calls in the initializer chain of the declaration (hc type inference). */
  chainedOps: number;
}

export interface RootTable {
  root: AppId;
  /** Served (or no serve evidence anywhere): its registrations are reachable. */
  live: boolean;
  entries: (RouteEntry | MiddlewareEntry)[];
  matcher: TableMatcher;
}

export interface Composition {
  apps: AppNode[];
  mounts: MountEdge[];
  roots: AppId[];
  routes: RouteEntry[];
  middlewares: MiddlewareEntry[];
  tables: Map<AppId, RootTable>;
  /** Registrations that exist on a mounted sub-app but were added after it was mounted. */
  stranded: (RouteEntry | MiddlewareEntry)[];
  /** Apps found to be served: serve calls and default exports. */
  served: Set<AppId>;
  warnings: { file: string; reason: string }[];
  /** The instance a name denotes in a file (aliases, imports and barrels followed). */
  resolveApp(file: string, ref: string): AppId | null;
  /** Like resolveApp, plus how many routes the initializer chain of that name carries. */
  rpcTarget(file: string, ref: string): { id: AppId; chainedOps: number } | null;
  /** The function a name denotes in a file (locals, imports and barrels followed). */
  resolveFn(file: string, ref: string): RawFn | null;
}

export interface ComposeInput {
  facts: Map<string, ModuleFacts>;
  config: HonoDevConfig;
  dbModules: Set<string>;
  /** Files to evaluate first (the entry), in priority order. */
  entryFiles: string[];
}

// ---------------------------------------------------------------------------
// helpers shared with detection
// ---------------------------------------------------------------------------

const AUTH_BUILTINS = new Set(["hono/jwt", "hono/bearer-auth", "hono/basic-auth", "hono/jwk"]);
const AUTH_NAME =
  /(auth(?!or)|jwt|bearer|session|apikey|api_key|guard|protect|permission|rbac|verifytoken|clerk)/i;

export function isAuthName(
  name: string | null,
  source: string | null,
  config: HonoDevConfig,
): boolean {
  if (source && AUTH_BUILTINS.has(source)) return true;
  if (name && config.authMiddleware.some((a) => a === name || a === source)) return true;
  if (source && config.authMiddleware.includes(source)) return true;
  return name !== null && AUTH_NAME.test(name);
}

const VALIDATOR_LIBRARIES: Record<string, ValidatorRef["library"]> = {
  "@hono/zod-validator": "zod",
  "@hono/valibot-validator": "valibot",
  "@hono/standard-validator": "standard-schema",
  "@hono/typebox-validator": "typebox",
  "@hono/arktype-validator": "arktype",
  "hono/validator": "custom",
};
const VALIDATOR_BY_NAME: Record<string, ValidatorRef["library"]> = {
  zValidator: "zod",
  vValidator: "valibot",
  sValidator: "standard-schema",
  tbValidator: "typebox",
  typeboxValidator: "typebox",
  arktypeValidator: "arktype",
  validator: "custom",
};
const VALIDATOR_TARGETS = new Set(["json", "form", "query", "param", "header", "cookie"]);

function bindingOf(
  mod: ModuleFacts,
  name: string | null,
): { imp: ImportFact; imported: string } | null {
  if (!name) return null;
  for (const imp of mod.imports) {
    if (imp.reexport || imp.dynamic) continue;
    if (imp.default === name) return { imp, imported: "default" };
    if (imp.namespace === name) return { imp, imported: "*" };
    const n = imp.names.find((x) => x.local === name);
    if (n) return { imp, imported: n.imported };
  }
  return null;
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

export function composeProject(input: ComposeInput): Composition {
  return new Composer(input).run();
}

class Composer {
  private readonly facts: Map<string, ModuleFacts>;
  private readonly config: HonoDevConfig;
  private readonly dbModules: Set<string>;
  private readonly entryFiles: string[];
  private readonly apps = new Map<AppId, SimApp>();
  private readonly mounts: MountEdge[] = [];
  private readonly warnings: { file: string; reason: string }[] = [];
  private readonly order: AppId[] = [];
  private readonly evaluated = new Set<string>();

  constructor(input: ComposeInput) {
    this.facts = input.facts;
    this.config = input.config;
    this.dbModules = input.dbModules;
    this.entryFiles = input.entryFiles;
  }

  run(): Composition {
    this.evaluateAll();
    return this.emit();
  }

  // ---- evaluation ---------------------------------------------------------

  private evaluateAll(): void {
    const files = [...this.facts.keys()].filter((f) => !this.facts.get(f)?.isTest).sort();
    const starts = [...this.entryFiles.filter((f) => this.facts.has(f)), ...files];
    for (const f of starts) this.evaluate(f);
  }

  /** ESM evaluation: dependencies first, in import order, then the module's own top level. */
  private evaluate(file: string): void {
    const mod = this.facts.get(file);
    if (!mod || mod.isTest || this.evaluated.has(file)) return;
    this.evaluated.add(file);
    for (const imp of mod.imports) {
      if (imp.dynamic || imp.isTypeOnly || !imp.resolved) continue;
      this.evaluate(imp.resolved);
    }
    for (const op of mod.ops) this.apply(mod, op);
    if (mod.instanceDeclsInFunctions > 0 && !mod.ops.some((o) => o.op === "decl")) {
      this.warnings.push({
        file,
        reason:
          "Hono instance created inside a function body: not simulated (only module top level is)",
      });
    }
  }

  private apply(mod: ModuleFacts, op: ModuleFacts["ops"][number]): void {
    if (op.op === "decl") {
      this.declareInstance(mod, op.instance);
      return;
    }
    const target = this.resolveInstance(mod.path, op.target);
    if (!target) return; // `cache.get(...)`, `c.get(...)`: not a Hono instance
    if (op.op === "error" || op.op === "notfound") {
      const arg = op.handler;
      const ref: HandlerRef | null = arg
        ? { file: mod.path, line: arg.line, name: arg.name }
        : null;
      if (op.op === "error") target.errorHandler = ref;
      else target.notFoundHandler = ref;
    } else if (op.op === "route") this.applyRoute(mod, target, op);
    else this.applyRegistration(mod, target, op);
    return;
  }

  private declareInstance(mod: ModuleFacts, inst: import("./types.ts").InstanceFact): void {
    const id = `${mod.path}#${inst.local}`;
    let derivedFrom: SimApp | null = null;
    if (inst.derivedFrom) {
      derivedFrom = this.resolveInstance(mod.path, inst.derivedFrom);
      if (!derivedFrom) {
        this.warnings.push({
          file: mod.path,
          reason: `basePath() receiver '${inst.derivedFrom}' is not a known Hono instance (line ${inst.line})`,
        });
      }
    }
    const prefix = inst.basePath?.value ?? "/";
    let app: SimApp;
    if (derivedFrom) {
      app = {
        id,
        file: mod.path,
        local: inst.local,
        line: inst.line,
        ctor: "derived",
        strict: derivedFrom.strict,
        basePath: mergePath(derivedFrom.basePath, prefix),
        derivedFrom,
        owner: derivedFrom.owner,
        table: derivedFrom.owner.table,
        hops: [...derivedFrom.hops, { app: id, prefix, file: mod.path, line: inst.line }],
        // hono-base.js:76-85 — the clone copies the handlers at clone time
        errorHandler: derivedFrom.errorHandler,
        notFoundHandler: derivedFrom.notFoundHandler,
        mountRecords: [],
        fetchMounted: false,
        conditional: inst.conditional,
        chainedOps: inst.chainedOps,
      };
      this.mounts.push({
        parent: derivedFrom.id,
        child: id,
        prefix,
        kind: "basePath",
        file: mod.path,
        line: inst.line,
        confidence: inst.basePath?.literal === false ? "inferred" : "extracted",
      });
    } else {
      app = {
        id,
        file: mod.path,
        local: inst.local,
        line: inst.line,
        ctor: inst.ctor === "derived" ? "Hono" : inst.ctor,
        strict: inst.strict,
        basePath: "/",
        derivedFrom: null,
        owner: null as unknown as SimApp,
        table: [],
        hops: [],
        errorHandler: null,
        notFoundHandler: null,
        mountRecords: [],
        fetchMounted: false,
        conditional: inst.conditional,
        chainedOps: inst.chainedOps,
      };
      app.owner = app;
    }
    this.apps.set(id, app);
    this.order.push(id);
  }

  /** Follow aliases, imports, re-exports and barrels from `name` as seen in `file`. */
  private resolveInstance(
    file: string,
    name: string,
    seen = new Set<string>(),
    trace?: { chained: number | null },
  ): SimApp | null {
    const key = `${file}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = this.facts.get(file);
    if (!mod) return null;
    if (name.includes(".")) {
      const [ns, member] = name.split(".");
      const b = bindingOf(mod, ns);
      if (b?.imp.resolved && b.imported === "*")
        return this.resolveExport(b.imp.resolved, member, seen, trace);
      return null;
    }
    const direct = this.apps.get(`${file}#${name}`);
    if (direct) {
      if (trace && trace.chained === null) trace.chained = direct.chainedOps;
      return direct;
    }
    const alias = mod.aliases[name];
    if (alias) {
      if (trace && trace.chained === null) trace.chained = alias.chainedOps;
      return this.resolveInstance(file, alias.target, seen, trace);
    }
    const b = bindingOf(mod, name);
    if (b?.imp.resolved && b.imported !== "*")
      return this.resolveExport(b.imp.resolved, b.imported, seen, trace);
    return null;
  }

  private resolveExport(
    file: string,
    exportName: string,
    seen: Set<string>,
    trace?: { chained: number | null },
  ): SimApp | null {
    const mod = this.facts.get(file);
    if (!mod) return null;
    for (const ex of mod.exports) {
      if (ex.name !== exportName || ex.isType) continue;
      if (ex.kind === "local" && ex.local) {
        const r = this.resolveInstance(file, ex.local, seen, trace);
        if (r) return r;
      } else if (ex.kind === "from" && ex.from) {
        const target = this.importTarget(mod, ex.from);
        if (target && ex.imported && ex.imported !== "*") {
          const key = `${target}::export:${ex.imported}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const r = this.resolveExport(target, ex.imported, seen, trace);
          if (r) return r;
        }
      }
    }
    if (exportName !== "default") {
      for (const ex of mod.exports) {
        if (ex.kind !== "star" || !ex.from) continue;
        const target = this.importTarget(mod, ex.from);
        if (!target) continue;
        const key = `${target}::export:${exportName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = this.resolveExport(target, exportName, seen, trace);
        if (r) return r;
      }
    }
    return null;
  }

  private importTarget(mod: ModuleFacts, specifier: string): string | null {
    return mod.imports.find((i) => i.specifier === specifier && i.reexport)?.resolved ?? null;
  }

  private newOrigin(
    mod: ModuleFacts,
    app: SimApp,
    p: Partial<Origin> & Pick<Origin, "via" | "method" | "localPath" | "line" | "args">,
  ): Origin {
    return {
      app: app.id,
      pathNonLiteral: false,
      file: mod.path,
      openapi: null,
      conditional: false,
      hops: app.hops,
      ...p,
    };
  }

  /** hono-base.js:241-251 `#addRoute`: merge the instance basePath into the path, append. */
  private add(app: SimApp, origin: Origin, path: string): void {
    app.owner.table.push({
      origin,
      path: mergePath(app.basePath, path),
      chain: [...app.hops],
      wraps: [],
    });
  }

  private applyRegistration(
    mod: ModuleFacts,
    app: SimApp,
    op: Extract<ModuleFacts["ops"][number], { op: "reg" }>,
  ): void {
    const common = { conditional: op.conditional, line: op.line, openapi: op.openapi };
    if (op.via === "use") {
      const path = op.paths[0];
      // hono-base.js:61-71 — one ALL entry per middleware function
      for (const arg of op.args) {
        const origin = this.newOrigin(mod, app, {
          ...common,
          via: "use",
          method: "ALL",
          localPath: path.value,
          pathNonLiteral: !path.literal,
          args: [arg],
        });
        this.add(app, origin, path.value === "*" ? "*" : path.value);
      }
      return;
    }
    if (op.via === "mount") {
      const path = op.paths[0];
      const origin = this.newOrigin(mod, app, {
        ...common,
        via: "mount",
        method: "ALL",
        localPath: path.value,
        pathNonLiteral: !path.literal,
        args: op.args,
      });
      // hono-base.js:238 — an ALL entry at `${prefix}/*`
      this.add(app, origin, mergePath(path.value, "*"));
      this.recordFetchMount(mod, app, path.value, op);
      return;
    }
    // `app.get("/x")` alone only sets the sticky path; nothing is registered (hono-base.js:42-48)
    if (op.args.length === 0) return;
    // hono-base.js:51-60 `on` iterates paths, then methods; get/post/... take one path
    for (const path of op.paths) {
      for (const method of op.methods) {
        const origin = this.newOrigin(mod, app, {
          ...common,
          via: op.via,
          method,
          localPath: path.value,
          pathNonLiteral: !path.literal,
          args: op.args,
        });
        this.add(app, origin, path.value);
      }
    }
  }

  private recordFetchMount(
    mod: ModuleFacts,
    parent: SimApp,
    prefix: string,
    op: Extract<ModuleFacts["ops"][number], { op: "reg" }>,
  ): void {
    const arg = op.args[0];
    const owner =
      arg?.kind === "identifier" && arg.name === "fetch" && arg.text.endsWith(".fetch")
        ? arg.text.slice(0, -".fetch".length)
        : null;
    const child = owner ? this.resolveInstance(mod.path, owner) : null;
    if (!child) return;
    child.owner.fetchMounted = true;
    this.mounts.push({
      parent: parent.id,
      child: child.id,
      prefix,
      kind: "mount",
      file: mod.path,
      line: op.line,
      confidence: "extracted",
    });
  }

  /** hono-base.js:106-118 `route()`: copy the child's table as it is right now. */
  private applyRoute(
    mod: ModuleFacts,
    parent: SimApp,
    op: Extract<ModuleFacts["ops"][number], { op: "route" }>,
  ): void {
    const child = op.child ? this.resolveInstance(mod.path, op.child) : null;
    if (!child) {
      this.warnings.push({
        file: mod.path,
        reason: `route("${op.prefix.value}", ${op.childText || "?"}) at line ${op.line}: child is not a known Hono instance, its routes are not composed`,
      });
      return;
    }
    const subBase = mergePath(parent.basePath, op.prefix.value);
    const hop: MountHop = { app: child.id, prefix: op.prefix.value, file: mod.path, line: op.line };
    const source = child.owner.table.slice();
    child.owner.mountRecords.push({
      parentOwner: parent.owner,
      parentBase: subBase,
      prefix: op.prefix.value,
      atLen: source.length,
    });
    for (const e of source) {
      const wraps = [...e.wraps];
      // hono-base.js:110 — wrapped only when the child's errorHandler is set at this moment
      if (child.errorHandler) wraps.push(child.errorHandler);
      parent.owner.table.push({
        origin: e.origin,
        path: mergePath(subBase, e.path),
        chain: [...parent.hops, hop, ...e.chain],
        wraps,
      });
    }
    this.mounts.push({
      parent: parent.id,
      child: child.id,
      prefix: op.prefix.value,
      kind: "route",
      file: mod.path,
      line: op.line,
      confidence: op.prefix.literal && !op.conditional ? "extracted" : "inferred",
    });
  }

  // ---- emission -----------------------------------------------------------

  private servedApps(): Set<AppId> {
    const served = new Set<AppId>();
    for (const mod of this.facts.values()) {
      if (mod.isTest) continue;
      for (const s of mod.serves) {
        const app = s.appRef ? this.resolveInstance(mod.path, s.appRef) : null;
        if (app) served.add(app.id);
      }
      for (const ex of mod.exports) {
        if (ex.name !== "default" || ex.isType) continue;
        const app = ex.local ? this.resolveInstance(mod.path, ex.local) : null;
        if (app) served.add(app.id);
      }
    }
    return served;
  }

  private emit(): Composition {
    const served = this.servedApps();
    const all = this.order.map((id) => this.apps.get(id) as SimApp);
    const owners = all.filter((a) => a.owner === a);
    const roots = owners.filter((a) => a.mountRecords.length === 0);
    const servedRoots = new Set([...served].map((id) => (this.apps.get(id) as SimApp).owner.id));
    const anyServed = servedRoots.size > 0;
    const isLive = (r: SimApp) => !anyServed || servedRoots.has(r.id) || r.fetchMounted;

    const routes: RouteEntry[] = [];
    const middlewares: MiddlewareEntry[] = [];
    const tables = new Map<AppId, RootTable>();
    const stranded: (RouteEntry | MiddlewareEntry)[] = [];

    for (const root of roots) {
      const live = isLive(root);
      const regs = root.table.map((e, seq) =>
        this.registrationOf(e, seq, root.id, root.errorHandler, live, []),
      );
      const matcher = new TableMatcher(
        root.table.map((e, i) =>
          regs[i].pathNonLiteral || /\$\{/.test(e.path)
            ? null
            : { method: e.origin.method, path: e.path },
        ),
      );
      const entries = regs.map((r) => r);
      tables.set(root.id, { root: root.id, live, entries, matcher });
      for (const r of entries) (isRoute(r) ? routes : middlewares).push(r as never);
      this.computeChains(tables.get(root.id) as RootTable, root);
    }

    // entries added to a sub-app after it was mounted are not served through the parent
    const nextSeq = new Map<AppId, number>();
    for (const owner of owners) {
      if (owner.mountRecords.length === 0) continue;
      const first = owner.mountRecords[0];
      const minLen = Math.min(...owner.mountRecords.map((m) => m.atLen));
      const top = this.topOf(owner);
      for (let i = minLen; i < owner.table.length; i++) {
        const e = owner.table[i];
        const seq = nextSeq.get(top.id) ?? tables.get(top.id)?.entries.length ?? 0;
        nextSeq.set(top.id, seq + 1);
        const lifted: SimEntry = {
          ...e,
          path: this.liftPath(owner, e.path),
          chain: [
            ...first.parentOwner.hops,
            { app: owner.id, prefix: first.prefix, file: e.origin.file, line: e.origin.line },
            ...e.chain,
          ],
        };
        const reg = this.registrationOf(lifted, seq, top.id, null, false, [
          `registered after '${owner.local}' was mounted at '${first.prefix}': the parent never serves it (hono-base.js:106-118 copies the table at route() time)`,
        ]);
        stranded.push(reg);
        (isRoute(reg) ? routes : middlewares).push(reg as never);
      }
    }

    const apps = all.map((a) => this.nodeOf(a, roots.includes(a)));
    return {
      apps,
      mounts: this.mounts,
      roots: roots.map((r) => r.id),
      routes,
      middlewares,
      tables,
      stranded,
      served,
      warnings: this.warnings,
      resolveApp: (file, ref) => this.resolveInstance(file, ref)?.id ?? null,
      rpcTarget: (file, ref) => {
        const trace: { chained: number | null } = { chained: null };
        const app = this.resolveInstance(file, ref, new Set(), trace);
        return app ? { id: app.id, chainedOps: trace.chained ?? 0 } : null;
      },
      resolveFn: (file, ref) => this.resolveFunctionRef(file, ref)?.fn ?? null,
    };
  }

  private topOf(owner: SimApp): SimApp {
    let cur = owner;
    for (let guard = 0; guard < 50 && cur.mountRecords.length > 0; guard++)
      cur = cur.mountRecords[0].parentOwner;
    return cur;
  }

  /** Path of a sub-app entry as the first mount chain would serve it. */
  private liftPath(owner: SimApp, path: string): string {
    let cur = owner;
    let p = path;
    for (let guard = 0; guard < 50 && cur.mountRecords.length > 0; guard++) {
      const rec = cur.mountRecords[0];
      p = mergePath(rec.parentBase, p);
      cur = rec.parentOwner;
    }
    return p;
  }

  private nodeOf(a: SimApp, isRoot: boolean): AppNode {
    const exportedAs: string[] = [];
    const mod = this.facts.get(a.file);
    for (const ex of mod?.exports ?? []) {
      if (
        ex.kind === "local" &&
        !ex.isType &&
        (ex.local === a.local || (a.local === "default" && ex.name === "default"))
      ) {
        if (!exportedAs.includes(ex.name)) exportedAs.push(ex.name);
      }
    }
    return {
      id: a.id,
      file: a.file,
      local: a.local,
      line: a.line,
      ctor: a.ctor,
      basePath: a.basePath,
      derivedFrom: a.derivedFrom?.id ?? null,
      exportedAs,
      isRoot: isRoot && a.owner === a,
      errorHandler: a.errorHandler,
      notFoundHandler: a.notFoundHandler,
      strict: a.strict,
    };
  }

  // ---- registrations ------------------------------------------------------

  private registrationOf(
    e: SimEntry,
    seq: number,
    root: AppId,
    rootErrorHandler: HandlerRef | null,
    live: boolean,
    notes: string[],
  ): RouteEntry | MiddlewareEntry {
    const o = e.origin;
    const mod = this.facts.get(o.file) as ModuleFacts;
    const confidence: Confidence = o.conditional || o.pathNonLiteral ? "inferred" : "extracted";
    const regNotes = [...notes];
    if (o.pathNonLiteral)
      regNotes.push("route path is not a string literal: excluded from matching");
    if (o.conditional) regNotes.push("registered inside a conditional or loop: may not run");
    const base = {
      id: `${root}|${seq}`,
      root: live ? root : null,
      seq,
      app: o.app,
      method: o.method,
      fullPath: e.path,
      localPath: o.localPath,
      file: o.file,
      line: o.line,
      mountChain: e.chain,
      pathNonLiteral: o.pathNonLiteral,
      reachable: live,
      confidence,
      notes: regNotes,
    };
    if (o.via === "use") {
      const arg = o.args[0];
      const d = arg ? this.describe(mod, arg) : null;
      const mw: MiddlewareEntry = {
        ...base,
        name: d?.name ?? null,
        source: d?.source ?? null,
        kind: d?.kind ?? "inline",
        isAuth: d?.isAuth ?? false,
        options: d?.options ?? null,
        fn: d?.fn ?? null,
        registeredAfterRoutes: [],
      };
      if (arg?.spread) mw.notes.push("spread middleware list: individual functions not analysed");
      return mw;
    }
    const args = o.args;
    const handlerArg =
      o.via === "mount"
        ? null
        : args.length > 0 && !args[args.length - 1].spread
          ? args[args.length - 1]
          : null;
    const pre = handlerArg ? args.slice(0, -1) : args;
    const inline: MiddlewareRef[] = [];
    const validators: ValidatorRef[] = [];
    for (const a of pre) {
      const v = this.validatorOf(mod, a, "route");
      if (v) {
        validators.push(v);
        continue;
      }
      const d = this.describe(mod, a);
      inline.push({ name: d.name, source: d.source, isAuth: d.isAuth, file: o.file, line: a.line });
    }
    // a route whose last argument is itself a validator has no handler of its own
    const lastValidator = handlerArg ? this.validatorOf(mod, handlerArg, "route") : null;
    if (lastValidator) validators.push(lastValidator);
    if (o.openapi) {
      for (const v of o.openapi.validators) {
        validators.push({
          target: (VALIDATOR_TARGETS.has(v.target)
            ? v.target
            : "unknown") as ValidatorRef["target"],
          library: "zod",
          via: "openapi",
          schema: v.schema,
          scope: "route",
          file: o.file,
          line: o.line,
        });
      }
    }
    const handler = handlerArg && !lastValidator ? this.handlerFacts(mod, handlerArg) : null;
    const route: RouteEntry = {
      ...base,
      kind: o.via === "mount" ? "mount" : "route",
      params: [...e.path.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      handler,
      inline,
      validators,
      chain: [],
      unreached: [],
      errorHandler: e.wraps[0] ?? rootErrorHandler,
      openapi: o.via === "openapi",
    };
    return route;
  }

  /** chain / unreached / registeredAfterRoutes for one root table, through hono's router. */
  private computeChains(table: RootTable, root: SimApp): void {
    const entries = table.entries;
    const sims = root.table;
    const isUse = (i: number) => sims[i].origin.via === "use";
    entries.forEach((entry, p) => {
      if (isUse(p) || entry.pathNonLiteral) return;
      const route = entry as RouteEntry;
      const method = route.method === "ALL" ? "GET" : route.method;
      let hits: ReturnType<TableMatcher["match"]> | null = null;
      for (const sample of samplePaths(route.fullPath)) {
        const h = table.matcher.match(method, sample);
        if (h.some((x) => x.index === p)) {
          hits = h;
          break;
        }
      }
      if (!hits) {
        route.notes.push("no sample path matched this route in hono's router: chain not computed");
        return;
      }
      for (const h of hits) {
        if (h.index === p || !isUse(h.index)) continue;
        const mw = entries[h.index] as MiddlewareEntry;
        const step: ChainStep = {
          middlewareId: mw.id,
          name: mw.name,
          scope: mw.fullPath === "/*" || mw.fullPath === "*" ? "global" : "mount",
          isAuth: mw.isAuth,
          file: mw.file,
          line: mw.line,
          seq: mw.seq,
        };
        if (h.index < p) {
          route.chain.push(step);
          const mod = this.facts.get(sims[h.index].origin.file) as ModuleFacts;
          const v = this.validatorOf(mod, sims[h.index].origin.args[0], "mount");
          if (v) route.validators.push(v);
        } else {
          route.unreached.push(step);
          // same table level: the middleware sits in the table this route was registered into
          const mchain = mw.mountChain;
          if (
            mchain.length <= route.mountChain.length &&
            mchain.every((hop, i) => sameHop(hop, route.mountChain[i]))
          ) {
            mw.registeredAfterRoutes.push(route.id);
          }
        }
      }
      for (const inl of route.inline) {
        route.chain.push({
          middlewareId: null,
          name: inl.name,
          scope: "route",
          isAuth: inl.isAuth,
          file: inl.file,
          line: inl.line,
          seq: p,
        });
      }
    });
  }

  // ---- argument interpretation ---------------------------------------------

  private describe(mod: ModuleFacts, arg: ArgFact): Described {
    if (arg.kind === "function") {
      return {
        name: arg.name,
        source: null,
        kind: "inline",
        isAuth: false,
        options: null,
        fn: fnFacts(arg.fn, false, mod.path),
      };
    }
    const b = bindingOf(mod, arg.root);
    let source: string | null = null;
    let kind: MiddlewareEntry["kind"] = "local";
    let fn: RawFn | null = arg.fn;
    let fnFile = mod.path;
    if (b?.imp.canonical) {
      source = b.imp.canonical;
      kind = source === "hono" || source.startsWith("hono/") ? "builtin" : "third-party";
    } else if (b?.imp.resolved) {
      source = `./${b.imp.resolved}`;
      if (!fn && arg.kind === "identifier") {
        const found = this.findFunction(
          b.imp.resolved,
          b.imported === "*" ? (arg.name ?? "") : b.imported,
          0,
        );
        fn = found?.fn ?? null;
        if (found) fnFile = found.file;
      }
    } else if (arg.root && (arg.root in mod.functions || mod.topLevelValues.includes(arg.root))) {
      source = `./${mod.path}`;
      if (!fn && arg.kind === "identifier") fn = mod.functions[arg.root] ?? null;
    }
    const firstLiteral = arg.literals[0];
    const options: LiteralValue | null =
      firstLiteral !== undefined &&
      typeof firstLiteral === "object" &&
      firstLiteral !== null &&
      !("$expr" in firstLiteral)
        ? firstLiteral
        : null;
    return {
      name: arg.name,
      source,
      kind,
      isAuth: isAuthName(arg.name, source, this.config),
      options,
      fn: fnFacts(fn, true, fnFile),
    };
  }

  private validatorOf(
    mod: ModuleFacts,
    arg: ArgFact | undefined,
    scope: ValidatorRef["scope"],
  ): ValidatorRef | null {
    if (arg?.kind !== "call" || !arg.name) return null;
    const b = bindingOf(mod, arg.root);
    const canonical = b?.imp.canonical ?? null;
    const byModule = canonical ? VALIDATOR_LIBRARIES[canonical] : undefined;
    const byName = VALIDATOR_BY_NAME[arg.name];
    const looksLikeValidator = /alidator$/.test(arg.name) || arg.name === "validator";
    const first = arg.literals[0];
    if (
      !(
        byModule ||
        (byName && !canonical) ||
        (looksLikeValidator && typeof first === "string" && VALIDATOR_TARGETS.has(first))
      )
    )
      return null;
    if (canonical && !byModule && !looksLikeValidator) return null;
    const second = arg.args[1];
    return {
      target:
        typeof first === "string" && VALIDATOR_TARGETS.has(first)
          ? (first as ValidatorRef["target"])
          : "unknown",
      library: byModule ?? byName ?? "unknown",
      via: arg.name,
      schema:
        second && (second.kind === "identifier" || second.kind === "call") ? second.text : null,
      scope,
      file: mod.path,
      line: arg.line,
    };
  }

  /** `foo` (local or imported, through barrels) → its function body facts. */
  private findFunction(
    file: string,
    name: string,
    depth: number,
  ): { file: string; name: string; fn: RawFn } | null {
    const mod = this.facts.get(file);
    if (!mod || depth > 5) return null;
    for (const ex of mod.exports) {
      if (ex.name !== name || ex.isType) continue;
      if (ex.kind === "local" && ex.local && mod.functions[ex.local])
        return { file, name: ex.local, fn: mod.functions[ex.local] };
      if (ex.kind === "local" && ex.local) {
        const b = bindingOf(mod, ex.local);
        if (b?.imp.resolved) return this.findFunction(b.imp.resolved, b.imported, depth + 1);
      }
      if (ex.kind === "from" && ex.from && ex.imported) {
        const target = this.importTarget(mod, ex.from);
        if (target) return this.findFunction(target, ex.imported, depth + 1);
      }
    }
    for (const ex of mod.exports) {
      if (ex.kind !== "star" || !ex.from) continue;
      const target = this.importTarget(mod, ex.from);
      const r = target ? this.findFunction(target, name, depth + 1) : null;
      if (r) return r;
    }
    if (mod.functions[name]) return { file, name, fn: mod.functions[name] };
    return null;
  }

  private resolveFunctionRef(
    file: string,
    ref: string,
  ): { file: string; name: string; fn: RawFn } | null {
    const mod = this.facts.get(file);
    if (!mod) return null;
    if (mod.functions[ref]) return { file, name: ref, fn: mod.functions[ref] };
    const b = bindingOf(mod, ref);
    if (!b?.imp.resolved) return null;
    return this.findFunction(b.imp.resolved, b.imported === "*" ? ref : b.imported, 0);
  }

  private rootInfo(
    mod: ModuleFacts,
    root: string | null,
  ): { resolved: string | null; external: boolean } {
    const b = bindingOf(mod, root);
    if (b?.imp.resolved) return { resolved: b.imp.resolved, external: false };
    if (b?.imp.canonical) return { resolved: b.imp.canonical, external: true };
    return { resolved: null, external: false };
  }

  private handlerFacts(mod: ModuleFacts, arg: ArgFact): HandlerFacts {
    let defMod = mod;
    let fn: RawFn | null = null;
    let kind: HandlerFacts["kind"] = "unknown";
    let resolved: string | null = null;
    if (arg.kind === "function") {
      fn = arg.fn;
      kind = "inline";
    } else if (arg.kind === "identifier") {
      kind = "identifier";
      const b = bindingOf(mod, arg.root);
      if (arg.root && arg.root === arg.name && mod.functions[arg.name]) {
        fn = mod.functions[arg.name];
        resolved = `${mod.path}#${arg.name}`;
      } else if (b?.imp.resolved) {
        const found = this.findFunction(
          b.imp.resolved,
          b.imported === "*" ? (arg.name ?? "") : b.imported,
          0,
        );
        if (found) {
          fn = found.fn;
          defMod = this.facts.get(found.file) as ModuleFacts;
          resolved = `${found.file}#${found.name}`;
        } else resolved = b.imp.resolved;
      } else if (b?.imp.canonical) resolved = b.imp.canonical;
    } else if (arg.kind === "call") {
      kind = "factory";
      fn = arg.fn;
    }
    const empty: HandlerFacts = {
      file: defMod.path,
      line: fn?.line ?? arg.line,
      kind,
      resolved,
      bodyReads: [],
      validReads: [],
      paramReads: [],
      queryReads: [],
      dbAccess: [],
      envReads: [],
      calls: [],
      throwsHttpException: false,
    };
    if (!fn) return empty;
    const dbList = [...DEFAULT_DB_SPECIFIERS, ...this.config.dbSpecifiers];
    const calls = fn.calls.map((c) => ({
      callee: c.callee,
      resolved: this.rootInfo(defMod, c.root).resolved,
      line: c.line,
    }));
    const dbAccess: HandlerFacts["dbAccess"] = [];
    for (const c of fn.calls) {
      const info = this.rootInfo(defMod, c.root);
      let source: string | null = null;
      if (info.resolved && info.external && matchesSpecifier(info.resolved, dbList))
        source = info.resolved;
      else if (info.resolved && !info.external && this.dbModules.has(info.resolved))
        source = info.resolved;
      else if (
        !info.resolved &&
        c.root &&
        defMod.topLevelValues.includes(c.root) &&
        this.dbModules.has(defMod.path)
      )
        source = defMod.path;
      if (source) dbAccess.push({ via: c.callee, source, line: c.line });
    }
    const envModules = this.config.envValidationModules;
    const envReads: EnvRead[] = defMod.envReads
      .filter((r) => r.line >= fn.line && r.line <= fn.endLine)
      .map((r) => ({ ...r, validated: r.validated || envModules.includes(r.file) }));
    return {
      ...empty,
      bodyReads: fn.bodyReads,
      validReads: fn.validReads,
      paramReads: fn.paramReads,
      queryReads: fn.queryReads,
      dbAccess,
      envReads,
      calls,
      throwsHttpException: fn.throwsHttpException,
      requestEscapes: fn.requestEscapes,
    };
  }
}

interface Described {
  name: string | null;
  source: string | null;
  kind: MiddlewareEntry["kind"];
  isAuth: boolean;
  options: LiteralValue | null;
  fn: MiddlewareFnFacts | null;
}

/** A referenced function only counts as middleware when it takes `next`; an inline one always does. */
function fnFacts(fn: RawFn | null, requireNext: boolean, file: string): MiddlewareFnFacts | null {
  if (fn && requireNext && fn.nextParam === null) return null;
  return fn
    ? {
        callsNext: fn.callsNext,
        awaitsOrReturnsNext: fn.awaitsOrReturnsNext,
        line: fn.line,
        declaresNext: fn.nextParam !== null,
        passesNext: fn.nextPassed,
        file,
      }
    : null;
}

function isRoute(r: RouteEntry | MiddlewareEntry): r is RouteEntry {
  return "chain" in r;
}

function sameHop(a: MountHop, b: MountHop | undefined): boolean {
  return !!b && a.app === b.app && a.file === b.file && a.line === b.line;
}
