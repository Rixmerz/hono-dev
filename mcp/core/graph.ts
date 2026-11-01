/** Import linking, the import graph, and DB-client module detection. */
import { packageOf, type ResolveContext, resolveSpecifier } from "./resolve.ts";
import type { HonoDevConfig, ImportGraph, ModuleFacts } from "./types.ts";

export const DEFAULT_DB_SPECIFIERS = [
  "@prisma/client",
  "drizzle-orm",
  "kysely",
  "pg",
  "postgres",
  "mysql2",
  "mongodb",
  "mongoose",
  "better-sqlite3",
  "@libsql/client",
  "@neondatabase/serverless",
  "typeorm",
  "sequelize",
];

/** Fill `resolved` (workspace-relative file) or `canonical` (external) on every import. */
export function linkImports(
  facts: Map<string, ModuleFacts>,
  ctx: ResolveContext,
): ImportGraph["unresolved"] {
  const unresolved: ImportGraph["unresolved"] = [];
  for (const mod of facts.values()) {
    for (const imp of mod.imports) {
      imp.resolved = null;
      imp.canonical = null;
      const r = resolveSpecifier(imp.specifier, mod.path, ctx);
      if (r.kind === "local") imp.resolved = r.path;
      else if (r.kind === "external") imp.canonical = r.canonical;
      else if (r.kind === "unresolved") {
        unresolved.push({
          file: mod.path,
          specifier: imp.specifier,
          line: imp.line,
          reason: r.reason,
        });
      }
    }
  }
  return unresolved;
}

export function buildImportGraph(
  facts: Map<string, ModuleFacts>,
  unresolved: ImportGraph["unresolved"],
): ImportGraph {
  const importsOf: ImportGraph["importsOf"] = new Map();
  const importedBy: ImportGraph["importedBy"] = new Map();
  const externalsOf: ImportGraph["externalsOf"] = new Map();
  for (const [file, mod] of facts) {
    const local: { target: string; line: number; dynamic: boolean; typeOnly: boolean }[] = [];
    const external: { specifier: string; canonical: string; line: number }[] = [];
    for (const imp of mod.imports) {
      if (imp.resolved && facts.has(imp.resolved)) {
        local.push({
          target: imp.resolved,
          line: imp.line,
          dynamic: imp.dynamic,
          typeOnly: imp.isTypeOnly,
        });
        const by = importedBy.get(imp.resolved) ?? [];
        if (!by.includes(file)) by.push(file);
        importedBy.set(imp.resolved, by);
      } else if (imp.canonical) {
        external.push({ specifier: imp.specifier, canonical: imp.canonical, line: imp.line });
      }
    }
    importsOf.set(file, local);
    externalsOf.set(file, external);
  }
  return { importsOf, importedBy, externalsOf, unresolved };
}

/** Does a canonical specifier (`drizzle-orm/node-postgres`) belong to a listed package? */
export function matchesSpecifier(canonical: string, list: readonly string[]): string | null {
  for (const entry of list) {
    if (
      canonical === entry ||
      canonical.startsWith(`${entry}/`) ||
      packageOf(canonical) === entry
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * Files that import a DB client (value imports only; type-only imports never open a connection).
 * `config.dbSpecifiers` may also list workspace-relative paths of local DB modules.
 */
export function computeDbModules(
  facts: Map<string, ModuleFacts>,
  config: HonoDevConfig,
): Set<string> {
  const list = [...DEFAULT_DB_SPECIFIERS, ...config.dbSpecifiers];
  const out = new Set<string>();
  for (const [file, mod] of facts) {
    if (mod.isTest) continue;
    if (
      config.dbSpecifiers.some((s) => file === s || file.startsWith(`${s.replace(/\/$/, "")}/`))
    ) {
      out.add(file);
      continue;
    }
    for (const imp of mod.imports) {
      if (imp.isTypeOnly || !imp.canonical || imp.reexport) continue;
      if (imp.names.length > 0 && imp.names.every((n) => n.isType)) continue;
      if (matchesSpecifier(imp.canonical, list)) {
        out.add(file);
        break;
      }
    }
  }
  return out;
}
