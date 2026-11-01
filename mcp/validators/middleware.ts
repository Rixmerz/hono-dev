/** M001-M007: where middleware sits in the table and what it does with `next()`. */
import { samplePaths } from "../core/match.ts";
import type { Finding, MiddlewareEntry, RouteEntry } from "../core/types.ts";
import {
  argText,
  type Rule,
  type RuleContext,
  entryById,
  finding,
  hostOps,
  inScope,
  isConditional,
  isRoute,
  isRouteHop,
  liveRoutes,
  routeLabel,
  tablesOf,
  where,
} from "./rule.ts";

const mwLabel = (m: MiddlewareEntry) => m.name ?? "an anonymous middleware";

/** M001 and M002 share a source: middleware the table places after routes its path covers. */
function lateMiddleware(rule: Rule, ctx: RuleContext, viaMount: boolean): Finding[] {
  const { index, files } = ctx;
  const out: Finding[] = [];
  for (const m of index.middlewares) {
    if (!m.reachable || m.registeredAfterRoutes.length === 0) continue;
    if (files && !files.has(m.file)) continue;
    const late: RouteEntry[] = [];
    let mountedChild: string | null = null;
    for (const id of m.registeredAfterRoutes) {
      const r = entryById(index, id);
      if (!r || !isRoute(r)) continue;
      const hop = r.mountChain.slice(m.mountChain.length).find((h) => isRouteHop(index, h));
      if (hop) mountedChild ??= hop.app.slice(hop.app.indexOf("#") + 1);
      if (!!hop === viaMount) late.push(r);
    }
    if (late.length === 0) continue;
    const shown = late.slice(0, 3).map(routeLabel).join(", ");
    const more = late.length > 3 ? ` and ${late.length - 3} more` : "";
    out.push(
      finding(
        rule,
        m.file,
        viaMount
          ? `use('${m.localPath}') ${mwLabel(m)} comes after the route() mount of '${mountedChild}': the routes copied in from it (${shown}${more}) never run through it`
          : `use('${m.localPath}') ${mwLabel(m)} is registered after routes it targets (${shown}${more}): they are matched first and never run through it`,
        {
          line: m.line,
          hint: viaMount
            ? "write the use() call before the route() call it should cover"
            : "move the use() call above the routes it should cover; if the order is deliberate, say so in a comment",
        },
      ),
    );
  }
  return out;
}

const M001: Rule = {
  id: "M001",
  category: "middleware",
  severity: "warning",
  title: "use() after the routes it targets on the same instance",
  run: (ctx) => lateMiddleware(M001, ctx, false),
};

const M002: Rule = {
  id: "M002",
  category: "middleware",
  severity: "warning",
  title: "parent use() after the route() mount it would cover",
  run: (ctx) => lateMiddleware(M002, ctx, true),
};

/** Middleware whose job is to answer requests for a path that has no route of its own. */
const SERVES_FILES = new Set(["serveStatic"]);

const M003: Rule = {
  id: "M003",
  category: "middleware",
  severity: "warning",
  title: "scoped use('/x/*') whose path matches no route",
  run({ index, files }) {
    const verdict = new Map<string, { m: MiddlewareEntry; covered: boolean }>();
    for (const table of tablesOf(index)) {
      if (!table.live) continue;
      const covered = new Set<number>();
      table.entries.forEach((e, at) => {
        if (!isRoute(e) || e.pathNonLiteral || isConditional(e)) return;
        const method = e.method === "ALL" ? "GET" : e.method;
        for (const sample of samplePaths(e.fullPath)) {
          const hits = table.matcher.match(method, sample);
          if (!hits.some((h) => h.index === at)) continue;
          for (const h of hits) covered.add(h.index);
          break;
        }
      });
      table.entries.forEach((e, at) => {
        if (isRoute(e) || e.pathNonLiteral || isConditional(e)) return;
        if (e.localPath === "*" || e.localPath === "/*") return;
        if (e.name && SERVES_FILES.has(e.name)) return;
        const key = `${e.file}:${e.line}:${e.name}`;
        const v = verdict.get(key) ?? { m: e, covered: false };
        v.covered ||= covered.has(at);
        verdict.set(key, v);
      });
    }
    const out: Finding[] = [];
    for (const { m, covered } of verdict.values()) {
      if (covered || (files && !files.has(m.file))) continue;
      out.push(
        finding(
          M003,
          m.file,
          `use('${m.localPath}') ${mwLabel(m)} matches no route: nothing under ${m.fullPath} is registered`,
          {
            line: m.line,
            confidence: "inferred",
            hint: "fix the path, or delete the middleware if the routes moved",
          },
        ),
      );
    }
    return out;
  },
};

interface NextSite {
  file: string;
  line: number;
  declaresNext: boolean;
  callsNext: boolean;
  passesNext: boolean;
  awaitsOrReturnsNext: boolean;
}

/** Every middleware function the project registers: `use()` entries plus inline route middleware. */
function nextSites(ctx: RuleContext): NextSite[] {
  const { index } = ctx;
  const out: NextSite[] = [];
  for (const m of index.middlewares) {
    if (!m.fn) continue;
    out.push({
      file: m.fn.file ?? m.file,
      line: m.fn.line,
      declaresNext: m.fn.declaresNext === true,
      callsNext: m.fn.callsNext,
      passesNext: m.fn.passesNext === true,
      awaitsOrReturnsNext: m.fn.awaitsOrReturnsNext,
    });
  }
  for (const { mod, op } of hostOps(index)) {
    if (op.op !== "reg" || op.via === "use" || op.via === "mount") continue;
    for (const a of op.args.slice(0, -1)) {
      if (a.kind !== "function" || !a.fn || a.fn.nextParam === null) continue;
      out.push({
        file: mod.path,
        line: a.fn.line,
        declaresNext: true,
        callsNext: a.fn.callsNext,
        passesNext: a.fn.nextPassed,
        awaitsOrReturnsNext: a.fn.awaitsOrReturnsNext,
      });
    }
  }
  return out;
}

const M004: Rule = {
  id: "M004",
  category: "middleware",
  severity: "warning",
  title: "inline middleware that never calls next()",
  run(ctx) {
    return nextSites(ctx)
      .filter((s) => s.declaresNext && !s.callsNext && !s.passesNext && inScope(ctx, s.file))
      .map((s) =>
        finding(
          M004,
          s.file,
          "this middleware takes next but never calls or forwards it: nothing registered after it runs, and without a returned Response Hono answers 500 'Context is not finalized'",
          { line: s.line, hint: "await next(), or return a Response on every path" },
        ),
      );
  },
};

const M005: Rule = {
  id: "M005",
  category: "middleware",
  severity: "warning",
  title: "next() without await or return",
  run(ctx) {
    return nextSites(ctx)
      .filter((s) => s.callsNext && !s.awaitsOrReturnsNext && inScope(ctx, s.file))
      .map((s) =>
        finding(
          M005,
          s.file,
          "next() is called without await or return: code after it runs before the handler finishes, and the response it produces is not seen",
          { line: s.line, hint: "write `await next()` or `return next()`" },
        ),
      );
  },
};

const M006: Rule = {
  id: "M006",
  category: "middleware",
  severity: "warning",
  title: "same middleware twice in one route's chain",
  run({ index, files }) {
    const sites = new Map<
      string,
      { file: string; line: number; name: string; first: string; routes: RouteEntry[] }
    >();
    for (const r of liveRoutes(index)) {
      const seen = new Map<string, { file: string; line: number }>();
      for (const step of r.chain) {
        if (!step.name) continue;
        const mw = step.middlewareId ? entryById(index, step.middlewareId) : undefined;
        const source = mw && !isRoute(mw) ? mw.source : null;
        const key = `${step.name}|${source ?? ""}|${argText(index, step.file, step.line, step.name)}`;
        const first = seen.get(key);
        if (!first) {
          seen.set(key, { file: step.file, line: step.line });
          continue;
        }
        if (first.file === step.file && first.line === step.line) continue;
        const siteKey = `${step.file}:${step.line}`;
        const site = sites.get(siteKey) ?? {
          file: step.file,
          line: step.line,
          name: step.name,
          first: where(first.file, first.line),
          routes: [],
        };
        site.routes.push(r);
        sites.set(siteKey, site);
      }
    }
    const out: Finding[] = [];
    for (const s of sites.values()) {
      if (files && !files.has(s.file)) continue;
      out.push(
        finding(
          M006,
          s.file,
          `${s.name} is already in the chain from ${s.first}: it runs twice on ${routeLabel(s.routes[0])}${s.routes.length > 1 ? ` and ${s.routes.length - 1} more route${s.routes.length > 2 ? "s" : ""}` : ""}`,
          {
            line: s.line,
            route: routeLabel(s.routes[0]),
            hint: "register it once, on the narrowest instance that covers every route",
          },
        ),
      );
    }
    return out;
  },
};

const isCorsName = (name: string | null, source: string | null) =>
  source === "hono/cors" || (name !== null && /^cors$|cors/i.test(name));

const M007: Rule = {
  id: "M007",
  category: "middleware",
  severity: "error",
  title: "cors() after an auth middleware over the same paths",
  run({ index, files }) {
    const sites = new Map<
      string,
      { file: string; line: number; auth: string; routes: RouteEntry[] }
    >();
    for (const r of liveRoutes(index)) {
      const authAt = r.chain.findIndex((s) => s.isAuth);
      if (authAt < 0) continue;
      for (const step of r.chain.slice(authAt + 1)) {
        const mw = step.middlewareId ? entryById(index, step.middlewareId) : undefined;
        const source = mw && !isRoute(mw) ? mw.source : null;
        if (!isCorsName(step.name, source)) continue;
        const key = `${step.file}:${step.line}`;
        const site = sites.get(key) ?? {
          file: step.file,
          line: step.line,
          auth: r.chain[authAt].name ?? "an auth middleware",
          routes: [],
        };
        site.routes.push(r);
        sites.set(key, site);
      }
    }
    const out: Finding[] = [];
    for (const s of sites.values()) {
      if (files && !files.has(s.file)) continue;
      out.push(
        finding(
          M007,
          s.file,
          `cors() runs after ${s.auth} on ${routeLabel(s.routes[0])}${s.routes.length > 1 ? ` and ${s.routes.length - 1} more` : ""}: a browser preflight (OPTIONS) carries no credentials, auth answers it 401 and the browser reports a CORS failure`,
          {
            line: s.line,
            route: routeLabel(s.routes[0]),
            confidence: "inferred",
            hint: "register cors() before the auth middleware",
          },
        ),
      );
    }
    return out;
  },
};

export const middlewareRules: Rule[] = [M001, M002, M003, M004, M005, M006, M007];
