/** C001-C004: runtime fit, one Hono copy, deprecated APIs, and tests that reach the routes. */
import { join } from "node:path";
import { parseJsonc } from "../core/config.ts";
import { readText } from "../core/fs.ts";
import type { ProjectIndex } from "../core/index.ts";
import type { EnvRead, Finding } from "../core/types.ts";
import {
  finding,
  hostOps,
  importedFrom,
  inScope,
  liveRoutes,
  type Rule,
  routeLabel,
} from "./rule.ts";

/** `compatibility_date` from which Workers enable `nodejs_compat` by default (skills/hono-deploy). */
const NODEJS_COMPAT_DEFAULT_FROM = "2026-08-04";

/** Does the Workers project make `process.env` available (flag, or a date that implies it)? */
async function workersHaveProcessEnv(index: ProjectIndex): Promise<boolean> {
  const rel = index.detection.configFiles.wrangler;
  const text = rel ? await readText(join(index.workspace, rel)) : null;
  if (text === null) return false;
  let flags: string[] = [];
  let date = "";
  if (rel?.endsWith(".toml")) {
    flags = [
      ...(text.match(/compatibility_flags\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    date = text.match(/compatibility_date\s*=\s*"([^"]+)"/)?.[1] ?? "";
  } else {
    const cfg = parseJsonc(text);
    if (Array.isArray(cfg?.compatibility_flags))
      flags = cfg.compatibility_flags.filter((f): f is string => typeof f === "string");
    if (typeof cfg?.compatibility_date === "string") date = cfg.compatibility_date;
  }
  if (flags.includes("no_nodejs_compat")) return false;
  return (
    flags.includes("nodejs_compat") ||
    flags.includes("nodejs_compat_v2") ||
    (date !== "" && date >= NODEJS_COMPAT_DEFAULT_FROM)
  );
}

const C001: Rule = {
  id: "C001",
  category: "conventions",
  severity: "error",
  title: "runtime API that does not match the runtime",
  async run({ index, files }) {
    const { runtime, runtimes } = index.detection;
    if (runtimes.length > 1) return []; // a mixed project: no single runtime to hold the code to
    const wrong = new Map<EnvRead["api"], string>();
    if (runtime === "node") {
      wrong.set(
        "Deno.env.get",
        "Deno.env does not exist on Node: use process.env, validated once at startup",
      );
      wrong.set(
        "c.env",
        "c.env is empty on Node (the node server only exposes incoming and outgoing): read process.env",
      );
    } else if (runtime === "cloudflare-workers" && !(await workersHaveProcessEnv(index))) {
      wrong.set(
        "process.env",
        "process.env is empty on Workers without nodejs_compat (or a compatibility_date from 2026-08-04): read bindings from c.env",
      );
    }
    if (wrong.size === 0) return [];
    const groups = new Map<
      string,
      { file: string; line: number; api: EnvRead["api"]; reads: number }
    >();
    for (const r of index.envReads) {
      if (!wrong.has(r.api) || (files && !files.has(r.file))) continue;
      if (r.api === "c.env" && (r.key === "incoming" || r.key === "outgoing")) continue;
      const id = `${r.file}|${r.api}`;
      const g = groups.get(id);
      if (g) g.reads += 1;
      else groups.set(id, { file: r.file, line: r.line, api: r.api, reads: 1 });
    }
    const out: Finding[] = [];
    for (const g of groups.values()) {
      out.push(
        finding(
          C001,
          g.file,
          `${g.api} is read ${g.reads} time${g.reads === 1 ? "" : "s"} here but the project runs on ${runtime}: ${wrong.get(g.api)}`,
          { line: g.line, hint: "env(c) from hono/adapter reads the right place on every runtime" },
        ),
      );
    }
    return out;
  },
};

const isJsrSpecifier = (s: string) => /^jsr:|^@hono\/hono(?:\/|@|$)/.test(s);

const C002: Rule = {
  id: "C002",
  category: "conventions",
  severity: "error",
  title: "two Hono copies (npm:hono and jsr:@hono/hono)",
  run({ index, files }) {
    const specs = index.detection.honoSpecifiers;
    const jsr = specs.filter(isJsrSpecifier);
    const npm = specs.filter((s) => !isJsrSpecifier(s));
    if (jsr.length === 0 || npm.length === 0) return [];
    let at: { file: string; line: number | null } | null = null;
    for (const mod of index.facts.values()) {
      if (mod.isTest) continue;
      const imp = mod.imports.find((i) => isJsrSpecifier(i.specifier));
      if (imp) {
        at = { file: mod.path, line: imp.line };
        break;
      }
    }
    const cfg = index.detection.configFiles;
    at ??= { file: cfg.denoJson ?? cfg.packageJson ?? "package.json", line: null };
    if (files && !files.has(at.file)) return [];
    return [
      finding(
        C002,
        at.file,
        `the project loads two copies of Hono (${[...npm, ...jsr].join(", ")}): classes from one fail instanceof checks against the other and their types do not unify`,
        { line: at.line, hint: "keep one source, the npm one, in every import map and import" },
      ),
    ];
  },
};

/**
 * Deprecated in hono 4.13.16, read from `@deprecated` in `dist/types/**` of the installed package.
 * Mirrored, with the replacements, in skills/_shared/references/rules.md.
 */
export const DEPRECATED_MODULES: Record<string, string> = {
  "hono/aws-lambda": "@hono/aws-lambda",
  "hono/bun": "@hono/bun",
  "hono/cloudflare-pages": "hono on Workers with static assets",
  "hono/cloudflare-workers": "@hono/cloudflare-workers",
  "hono/deno": "@hono/deno",
  "hono/lambda-edge": "@hono/lambda-edge",
  "hono/netlify": "@hono/netlify",
  "hono/service-worker": "@hono/service-worker",
  "hono/vercel": "@hono/vercel",
};
export const DEPRECATED_IMPORTS: { module: string; name: string; use: string }[] = [
  { module: "hono/utils/url", name: "getQueryStrings", use: "the URL API" },
  { module: "hono/utils/http-status", name: "UnOfficalStatusCode", use: "UnofficialStatusCode" },
  { module: "hono/ssg", name: "SSG_DISABLED_RESPONSE", use: "X_HONO_DISABLE_SSG_HEADER_KEY" },
];
export const DEPRECATED_OPTIONS: Record<
  string,
  { module: string | null; keys: Record<string, string> }
> = {
  bearerAuth: {
    module: "hono/bearer-auth",
    keys: {
      noAuthenticationHeaderMessage: "noAuthenticationHeader.message",
      invalidAuthenticationHeaderMessage: "invalidAuthenticationHeader.message",
      invalidTokenMessage: "invalidToken.message",
    },
  },
  serveStatic: { module: null, keys: { pathResolve: "nothing: the option is no longer used" } },
};
const DEPRECATED_USES = {
  "c.req.routePath": "routePath(c) from hono/route",
  "c.req.matchedRoutes": "matchedRoutes(c) from hono/route",
  "app.fire": "fire from hono/service-worker (itself deprecated: @hono/service-worker)",
} as const;

const C003: Rule = {
  id: "C003",
  category: "conventions",
  severity: "warning",
  title: "deprecated Hono API",
  run(ctx) {
    const { index } = ctx;
    const out: Finding[] = [];
    const add = (file: string, line: number, api: string, use: string) => {
      if (!inScope(ctx, file)) return;
      out.push(
        finding(C003, file, `${api} is deprecated in Hono 4.13 and goes away in v5`, {
          line,
          hint: `use ${use}`,
        }),
      );
    };
    for (const mod of index.facts.values()) {
      if (mod.isTest) continue;
      for (const imp of mod.imports) {
        const c = imp.canonical;
        if (!c || imp.reexport || imp.dynamic) continue;
        if (c in DEPRECATED_MODULES)
          add(mod.path, imp.line, `the '${c}' adapter`, DEPRECATED_MODULES[c]);
        for (const d of DEPRECATED_IMPORTS) {
          if (c === d.module && imp.names.some((n) => n.imported === d.name))
            add(mod.path, imp.line, `${d.name} from '${d.module}'`, d.use);
        }
      }
      for (const u of mod.deprecatedUses) add(mod.path, u.line, u.api, DEPRECATED_USES[u.api]);
    }
    for (const { mod, op } of hostOps(index)) {
      if (op.op !== "reg") continue;
      if (op.via === "mount")
        add(
          mod.path,
          op.line,
          "app.mount()",
          "app.all('/p/*', mount(handler)) with mount from hono/mount",
        );
      for (const a of op.args) {
        const spec = a.kind === "call" && a.name ? DEPRECATED_OPTIONS[a.name] : undefined;
        const opts = a.literals[0];
        if (!spec || typeof opts !== "object" || opts === null || Array.isArray(opts)) continue;
        if (spec.module && importedFrom(mod, a.root) !== spec.module) continue;
        for (const [key, use] of Object.entries(spec.keys))
          if (key in opts) add(mod.path, a.line, `the ${a.name}() option '${key}'`, use);
      }
    }
    return out;
  },
};

/** `/v1/contacts/:id` → `/v1/contacts`: the part of a path a test must spell out literally. */
function staticPrefix(fullPath: string): string {
  const keep: string[] = [];
  for (const seg of fullPath.split("/")) {
    if (/[:*]/.test(seg)) break;
    keep.push(seg);
  }
  return keep.join("/").replace(/\/+$/, "");
}

const C004: Rule = {
  id: "C004",
  category: "conventions",
  severity: "info",
  slow: true,
  title: "route module with no test referencing its paths",
  async run({ index, files }) {
    const byModule = new Map<string, { prefixes: Set<string>; line: number; example: string }>();
    for (const r of liveRoutes(index)) {
      if (r.pathNonLiteral) continue;
      const m = byModule.get(r.file) ?? {
        prefixes: new Set(),
        line: r.line,
        example: routeLabel(r),
      };
      const p = staticPrefix(r.fullPath);
      if (p.length > 1) m.prefixes.add(p);
      m.line = Math.min(m.line, r.line);
      byModule.set(r.file, m);
    }
    const tests = [...index.facts.values()].filter((m) => m.isTest);
    if (tests.length === 0 && byModule.size === 0) return [];
    const texts: string[] = [];
    for (const t of tests) {
      const abs = index.files.get(t.path)?.abs;
      const text = abs ? await readText(abs) : null;
      if (text !== null) texts.push(text);
    }
    const out: Finding[] = [];
    for (const [file, m] of byModule) {
      if (m.prefixes.size === 0 || (files && !files.has(file))) continue;
      const importedByTest = (index.graph.importedBy.get(file) ?? []).some(
        (by) => index.facts.get(by)?.isTest,
      );
      const named = texts.some((t) => [...m.prefixes].some((p) => t.includes(p)));
      if (importedByTest || named) continue;
      out.push(
        finding(
          C004,
          file,
          `no test imports this module or mentions its paths (${[...m.prefixes].slice(0, 3).join(", ")}${m.prefixes.size > 3 ? ", ..." : ""})`,
          {
            line: m.line,
            confidence: "inferred",
            hint: "add a test that requests the full path with app.request()",
          },
        ),
      );
    }
    return out;
  },
};

export const conventionRules: Rule[] = [C001, C002, C003, C004];
