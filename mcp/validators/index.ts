/** Validator runner and catalogue. */
import type { ProjectIndex } from "../core/index.ts";
import type { Category, Finding, Severity, ValidationResult } from "../core/types.ts";
import { architectureRules } from "./architecture.ts";
import { conventionRules } from "./conventions.ts";
import { middlewareRules } from "./middleware.ts";
import { routeRules } from "./routes.ts";
import type { Rule } from "./rule.ts";
import { rpcRules } from "./rpc.ts";
import { securityRules } from "./security.ts";
import { validationRules } from "./validation.ts";

export const RULES: Rule[] = [
  ...routeRules,
  ...middlewareRules,
  ...validationRules,
  ...securityRules,
  ...architectureRules,
  ...rpcRules,
  ...conventionRules,
];

export const CATEGORIES: Category[] = [
  "routes",
  "middleware",
  "validation",
  "security",
  "architecture",
  "rpc",
  "conventions",
];

export interface ValidateOptions {
  categories?: Category[];
  /** Workspace-relative POSIX paths; only findings located in these files are returned. */
  files?: string[];
  /** Skip the slow rules (A004, C004): the hook fast path. */
  fast?: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export async function validate(
  index: ProjectIndex,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const categories = opts.categories?.length ? opts.categories : CATEGORIES;
  const files = opts.files?.length ? new Set(opts.files.map(normalizePath)) : null;
  const found: Finding[] = [];
  const unverified: string[] = index.skipped.map((s) => `${s.file}: ${s.reason}`);
  const ctx = { index, files };
  for (const rule of RULES) {
    if (!categories.includes(rule.category)) continue;
    if (opts.fast && rule.slow) continue;
    try {
      found.push(...(await rule.run(ctx)));
    } catch (e) {
      unverified.push(`${rule.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // one finding per rule and site: a handler shared by many routes, or a sub-app mounted twice,
  // is reached through several table entries that all point at the same source line
  const seen = new Set<string>();
  const findings = found
    .filter((f) => files === null || files.has(f.file))
    .filter((f) => {
      const key = `${f.id}|${f.file}|${f.line ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const errors = count("error");
  return {
    ok: errors === 0,
    findings,
    summary: { errors, warnings: count("warning"), info: count("info"), unverified, categories },
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

export function catalogue(): {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  slow: boolean;
}[] {
  return RULES.map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    title: r.title,
    slow: r.slow === true,
  }));
}
