/** S001-S007: CORS, auth coverage, secrets, error bodies, CSRF and body size. */
import type { Finding, LiteralValue, MiddlewareEntry, RouteEntry } from "../core/types.ts";
import {
  entryById,
  finding,
  hostOps,
  importedFrom,
  inScope,
  isRoute,
  isRouteHop,
  liveRoutes,
  localName,
  type Rule,
  routeLabel,
  where,
} from "./rule.ts";

type Options = { [k: string]: LiteralValue };

const asOptions = (v: LiteralValue | null): Options | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !("$expr" in v)
    ? (v as Options)
    : null;

const exprOf = (v: LiteralValue | undefined): string | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) && "$expr" in v
    ? String((v as { $expr: string }).$expr)
    : null;

/** `(origin) => origin` and `function (o) { return o }`: the request's Origin echoed back. */
const REFLECTS =
  /^(?:async\s*)?(?:\(\s*(\w+)\s*(?::[^),]*)?(?:,[^)]*)?\)|(\w+))\s*=>\s*(?:\{\s*return\s+(\w+)\s*;?\s*\}|(\w+))\s*$|^(?:async\s*)?function\s*\w*\s*\(\s*(\w+)[^)]*\)\s*\{\s*return\s+(\w+)\s*;?\s*\}$/;

function reflectsOrigin(expr: string): boolean {
  const m = REFLECTS.exec(expr.trim());
  if (!m) return false;
  const param = m[1] ?? m[2] ?? m[5];
  const ret = m[3] ?? m[4] ?? m[6];
  return param !== undefined && param === ret;
}

const isCors = (m: MiddlewareEntry) => m.source === "hono/cors" || m.name === "cors";

const S001: Rule = {
  id: "S001",
  category: "security",
  severity: "error",
  title: "cors origin '*' or reflected with credentials: true",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const m of index.middlewares) {
      if (!isCors(m) || (files && !files.has(m.file))) continue;
      const opts = asOptions(m.options);
      if (opts?.credentials !== true) continue;
      const origin = opts.origin;
      const wildcard =
        origin === undefined || origin === "*" || (Array.isArray(origin) && origin.includes("*"));
      const expr = exprOf(origin);
      const reflected = expr !== null && reflectsOrigin(expr);
      if (!wildcard && !reflected) continue;
      out.push(
        finding(
          S001,
          m.file,
          wildcard
            ? `cors() allows origin '*'${origin === undefined ? " (the default)" : ""} together with credentials: true: browsers refuse that pairing, and any workaround that echoes the Origin opens every site`
            : "cors() reflects the request Origin together with credentials: true: every website can make credentialed calls to this API",
          { line: m.line, hint: "list the allowed origins explicitly and deny by default" },
        ),
      );
    }
    return out;
  },
};

const guarded = (r: RouteEntry) => r.chain.some((s) => s.isAuth);

const S002: Rule = {
  id: "S002",
  category: "security",
  severity: "warning",
  title: "route public on a mount where most routes are guarded",
  run({ index, files }) {
    const routes = liveRoutes(index).filter((r) => r.method !== "OPTIONS");
    const why = new Map<RouteEntry, string>();

    // M001/M002 already report a guard written after the route it should cover on the way down the tree
    const lateOnItsOwn = (r: RouteEntry) =>
      r.unreached.some((s) => {
        const mw = s.isAuth && s.middlewareId ? entryById(index, s.middlewareId) : undefined;
        return !!mw && !isRoute(mw) && mw.registeredAfterRoutes.includes(r.id);
      });

    // a scoped auth middleware that sits after this route in the table: the path says "guarded",
    // the table order says "not". The OAuth-callback mount order is the known, deliberate case
    for (const r of routes) {
      if (guarded(r) || lateOnItsOwn(r)) continue;
      const hole = r.unreached.find((s) => s.isAuth && s.scope === "mount");
      if (!hole) continue;
      why.set(
        r,
        `${routeLabel(r)} has no auth in its chain: ${hole.name ?? "the auth middleware"} (${where(hole.file, hole.line)}) covers this path but sits after the route in the table, so it is never reached`,
      );
    }

    // a sub-app in which most routes are guarded and a few are not
    const bySubApp = new Map<string, RouteEntry[]>();
    for (const r of routes) {
      const hop = [...r.mountChain].reverse().find((h) => isRouteHop(index, h));
      if (!hop) continue;
      const key = `${hop.app}|${hop.file}|${hop.line}`;
      bySubApp.set(key, [...(bySubApp.get(key) ?? []), r]);
    }
    for (const list of bySubApp.values()) {
      const g = list.filter(guarded).length;
      if (list.length < 3 || g * 2 <= list.length) continue;
      const sub = localName(list[0].mountChain.at(-1)?.app ?? list[0].app);
      for (const r of list) {
        if (!guarded(r) && !why.has(r) && !lateOnItsOwn(r)) {
          why.set(
            r,
            `${routeLabel(r)} has no auth in its chain, while ${g} of ${list.length} routes in '${sub}' are guarded`,
          );
        }
      }
    }

    const out: Finding[] = [];
    for (const [r, message] of why) {
      if (files && !files.has(r.file)) continue;
      out.push(
        finding(S002, r.file, message, {
          line: r.line,
          route: routeLabel(r),
          confidence: "inferred",
          hint: "if the route must be public (an OAuth callback, a webhook), keep it and say why in a comment; otherwise guard it",
        }),
      );
    }
    return out;
  },
};

/** Segments that make a variable name look like a secret: JWT_SECRET, STRIPE_API_KEY, DB_PASSWORD. */
const SECRET_NAME =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIALS?|APIKEY|KEY)(?:_|$)|DATABASE_URL|CONNECTION_STRING|(?:^|_)DSN(?:_|$)/;
const NOT_A_SECRET =
  /(?:^|_)(?:TTL|EXPIRES?|EXPIRY|EXPIRATION|HEADER|LENGTH|SIZE|PREFIX|ISSUER|AUDIENCE|PUBLIC)(?:_|$)/;

function looksSecret(key: string): boolean {
  const name = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return SECRET_NAME.test(name) && !NOT_A_SECRET.test(name);
}

const S003: Rule = {
  id: "S003",
  category: "security",
  severity: "warning",
  title: "secret-looking env key read without validation",
  run({ index, files }) {
    // a key named by any validation (schema or hand-written boot guard) is checked before it is used
    const checked = new Set<string>();
    for (const v of index.envValidation)
      if (Array.isArray(v.keys)) for (const k of v.keys) checked.add(k);
    const first = new Map<string, { file: string; line: number; key: string; reads: number }>();
    for (const r of index.envReads) {
      if (!r.key || r.validated || checked.has(r.key) || !looksSecret(r.key)) continue;
      const id = `${r.file}|${r.key}`;
      const seen = first.get(id);
      if (seen) seen.reads += 1;
      else first.set(id, { file: r.file, line: r.line, key: r.key, reads: 1 });
    }
    const byLine = new Map<string, { file: string; line: number; keys: string[]; reads: number }>();
    for (const f of first.values()) {
      const id = `${f.file}:${f.line}`;
      const b = byLine.get(id) ?? { file: f.file, line: f.line, keys: [], reads: 0 };
      b.keys.push(f.key);
      b.reads += f.reads;
      byLine.set(id, b);
    }
    const out: Finding[] = [];
    for (const b of byLine.values()) {
      if (files && !files.has(b.file)) continue;
      out.push(
        finding(
          S003,
          b.file,
          `${b.keys.join(", ")} ${b.keys.length > 1 ? "are" : "is"} read straight from the environment and never checked${b.reads > b.keys.length ? ` (${b.reads} reads in this file)` : ""}: a missing or placeholder secret boots silently`,
          {
            line: b.line,
            hint: "parse the environment once at startup with a schema, or throw when the key is missing",
          },
        ),
      );
    }
    return out;
  },
};

const SECRET_OPTION: Record<string, { module: string; option: string }> = {
  jwt: { module: "hono/jwt", option: "secret" },
  bearerAuth: { module: "hono/bearer-auth", option: "token" },
  basicAuth: { module: "hono/basic-auth", option: "password" },
};

const S004: Rule = {
  id: "S004",
  category: "security",
  severity: "error",
  title: "literal secret in jwt/bearerAuth/basicAuth options",
  run(ctx) {
    const out: Finding[] = [];
    for (const { mod, op } of hostOps(ctx.index)) {
      if (op.op !== "reg" || !inScope(ctx, mod.path)) continue;
      for (const a of op.args) {
        const spec = a.kind === "call" && a.name ? SECRET_OPTION[a.name] : undefined;
        if (!spec || importedFrom(mod, a.root) !== spec.module) continue;
        const value = asOptions(a.literals[0] ?? null)?.[spec.option];
        const literal =
          (typeof value === "string" && value !== "") ||
          (Array.isArray(value) && value.some((v) => typeof v === "string" && v !== ""));
        if (!literal) continue;
        out.push(
          finding(
            S004,
            mod.path,
            `${a.name}() is given a literal ${spec.option}: it lives in git and in every build, and anyone who reads the repository can sign in`,
            {
              line: a.line,
              hint: "read it from the environment (c.env on Workers) and validate it at startup",
            },
          ),
        );
      }
    }
    return out;
  },
};

const S005: Rule = {
  id: "S005",
  category: "security",
  severity: "warning",
  title: "onError answering with err.message, err.stack or the raw error",
  run(ctx) {
    const out: Finding[] = [];
    for (const { mod, op } of hostOps(ctx.index)) {
      if (op.op !== "error" || !op.handler || !inScope(ctx, mod.path)) continue;
      const h = op.handler;
      const fn =
        h.kind === "function"
          ? h.fn
          : h.kind === "identifier" && h.root === h.name && h.name
            ? ctx.index.composition.resolveFn(mod.path, h.name)
            : null;
      if (!fn?.leaksError) continue;
      out.push(
        finding(
          S005,
          mod.path,
          "onError puts err.message, err.stack or the raw error in the response: internal details (SQL, paths, upstream bodies) reach the client",
          {
            line: h.line,
            hint: "log the error, answer with a generic body, and let HTTPException carry its own response",
          },
        ),
      );
    }
    return out;
  },
};

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isCsrf = (name: string | null, source: string | null) =>
  source === "hono/csrf" || (name !== null && /csrf|xsrf/i.test(name));

function usesCookies(index: Parameters<Rule["run"]>[0]["index"], m: MiddlewareEntry): boolean {
  if (/session|cookie/i.test(`${m.name ?? ""} ${m.source ?? ""}`)) return true;
  if (asOptions(m.options)?.cookie) return true;
  const file = m.source?.startsWith("./") ? m.source.slice(2) : null;
  return !!file && !!index.facts.get(file)?.imports.some((i) => i.canonical === "hono/cookie");
}

const S006: Rule = {
  id: "S006",
  category: "security",
  severity: "warning",
  title: "cookie/session auth with state-changing routes and no csrf()",
  run({ index, files }) {
    const cookieAuth = new Map<string, MiddlewareEntry>();
    for (const m of index.middlewares) {
      if (m.isAuth && usesCookies(index, m)) cookieAuth.set(m.id, m);
    }
    if (cookieAuth.size === 0) return [];
    const sites = new Map<string, { m: MiddlewareEntry; routes: RouteEntry[] }>();
    for (const r of liveRoutes(index)) {
      if (!STATE_CHANGING.has(r.method)) continue;
      const step = r.chain.find((s) => s.middlewareId && cookieAuth.has(s.middlewareId));
      if (!step) continue;
      const hasCsrf = r.chain.some((s) => {
        const e = s.middlewareId ? entryById(index, s.middlewareId) : undefined;
        return isCsrf(s.name, e && !isRoute(e) ? e.source : null);
      });
      if (hasCsrf) continue;
      const m = cookieAuth.get(step.middlewareId as string) as MiddlewareEntry;
      const key = `${m.file}:${m.line}`;
      const site = sites.get(key) ?? { m, routes: [] };
      site.routes.push(r);
      sites.set(key, site);
    }
    const out: Finding[] = [];
    for (const { m, routes } of sites.values()) {
      if (files && !files.has(m.file)) continue;
      out.push(
        finding(
          S006,
          m.file,
          `${m.name ?? "this middleware"} authenticates with a cookie or session and guards ${routes.length} state-changing route${routes.length === 1 ? "" : "s"} (${routeLabel(routes[0])}${routes.length > 1 ? ", ..." : ""}) with no csrf() in their chain`,
          {
            line: m.line,
            confidence: "inferred",
            hint: "add csrf() from hono/csrf before the routes, or use SameSite=Strict cookies and say so in a comment",
          },
        ),
      );
    }
    return out;
  },
};

const S007: Rule = {
  id: "S007",
  category: "security",
  severity: "info",
  title: "formData/parseBody read with no bodyLimit()",
  run(ctx) {
    const out: Finding[] = [];
    for (const r of liveRoutes(ctx.index)) {
      const read = r.handler?.bodyReads.find((b) => b.api === "formData" || b.api === "parseBody");
      if (!r.handler || !read || !inScope(ctx, r.handler.file)) continue;
      const limited = r.chain.some((s) => {
        const e = s.middlewareId ? entryById(ctx.index, s.middlewareId) : undefined;
        return s.name === "bodyLimit" || (e && !isRoute(e) && e.source === "hono/body-limit");
      });
      if (limited) continue;
      out.push(
        finding(
          S007,
          r.handler.file,
          `${routeLabel(r)} reads c.req.${read.api}() with no bodyLimit() in its chain: a client can stream an unbounded upload into memory`,
          {
            line: read.line,
            route: routeLabel(r),
            hint: "add bodyLimit({ maxSize }) from hono/body-limit before the handler",
          },
        ),
      );
    }
    return out;
  },
};

export const securityRules: Rule[] = [S001, S002, S003, S004, S005, S006, S007];
