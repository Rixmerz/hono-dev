/**
 * Import specifier resolution: relative paths with explicit extensions (and the `.js` → `.ts`
 * mapping), deno.json import maps (exact and prefix keys), package.json `imports` (`#alias`),
 * tsconfig `paths`. External specifiers are reduced to a canonical form so that npm:hono@4,
 * jsr:@hono/hono@^4, @hono/hono and hono all read as `hono` (subpaths kept: `hono/cors`).
 */
import type { Manifests } from "./config.ts";
import { asRecord, type JsonObject } from "./config.ts";
import { dirname, joinRel, SOURCE_EXTS } from "./fs.ts";

export type Resolved =
  | { kind: "local"; path: string; viaMap: boolean }
  | { kind: "external"; specifier: string; canonical: string }
  | { kind: "asset"; path: string }
  | { kind: "unresolved"; specifier: string; reason: string };

export interface ResolveContext {
  manifests: Manifests;
  /** Workspace-relative POSIX paths of every indexed source file. */
  files: ReadonlySet<string>;
}

const ASSET_EXT =
  /\.(?:json|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|txt|md|html|sql|yaml|yml|toml|wasm|graphql|gql|mdx)$/i;

export function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

function splitPackage(spec: string): { pkg: string; rest: string[] } {
  const segs = spec.split("/");
  const take = segs[0].startsWith("@") ? 2 : 1;
  const pkg = segs.slice(0, take).join("/");
  return { pkg, rest: segs.slice(take) };
}

function stripVersion(pkg: string): string {
  const at = pkg.lastIndexOf("@");
  return at > 0 ? pkg.slice(0, at) : pkg;
}

const PACKAGE_ALIASES: Record<string, string> = { "@hono/hono": "hono" };

/** `npm:hono@4/cors` → `hono/cors`, `jsr:@hono/hono@^4` → `hono`; non-package specifiers pass through. */
export function canonicalSpecifier(spec: string): string {
  if (spec.startsWith("node:") || isRelative(spec) || spec.startsWith("/")) return spec;
  const legacy = spec.match(
    /^https?:\/\/(?:deno\.land\/x|esm\.sh)\/hono@v?[^/]+(?:\/(?:middleware\/)?([\w-]+))?/,
  );
  if (legacy) {
    const sub = legacy[1];
    return sub && !["mod", "index", "deno"].includes(sub) ? `hono/${sub}` : "hono";
  }
  if (/^https?:\/\//.test(spec)) return spec;
  const bare = spec.replace(/^(?:npm|jsr):\/?/, "");
  const { pkg, rest } = splitPackage(bare);
  const name = PACKAGE_ALIASES[stripVersion(pkg)] ?? stripVersion(pkg);
  return rest.length ? `${name}/${rest.join("/")}` : name;
}

/** The package part of a canonical specifier (`hono/cors` → `hono`, `@hono/zod-validator` stays). */
export function packageOf(canonical: string): string {
  return splitPackage(canonical).pkg;
}

/** Does a canonical specifier belong to the Hono framework (core, subpaths and `@hono/*` helpers)? */
export function isHonoSpecifier(canonical: string): boolean {
  return canonical === "hono" || canonical.startsWith("hono/");
}

function applyImportMap(spec: string, map: Record<string, string>): string | null {
  if (spec in map) return map[spec];
  let best: string | null = null;
  for (const key of Object.keys(map)) {
    if (key.endsWith("/") && spec.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  if (best !== null) return map[best] + spec.slice(best.length);
  // Deno expands `"hono": "npm:hono@4"` to also cover `hono/cors`.
  for (const key of Object.keys(map)) {
    if (key.endsWith("/")) continue;
    const val = map[key];
    if (spec.startsWith(`${key}/`) && (val.startsWith("jsr:") || val.startsWith("npm:"))) {
      return val + spec.slice(key.length);
    }
  }
  return null;
}

function candidates(path: string): string[] {
  const out = [path];
  const swaps: [RegExp, string[]][] = [
    [/\.js$/, [".ts", ".tsx"]],
    [/\.jsx$/, [".tsx"]],
    [/\.mjs$/, [".mts"]],
    [/\.cjs$/, [".cts"]],
  ];
  for (const [re, exts] of swaps) {
    if (re.test(path)) for (const e of exts) out.push(path.replace(re, e));
  }
  for (const e of SOURCE_EXTS) out.push(`${path}${e}`);
  for (const e of SOURCE_EXTS) out.push(`${path}/index${e}`);
  return out;
}

function findFile(path: string, files: ReadonlySet<string>): string | null {
  for (const c of candidates(path)) if (files.has(c)) return c;
  return null;
}

function pickCondition(target: unknown): string | null {
  if (typeof target === "string") return target;
  const rec = asRecord(target);
  for (const cond of ["node", "import", "default", "require", "deno", "bun"]) {
    const v = pickCondition(rec[cond]);
    if (v) return v;
  }
  return null;
}

function matchPattern(pattern: string, spec: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === spec ? "" : null;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  if (spec.length >= head.length + tail.length && spec.startsWith(head) && spec.endsWith(tail)) {
    return spec.slice(head.length, spec.length - tail.length);
  }
  return null;
}

function resolveHashImport(
  spec: string,
  imports: JsonObject,
  files: ReadonlySet<string>,
): string | null {
  for (const [pattern, target] of Object.entries(imports)) {
    const captured = matchPattern(pattern, spec);
    if (captured === null) continue;
    const picked = pickCondition(target);
    if (!picked) continue;
    const path = joinRel("", picked.replace("*", captured));
    return findFile(path, files);
  }
  return null;
}

function resolveTsPaths(spec: string, m: Manifests, files: ReadonlySet<string>): string | null {
  if (!m.tsPaths) return null;
  for (const [pattern, targets] of Object.entries(m.tsPaths.paths)) {
    const captured = matchPattern(pattern, spec);
    if (captured === null) continue;
    for (const t of targets) {
      const found = findFile(joinRel(m.tsPaths.baseDir, t.replace("*", captured)), files);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve `spec` as imported from the workspace-relative `fromFile`. */
export function resolveSpecifier(spec: string, fromFile: string, ctx: ResolveContext): Resolved {
  const { manifests: m, files } = ctx;
  if (isRelative(spec)) {
    const path = joinRel(dirname(fromFile), spec);
    const found = findFile(path, files);
    if (found) return { kind: "local", path: found, viaMap: false };
    if (ASSET_EXT.test(path)) return { kind: "asset", path };
    return { kind: "unresolved", specifier: spec, reason: "file not found" };
  }
  if (spec.startsWith("file://")) {
    const found = findFile(spec.slice("file://".length).replace(/^\/+/, ""), files);
    return found
      ? { kind: "local", path: found, viaMap: false }
      : { kind: "unresolved", specifier: spec, reason: "file not found" };
  }
  if (spec.startsWith("node:")) return { kind: "external", specifier: spec, canonical: spec };
  if (spec.startsWith("npm:") || spec.startsWith("jsr:") || /^https?:\/\//.test(spec)) {
    return { kind: "external", specifier: spec, canonical: canonicalSpecifier(spec) };
  }
  if (spec.startsWith("#")) {
    const found = resolveHashImport(spec, m.pkgImports, files);
    return found
      ? { kind: "local", path: found, viaMap: true }
      : { kind: "unresolved", specifier: spec, reason: "no matching package.json imports entry" };
  }

  const mapped = applyImportMap(spec, m.denoImports);
  if (mapped !== null) {
    if (isRelative(mapped)) {
      const found = findFile(joinRel(m.denoDir, mapped), files);
      return found
        ? { kind: "local", path: found, viaMap: true }
        : { kind: "unresolved", specifier: spec, reason: `import map target ${mapped} not found` };
    }
    return { kind: "external", specifier: mapped, canonical: canonicalSpecifier(mapped) };
  }

  const viaPaths = resolveTsPaths(spec, m, files);
  if (viaPaths) return { kind: "local", path: viaPaths, viaMap: true };

  return { kind: "external", specifier: spec, canonical: canonicalSpecifier(spec) };
}
