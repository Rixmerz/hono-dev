/** R001-R007: the route table as hono-base builds it. */
import type { Finding, RouteEntry } from "../core/types.ts";
import {
  finding,
  hostOps,
  inScope,
  isConditional,
  isRoute,
  localName,
  type Rule,
  routeLabel,
  tableRoutes,
  tablesOf,
  where,
} from "./rule.ts";

const isDynamic = (path: string) => /[:*]/.test(path);

const R001: Rule = {
  id: "R001",
  category: "routes",
  severity: "error",
  title: "same method and full path registered twice in one table",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const table of tablesOf(index)) {
      const first = new Map<string, RouteEntry>();
      for (const { route } of tableRoutes(table.entries)) {
        if (route.pathNonLiteral || isConditional(route)) continue;
        const key = `${route.method} ${route.fullPath}`;
        const earlier = first.get(key);
        if (!earlier) {
          first.set(key, route);
          continue;
        }
        if (files && !files.has(route.file)) continue;
        const sameSite = earlier.file === route.file && earlier.line === route.line;
        out.push(
          finding(
            R001,
            route.file,
            sameSite
              ? `${routeLabel(route)} is registered twice: the sub-app that defines it is mounted more than once at the same prefix`
              : `${routeLabel(route)} is already registered at ${where(earlier.file, earlier.line)}; the first registration answers and this one never runs`,
            {
              line: route.line,
              route: routeLabel(route),
              hint: "remove one registration, or give them different methods or paths",
            },
          ),
        );
      }
    }
    return out;
  },
};

const R002: Rule = {
  id: "R002",
  category: "routes",
  severity: "warning",
  title: "param or wildcard route registered before a static sibling it shadows",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const table of tablesOf(index)) {
      if (!table.live) continue;
      const shadows = new Map<RouteEntry, RouteEntry[]>();
      for (const { at, route } of tableRoutes(table.entries)) {
        if (route.pathNonLiteral || isConditional(route) || isDynamic(route.fullPath)) continue;
        for (const hit of table.matcher.match(
          route.method === "ALL" ? "GET" : route.method,
          route.fullPath,
        )) {
          if (hit.index >= at) break;
          const earlier = table.entries[hit.index];
          if (!isRoute(earlier) || earlier.kind !== "route") continue;
          if (earlier.fullPath === route.fullPath || !isDynamic(earlier.fullPath)) continue;
          if (isConditional(earlier) || earlier.pathNonLiteral) continue;
          if (!earlier.handler) continue;
          const list = shadows.get(earlier) ?? [];
          if (!list.some((r) => r.file === route.file && r.line === route.line)) list.push(route);
          shadows.set(earlier, list);
          break;
        }
      }
      for (const [earlier, list] of shadows) {
        if (files && !files.has(earlier.file)) continue;
        const shown = list
          .slice(0, 3)
          .map((r) => `${routeLabel(r)} (${where(r.file, r.line)})`)
          .join(", ");
        out.push(
          finding(
            R002,
            earlier.file,
            `${routeLabel(earlier)} is registered before ${shown}${list.length > 3 ? ` and ${list.length - 3} more` : ""} and answers those requests first`,
            {
              line: earlier.line,
              route: routeLabel(earlier),
              hint: "register the static route first, or constrain the param (for example :id{[0-9]+})",
            },
          ),
        );
      }
    }
    return out;
  },
};

const R003: Rule = {
  id: "R003",
  category: "routes",
  severity: "error",
  title: "route added to a sub-app after route() mounted it",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const e of index.composition.stranded) {
      if (files && !files.has(e.file)) continue;
      const what = isRoute(e) ? `route ${routeLabel(e)}` : "middleware";
      out.push(
        finding(
          R003,
          e.file,
          `${what} is added to '${localName(e.app)}' after route() mounted it: the parent copied the sub-app's table at that moment and never serves it`,
          {
            line: e.line,
            route: isRoute(e) ? routeLabel(e) : undefined,
            hint: "register it before the route() call that mounts the sub-app",
          },
        ),
      );
    }
    return out;
  },
};

const R004: Rule = {
  id: "R004",
  category: "routes",
  severity: "warning",
  title: "Hono instance with routes that is never mounted nor served",
  run({ index, files }) {
    const out: Finding[] = [];
    const unresolved = index.skipped.filter((s) =>
      s.reason.includes("is not a known Hono instance"),
    ).length;
    for (const table of tablesOf(index)) {
      if (table.live) continue;
      const routes = tableRoutes(table.entries).map((r) => r.route);
      if (routes.length === 0) continue;
      const app = index.apps.find((a) => a.id === table.root);
      if (!app || (files && !files.has(app.file))) continue;
      out.push(
        finding(
          R004,
          app.file,
          `'${app.local}' registers ${routes.length} route${routes.length === 1 ? "" : "s"} (${routeLabel(routes[0])}${routes.length > 1 ? ", ..." : ""}) but no route() mounts it and nothing serves it${unresolved > 0 ? `; ${unresolved} route() call${unresolved === 1 ? "" : "s"} elsewhere could not be resolved, one of them may mount it` : ""}`,
          {
            line: app.line,
            confidence: unresolved > 0 ? "inferred" : "extracted",
            hint: "mount it with route(), serve it, or delete it",
          },
        ),
      );
    }
    return out;
  },
};

const R005: Rule = {
  id: "R005",
  category: "routes",
  severity: "info",
  title: "route or mount path built from a variable or template",
  run(ctx) {
    const out: Finding[] = [];
    for (const { mod, op } of hostOps(ctx.index)) {
      if (!inScope(ctx, mod.path)) continue;
      let bad: string | undefined;
      let what: string;
      if (op.op === "route") {
        if (!op.prefix.literal) bad = op.prefix.value;
        what = "route() prefix";
      } else if (op.op === "reg" && op.via !== "use" && op.via !== "openapi") {
        bad = op.paths.find((p) => !p.literal)?.value;
        what = `${op.via}() path`;
      } else continue;
      if (bad === undefined) continue;
      out.push(
        finding(
          R005,
          mod.path,
          `${what} \`${bad}\` is not a string literal: the composed table, traces and the other route rules cannot see it`,
          { line: op.line, hint: "use a literal, or a same-file const string" },
        ),
      );
    }
    return out;
  },
};

const R006: Rule = {
  id: "R006",
  category: "routes",
  severity: "warning",
  title: "missing leading slash, double slash or trailing-slash duplicate",
  run(ctx) {
    const out: Finding[] = [];
    const flag = (file: string, line: number, what: string, path: string) => {
      const problem =
        !path.startsWith("/") && path !== "*" ? "has no leading slash" : "contains //";
      out.push(
        finding(R006, file, `${what} '${path}' ${problem}`, {
          line,
          hint: "write paths as '/segment/...'",
        }),
      );
    };
    const bad = (p: string) => p !== "" && p !== "*" && (!p.startsWith("/") || p.includes("//"));
    for (const { mod, op } of hostOps(ctx.index)) {
      if (!inScope(ctx, mod.path)) continue;
      if (op.op === "route" && op.prefix.literal && bad(op.prefix.value))
        flag(mod.path, op.line, "route() prefix", op.prefix.value);
      else if (op.op === "reg") {
        for (const p of op.paths)
          if (p.literal && bad(p.value)) flag(mod.path, op.line, `${op.via}() path`, p.value);
      }
    }
    for (const mod of ctx.index.facts.values()) {
      if (mod.isTest || !inScope(ctx, mod.path)) continue;
      for (const op of mod.ops) {
        const bp = op.op === "decl" ? op.instance.basePath : null;
        if (op.op === "decl" && bp?.literal && bad(bp.value))
          flag(mod.path, op.instance.line, "basePath()", bp.value);
      }
    }
    for (const table of tablesOf(ctx.index)) {
      const seen = new Map<string, RouteEntry>();
      for (const { route } of tableRoutes(table.entries)) {
        if (route.pathNonLiteral || isConditional(route) || route.fullPath === "/") continue;
        const key = `${route.method} ${route.fullPath.replace(/\/$/, "")}`;
        const earlier = seen.get(key);
        if (!earlier) {
          seen.set(key, route);
          continue;
        }
        if (earlier.fullPath === route.fullPath || !inScope(ctx, route.file)) continue;
        out.push(
          finding(
            R006,
            route.file,
            `${routeLabel(route)} duplicates ${routeLabel(earlier)} (${where(earlier.file, earlier.line)}) up to the trailing slash`,
            {
              line: route.line,
              route: routeLabel(route),
              hint: "keep one form and set `strict: false` if both URLs must work",
            },
          ),
        );
      }
    }
    return out;
  },
};

const R007: Rule = {
  id: "R007",
  category: "routes",
  severity: "info",
  title: "one sub-app mounted at two prefixes",
  run({ index, files }) {
    const out: Finding[] = [];
    const byChild = new Map<string, typeof index.mounts>();
    for (const m of index.mounts) {
      if (m.kind !== "route") continue;
      byChild.set(m.child, [...(byChild.get(m.child) ?? []), m]);
    }
    for (const [child, edges] of byChild) {
      const distinct = new Map(edges.map((e) => [`${e.parent}|${e.prefix}`, e]));
      if (distinct.size < 2) continue;
      const list = [...distinct.values()];
      const second = list[1];
      if (files && !files.has(second.file)) continue;
      out.push(
        finding(
          R007,
          second.file,
          `'${localName(child)}' is mounted ${list.length} times (${list.map((e) => `'${e.prefix}' at ${where(e.file, e.line)}`).join(", ")}): every route exists once per mount`,
          { line: second.line, hint: "fine for versioned aliases; otherwise mount it once" },
        ),
      );
    }
    return out;
  },
};

export const routeRules: Rule[] = [R001, R002, R003, R004, R005, R006, R007];
