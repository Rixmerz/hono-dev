/**
 * The per-workspace semantic index: scan → parse (incremental, with a facts cache kept outside
 * the workspace) → link imports → simulate the Hono apps → detect, rpc, env, graph.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { buildEnvValidation, buildRpc, collectEnvReads } from "./analysis.ts";
import { type Composition, composeProject, type RootTable } from "./compose.ts";
import { type Manifests, readHonoDevConfig, readManifests } from "./config.ts";
import { detectStatic, finalizeDetection, pickEntry } from "./detect.ts";
import { type FileStat, isDir, isSourceFile, readText, SOURCE_EXTS, walkFiles } from "./fs.ts";
import { buildImportGraph, computeDbModules, linkImports } from "./graph.ts";
import { PARSER_VERSION, parseModule } from "./parse.ts";
import { consumeDirty, stateDir } from "./state.ts";
import type {
  AppId,
  AppNode,
  Detection,
  EnvRead,
  EnvValidation,
  HonoDevConfig,
  ImportGraph,
  IndexStats,
  MiddlewareEntry,
  ModuleFacts,
  MountEdge,
  RouteEntry,
  RpcInfo,
} from "./types.ts";

export class IndexError extends Error {
  hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = "IndexError";
    this.hint = hint;
  }
}

/** Realpath of an absolute, existing directory; never requires the project to be Hono. */
export async function validateWorkspace(input: string): Promise<string> {
  if (!input || typeof input !== "string") {
    throw new IndexError("`workspace` is required", "pass the absolute path of the project root");
  }
  if (!isAbsolute(input)) {
    throw new IndexError(
      `workspace must be an absolute path, got "${input}"`,
      "use the absolute project root",
    );
  }
  const lexical = normalize(input).replace(/[\\/]+$/, "") || "/";
  if (lexical === "/" || /^[A-Za-z]:$/.test(lexical)) {
    throw new IndexError("refusing to index the filesystem root", "pass a project directory");
  }
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    throw new IndexError(`workspace does not exist: ${lexical}`);
  }
  if (!(await isDir(real))) throw new IndexError(`workspace is not a directory: ${real}`);
  return real;
}

interface CacheFile {
  schema: number;
  parser: number;
  files: Record<string, { size: number; mtime: number; facts: ModuleFacts }>;
}
const CACHE_SCHEMA = 1;

async function readCache(ws: string): Promise<CacheFile["files"]> {
  try {
    const raw = JSON.parse(
      await readFile(join(stateDir(ws), "facts-cache.json"), "utf8"),
    ) as CacheFile;
    if (raw.schema === CACHE_SCHEMA && raw.parser === PARSER_VERSION) return raw.files;
  } catch {
    // no cache yet, or unreadable: start cold
  }
  return {};
}

async function writeCache(ws: string, facts: Map<string, ModuleFacts>): Promise<void> {
  const files: CacheFile["files"] = {};
  for (const [path, f] of facts) files[path] = { size: f.size, mtime: f.mtime, facts: f };
  const dir = stateDir(ws);
  await mkdir(dir, { recursive: true });
  const body: CacheFile = { schema: CACHE_SCHEMA, parser: PARSER_VERSION, files };
  await writeFile(join(dir, "facts-cache.json"), JSON.stringify(body));
}

export class ProjectIndex {
  readonly workspace: string;
  detection!: Detection;
  config!: HonoDevConfig;
  manifests!: Manifests;
  files = new Map<string, FileStat>();
  facts = new Map<string, ModuleFacts>();
  apps: AppNode[] = [];
  mounts: MountEdge[] = [];
  roots: AppId[] = [];
  routes: RouteEntry[] = [];
  middlewares: MiddlewareEntry[] = [];
  graph!: ImportGraph;
  rpc: RpcInfo = { appTypes: [], clients: [] };
  envValidation: EnvValidation[] = [];
  /** Every env read of non-test code; `validated` also honours config.envValidationModules. */
  envReads: EnvRead[] = [];
  dbModules = new Set<string>();
  skipped: { file: string; reason: string }[] = [];
  stats: IndexStats = { files: 0, parsed: 0, reused: 0, removed: 0, ms: 0, builtAt: "" };
  composition!: Composition;
  private diskCache: CacheFile["files"] | null = null;

  private constructor(workspace: string) {
    this.workspace = workspace;
  }

  static async load(workspace: string, opts: { force?: boolean } = {}): Promise<ProjectIndex> {
    const idx = new ProjectIndex(workspace);
    await idx.refresh(opts.force ?? false);
    return idx;
  }

  /** Re-scan the workspace; re-parse only files whose mtime/size changed (or everything with force). */
  async refresh(force = false): Promise<IndexStats> {
    const t0 = performance.now();
    this.config = await readHonoDevConfig(this.workspace);
    this.manifests = await readManifests(this.workspace);
    const dirtyMarker = await consumeDirty(this.workspace);
    const dirty = dirtyMarker === "all" ? new Set<string>() : dirtyMarker;
    const forceAll = force || dirtyMarker === "all";
    if (this.diskCache === null) this.diskCache = forceAll ? {} : await readCache(this.workspace);

    const stats = (
      await walkFiles(this.workspace, this.workspace, {
        extensions: SOURCE_EXTS,
        ignore: this.config.ignore,
      })
    ).filter((s) => isSourceFile(s.path));
    const seen = new Set<string>();
    const newFiles = new Map<string, FileStat>();
    const facts = new Map<string, ModuleFacts>();
    let parsed = 0;
    let reused = 0;
    this.skipped = [];
    for (const st of stats) {
      seen.add(st.path);
      newFiles.set(st.path, st);
      if (st.size > this.config.maxFileBytes) {
        this.skipped.push({ file: st.path, reason: `larger than maxFileBytes (${st.size})` });
        continue;
      }
      const fresh = (f: ModuleFacts | undefined) =>
        !forceAll && !dirty.has(st.path) && f && f.size === st.size && f.mtime === st.mtime
          ? f
          : undefined;
      const hit = fresh(this.facts.get(st.path)) ?? fresh(this.diskCache[st.path]?.facts);
      if (hit) {
        facts.set(st.path, hit);
        reused++;
        continue;
      }
      const text = await readText(st.abs);
      if (text === null) {
        this.skipped.push({ file: st.path, reason: "unreadable" });
        continue;
      }
      const f = parseModule(st.path, text, { size: st.size, mtime: st.mtime });
      if (f.parseErrors.length)
        this.skipped.push({ file: st.path, reason: `syntax: ${f.parseErrors[0]}` });
      facts.set(st.path, f);
      parsed++;
    }
    const removed = [...this.facts.keys()].filter((p) => !seen.has(p)).length;
    this.facts = facts;
    this.files = newFiles;

    await this.derive();

    if (parsed > 0 || removed > 0 || Object.keys(this.diskCache).length === 0) {
      try {
        await writeCache(this.workspace, this.facts);
      } catch (e) {
        this.skipped.push({
          file: "(state)",
          reason: `facts cache not written: ${(e as Error).message}`,
        });
      }
      this.diskCache = {};
      for (const [p, f] of this.facts)
        this.diskCache[p] = { size: f.size, mtime: f.mtime, facts: f };
    }
    this.stats = {
      files: this.files.size,
      parsed,
      reused,
      removed,
      ms: Math.round(performance.now() - t0),
      builtAt: new Date().toISOString(),
    };
    return this.stats;
  }

  /** Everything computed from facts alone: links, graph, apps, routes, detection, rpc. */
  private async derive(): Promise<void> {
    const ctx = { manifests: this.manifests, files: new Set(this.files.keys()) };
    const unresolved = linkImports(this.facts, ctx);
    this.graph = buildImportGraph(this.facts, unresolved);
    this.dbModules = computeDbModules(this.facts, this.config);

    const entryFiles = [...this.facts.values()]
      .filter((m) => !m.isTest && m.serves.some((s) => s.kind !== "export-default"))
      .map((m) => m.path)
      .sort();
    if (this.config.entry) entryFiles.unshift(this.config.entry);
    const comp = composeProject({
      facts: this.facts,
      config: this.config,
      dbModules: this.dbModules,
      entryFiles,
    });
    this.composition = comp;
    this.apps = comp.apps;
    this.mounts = comp.mounts;
    this.roots = comp.roots;
    this.routes = comp.routes;
    this.middlewares = comp.middlewares;
    for (const w of comp.warnings)
      this.skipped.push({ file: w.file, reason: `compose: ${w.reason}` });

    this.rpc = buildRpc(this.facts, comp);
    this.envValidation = buildEnvValidation(this.facts, this.config);
    this.envReads = collectEnvReads(this.facts, this.config);

    const entry = pickEntry(this.facts, this.config, comp.resolveApp);
    const st = await detectStatic(this.workspace, this.manifests);
    this.detection = finalizeDetection(st, this.facts, entry, this.apps.length > 0);
  }

  table(root: AppId): RootTable | undefined {
    return this.composition.tables.get(root);
  }

  /** Routes registered in `file`, or whose handler body lives there. */
  routesForFile(file: string): RouteEntry[] {
    return this.routes.filter((r) => r.file === file || r.handler?.file === file);
  }

  findRoute(method: string, fullPath: string): RouteEntry | undefined {
    const m = method.toUpperCase();
    const hits = this.routes.filter((r) => r.method === m && r.fullPath === fullPath);
    return hits.find((r) => r.reachable) ?? hits[0];
  }

  /** Files importing `file`, transitively, with the shortest chain to each. */
  importersOf(file: string, depth = 3): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const queue: { file: string; chain: string[] }[] = [{ file, chain: [file] }];
    const seen = new Set([file]);
    while (queue.length) {
      const cur = queue.shift() as { file: string; chain: string[] };
      if (cur.chain.length - 1 >= depth) continue;
      for (const by of this.graph.importedBy.get(cur.file) ?? []) {
        if (seen.has(by)) continue;
        seen.add(by);
        const chain = [...cur.chain, by];
        out.set(by, chain);
        queue.push({ file: by, chain });
      }
    }
    return out;
  }
}

/** One server process, N workspaces; the key is the workspace realpath. */
export class IndexManager {
  private readonly indexes = new Map<string, ProjectIndex>();

  async get(workspaceArg: string, opts: { force?: boolean } = {}): Promise<ProjectIndex> {
    const workspace = await validateWorkspace(workspaceArg);
    const cached = this.indexes.get(workspace);
    if (cached) {
      await cached.refresh(opts.force ?? false);
      return cached;
    }
    const idx = await ProjectIndex.load(workspace, { force: opts.force ?? false });
    this.indexes.set(workspace, idx);
    return idx;
  }

  invalidate(ws: string): void {
    this.indexes.delete(ws);
    try {
      this.indexes.delete(realpathSync(ws));
    } catch {
      // the workspace is gone: the lexical key above was all there was to drop
    }
  }
}
