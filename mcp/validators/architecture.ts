/** A001-A004: where routes get their data from, and how the app is assembled. */
import type { ProjectIndex } from "../core/index.ts";
import type { AppNode, Finding } from "../core/types.ts";
import { finding, liveRoutes, type Rule, routeLabel, where } from "./rule.ts";

function inDirs(file: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const dir = d.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    return file === dir || file.startsWith(`${dir}/`);
  });
}

const A001: Rule = {
  id: "A001",
  category: "architecture",
  severity: "warning",
  title: "route handler touches a DB client directly instead of a service",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const r of liveRoutes(index)) {
      const h = r.handler;
      if (!h || (files && !files.has(h.file))) continue;
      // reaching the database through a module under `serviceDirs` is the pattern, not the smell
      const direct = h.dbAccess.filter((d) => !inDirs(d.source, index.config.serviceDirs));
      if (direct.length === 0) continue;
      const first = direct[0];
      out.push(
        finding(
          A001,
          h.file,
          `${routeLabel(r)} calls the database itself (${first.via}, from ${first.source}) instead of going through a service`,
          {
            line: first.line,
            route: routeLabel(r),
            hint: `move the query into a module under ${index.config.serviceDirs[0] ?? "src/services"} and call that`,
          },
        ),
      );
    }
    return out;
  },
};

/** The roots whose fetch is exposed, each with every instance of the root that is exposed. */
function servedRoots(index: ProjectIndex): { root: AppNode; served: AppNode[] }[] {
  const byId = new Map(index.apps.map((a) => [a.id, a]));
  const ownerOf = (a: AppNode): AppNode => {
    let cur = a;
    for (let guard = 0; cur.derivedFrom && guard < 50; guard++)
      cur = byId.get(cur.derivedFrom) ?? cur;
    return cur;
  };
  const out = new Map<string, { root: AppNode; served: AppNode[] }>();
  for (const id of index.composition.served) {
    const app = byId.get(id);
    if (!app) continue;
    const root = ownerOf(app);
    if (!index.roots.includes(root.id)) continue;
    const hasRoutes = index.table(root.id)?.entries.some((e) => "chain" in e && e.kind === "route");
    if (!hasRoutes) continue;
    const slot = out.get(root.id) ?? { root, served: [] };
    slot.served.push(app);
    out.set(root.id, slot);
  }
  return [...out.values()];
}

const A002: Rule = {
  id: "A002",
  category: "architecture",
  severity: "warning",
  title: "root app with no onError",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const { root, served } of servedRoots(index)) {
      if (served.some((a) => a.errorHandler) || (files && !files.has(root.file))) continue;
      out.push(
        finding(
          A002,
          root.file,
          `'${root.local}' is served but never calls onError: an uncaught throw answers a bare 500 'Internal Server Error' and the cause is not logged`,
          {
            line: root.line,
            hint: "add app.onError((err, c) => ...) that logs the error and answers a generic body",
          },
        ),
      );
    }
    return out;
  },
};

const A003: Rule = {
  id: "A003",
  category: "architecture",
  severity: "info",
  title: "root app with no notFound",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const { root, served } of servedRoots(index)) {
      if (served.some((a) => a.notFoundHandler) || (files && !files.has(root.file))) continue;
      out.push(
        finding(
          A003,
          root.file,
          `'${root.local}' is served but never calls notFound: unknown paths answer the default plain-text '404 Not Found'`,
          { line: root.line, hint: "add app.notFound((c) => c.json({ error: 'Not found' }, 404))" },
        ),
      );
    }
    return out;
  },
};

/** Strongly connected components (Tarjan); recursion depth is bounded by the longest import chain. */
function components(adj: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!adj.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp);
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) visit(v);
  return out;
}

/** Shortest import path from `start` back to itself, inside one component. */
function cycleFrom(start: string, adj: Map<string, string[]>, members: Set<string>): string[] {
  const prev = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    for (const w of adj.get(v) ?? []) {
      if (!members.has(w)) continue;
      if (w === start) {
        const path = [v];
        while (path[0] !== start) path.unshift(prev.get(path[0]) as string);
        return [...path, start];
      }
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start];
}

const A004: Rule = {
  id: "A004",
  category: "architecture",
  severity: "warning",
  slow: true,
  title: "import cycle between route modules",
  run({ index, files }) {
    const routeFiles = new Set([
      ...index.apps.map((a) => a.file),
      ...index.routes.filter((r) => r.kind === "route").map((r) => r.file),
    ]);
    const adj = new Map<string, string[]>();
    for (const [file, edges] of index.graph.importsOf) {
      if (index.facts.get(file)?.isTest) continue;
      adj.set(
        file,
        edges.filter((e) => !e.typeOnly && !e.dynamic).map((e) => e.target),
      );
    }
    const out: Finding[] = [];
    for (const comp of components(adj)) {
      const routeMods = comp.filter((f) => routeFiles.has(f)).sort();
      if (comp.length < 2 || routeMods.length < 2) continue;
      const anchor = routeMods[0];
      if (files && !files.has(anchor)) continue;
      const cycle = cycleFrom(anchor, adj, new Set(comp));
      const edge = index.graph.importsOf.get(anchor)?.find((e) => e.target === cycle[1]);
      out.push(
        finding(
          A004,
          anchor,
          `route modules import each other in a cycle (${cycle.join(" -> ")}): one of them runs before the other is defined, so a sub-app can be undefined when route() mounts it`,
          {
            line: edge?.line ?? null,
            hint: `break the cycle: move the shared piece out, or import it from where it is defined (${where(anchor, edge?.line ?? 1)})`,
          },
        ),
      );
    }
    return out;
  },
};

export const architectureRules: Rule[] = [A001, A002, A003, A004];
