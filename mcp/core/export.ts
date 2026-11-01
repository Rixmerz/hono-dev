/** Graphify-compatible node-link export for LiveSpec `ingest_external_graph` (contract section 12). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { basename } from "./fs.ts";
import type { ProjectIndex } from "./index.ts";
import type { ExportResult, MiddlewareEntry, RouteEntry } from "./types.ts";

type HonoKind = "app" | "route" | "middleware" | "validator" | "handler" | "module";
type Edge = "mounts" | "guards" | "validates" | "handles" | "calls" | "imports";

interface ExportNode {
  id: string;
  label: string;
  source_file: string;
  source_location: string;
  _callable: boolean;
  _origin: "ast";
  hono_kind: HonoKind;
  hono_method?: string;
  hono_full_path?: string;
  hono_local_path?: string;
}

interface ExportLink {
  source: string;
  target: string;
  relation: "uses" | "calls" | "imports" | "mounts";
  confidence: "EXTRACTED" | "INFERRED";
  confidence_score: number;
  _origin: "ast";
  hono_edge: Edge;
}

const RELATION_OF: Record<Edge, ExportLink["relation"]> = {
  mounts: "mounts",
  guards: "uses",
  validates: "uses",
  handles: "calls",
  calls: "calls",
  imports: "imports",
};

const appNodeId = (file: string, local: string) => `${file}::${local}`;
const routeNodeId = (r: RouteEntry | MiddlewareEntry) => `${r.file}::${r.method} ${r.fullPath}`;

export async function exportGraph(
  idx: ProjectIndex,
  opts: { path?: string } = {},
): Promise<ExportResult> {
  const nodes = new Map<string, ExportNode>();
  const links = new Map<string, ExportLink>();
  const byRelation: Record<string, number> = {};

  const link = (source: string, target: string, edge: Edge, inferred: boolean) => {
    if (source === target) return;
    const key = `${source}\0${target}\0${edge}`;
    if (links.has(key)) return;
    const relation = RELATION_OF[edge];
    links.set(key, {
      source,
      target,
      relation,
      confidence: inferred ? "INFERRED" : "EXTRACTED",
      confidence_score: inferred ? 0.6 : 0.9,
      _origin: "ast",
      hono_edge: edge,
    });
    byRelation[relation] = (byRelation[relation] ?? 0) + 1;
  };
  const ensureModule = (file: string): string => {
    if (!nodes.has(file)) {
      nodes.set(file, {
        id: file,
        label: basename(file),
        source_file: file,
        source_location: "L1",
        _callable: false,
        _origin: "ast",
        hono_kind: "module",
      });
    }
    return file;
  };

  for (const app of idx.apps) {
    nodes.set(appNodeId(app.file, app.local), {
      id: appNodeId(app.file, app.local),
      label: app.local.startsWith("$") ? `Hono@L${app.line}` : app.local,
      source_file: app.file,
      source_location: `L${app.line}`,
      _callable: false,
      _origin: "ast",
      hono_kind: "app",
    });
  }
  const appNode = (id: string) => {
    const a = idx.apps.find((x) => x.id === id);
    return a ? appNodeId(a.file, a.local) : undefined;
  };
  for (const m of idx.mounts) {
    const s = appNode(m.parent);
    const t = appNode(m.child);
    if (s && t) link(s, t, "mounts", m.confidence === "inferred");
  }

  const mwNodeIds = new Map<string, string>();
  for (const m of idx.middlewares) {
    const id = `${m.file}::use ${m.fullPath} ${m.name ?? "(inline)"}@L${m.line}`;
    mwNodeIds.set(m.id, id);
    nodes.set(id, {
      id,
      label: `use ${m.fullPath} ${m.name ?? "(inline)"}`.trim(),
      source_file: m.file,
      source_location: `L${m.line}`,
      _callable: true,
      _origin: "ast",
      hono_kind: "middleware",
      hono_method: m.method,
      hono_full_path: m.fullPath,
      hono_local_path: m.localPath,
    });
  }

  for (const r of idx.routes) {
    const id = routeNodeId(r);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: `${r.method} ${r.fullPath}`,
        source_file: r.file,
        source_location: `L${r.line}`,
        _callable: true,
        _origin: "ast",
        hono_kind: "route",
        hono_method: r.method,
        hono_full_path: r.fullPath,
        hono_local_path: r.localPath,
      });
    }
    const owner = appNode(r.app);
    if (owner) link(owner, id, "handles", false);
    for (const step of [...r.chain, ...r.unreached]) {
      const mw = step.middlewareId ? mwNodeIds.get(step.middlewareId) : undefined;
      if (mw) link(id, mw, "guards", r.unreached.includes(step));
    }
    for (const v of r.validators) {
      const vid = `${v.file}::${v.via}(${v.target})@L${v.line}`;
      if (!nodes.has(vid)) {
        nodes.set(vid, {
          id: vid,
          label: `${v.via}(${v.target})`,
          source_file: v.file,
          source_location: `L${v.line}`,
          _callable: true,
          _origin: "ast",
          hono_kind: "validator",
        });
      }
      link(id, vid, "validates", false);
    }
    const h = r.handler;
    if (h?.resolved?.includes("#")) {
      const [file, name] = h.resolved.split("#");
      const hid = `${file}::${name}`;
      if (!nodes.has(hid)) {
        nodes.set(hid, {
          id: hid,
          label: name,
          source_file: file,
          source_location: `L${h.line}`,
          _callable: true,
          _origin: "ast",
          hono_kind: "handler",
        });
      }
      link(id, hid, "handles", false);
    }
    for (const c of h?.calls ?? []) {
      if (!c.resolved || !idx.facts.has(c.resolved)) continue;
      const name = c.callee.split(".").pop() ?? c.callee;
      const tid = `${c.resolved}::${name}`;
      if (!nodes.has(tid)) ensureModule(c.resolved);
      link(id, nodes.has(tid) ? tid : c.resolved, "calls", true);
    }
  }

  for (const [file, imports] of idx.graph.importsOf) {
    if (idx.facts.get(file)?.isTest) continue;
    for (const imp of imports) {
      if (idx.facts.get(imp.target)?.isTest) continue;
      link(ensureModule(file), ensureModule(imp.target), "imports", false);
    }
  }

  const doc = {
    directed: true,
    multigraph: false,
    graph: {
      generator: "hono-dev",
      hono: idx.detection.honoVersion.resolved ?? idx.detection.honoVersion.declared,
      workspace: basename(idx.workspace),
      exported_at: new Date().toISOString(),
    },
    nodes: [...nodes.values()],
    links: [...links.values()],
  };

  const target = opts.path ?? join(".hono-dev", "graph.json");
  const abs = isAbsolute(target) ? target : resolve(idx.workspace, target);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(doc, null, 1));
  const rel = relative(idx.workspace, abs);
  const shown = rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
  return {
    ok: true,
    path: shown,
    nodes: doc.nodes.length,
    links: doc.links.length,
    byRelation,
    livespecSnippet: `[graph]\nexternal = "${shown}"\nauto_ingest = true`,
  };
}
