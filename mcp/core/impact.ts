/** `computeImpact`: which routes, middlewares and rpc types a set of changed files reaches. */
import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import type { ProjectIndex } from "./index.ts";
import type { ImpactResult } from "./types.ts";

const run = promisify(execFile);

function normalize(idx: ProjectIndex, f: string): string {
  const rel = isAbsolute(f) ? relative(idx.workspace, f) : f;
  return rel.replace(/^\.\//, "");
}

export function computeImpact(idx: ProjectIndex, filesIn: string[], depth = 3): ImpactResult {
  const files = [...new Set(filesIn.map((f) => normalize(idx, f)))];
  const affected = new Map<string, { distance: number; via: string | null }>();
  for (const f of files) {
    affected.set(f, { distance: 0, via: null });
    for (const [importer, chain] of idx.importersOf(f, depth)) {
      const prev = affected.get(importer);
      if (!prev || prev.distance > chain.length - 1) {
        affected.set(importer, { distance: chain.length - 1, via: chain[chain.length - 2] });
      }
    }
  }
  const reason = (file: string, what: string): string | null => {
    const a = affected.get(file);
    if (!a) return null;
    return a.distance === 0
      ? `${what} ${file} changed`
      : `${what} ${file} imports ${a.via} (distance ${a.distance})`;
  };
  const sourceFile = (source: string | null) => (source?.startsWith("./") ? source.slice(2) : null);

  const mwById = new Map(idx.middlewares.map((m) => [m.id, m]));
  const mwWhy = new Map<string, string[]>();
  for (const m of idx.middlewares) {
    // a named middleware is only touched when its registration or implementation file is; an inline
    // one lives in the registration file, so any importer of the changed code may run different code
    const registeredAffected =
      m.kind === "inline"
        ? reason(m.file, "registered in")
        : affected.get(m.file)?.distance === 0
          ? reason(m.file, "registered in")
          : null;
    const why = [registeredAffected, reason(sourceFile(m.source) ?? "", "implemented in")].filter(
      (x): x is string => x !== null,
    );
    if (why.length) mwWhy.set(m.id, [...new Set(why)]);
  }

  const routes: ImpactResult["routes"] = [];
  for (const r of idx.routes) {
    const why: string[] = [];
    const add = (w: string | null) => {
      if (w && !why.includes(w)) why.push(w);
    };
    add(reason(r.file, "registered in"));
    if (r.handler) add(reason(r.handler.file, "handler in"));
    // a mount hop only matters when the file that mounts it changed itself, not when it merely
    // imports (transitively) something that changed
    for (const hop of r.mountChain) {
      if (affected.get(hop.file)?.distance === 0) add(reason(hop.file, "mounted from"));
    }
    for (const s of [...r.chain, ...r.unreached]) {
      if (s.middlewareId && mwWhy.has(s.middlewareId)) {
        const mw = mwById.get(s.middlewareId);
        add(`middleware ${mw?.name ?? "(inline)"} (${mw?.fullPath}) is affected`);
      }
    }
    for (const i of r.inline) add(reason(sourceFile(i.source) ?? "", "route middleware from"));
    for (const v of r.validators) add(reason(v.file, "validator in"));
    if (why.length)
      routes.push({ id: r.id, method: r.method, fullPath: r.fullPath, file: r.file, why });
  }
  const middlewares: ImpactResult["middlewares"] = [...mwWhy].map(([id, why]) => ({
    id,
    fullPath: mwById.get(id)?.fullPath ?? "",
    why,
  }));

  const apps = idx.apps.filter((a) => affected.has(a.file)).map((a) => a.id);
  const appFile = new Map(idx.apps.map((a) => [a.id, a.file]));
  const rpcTypes = idx.rpc.appTypes
    .filter(
      (t) =>
        affected.has(t.file) ||
        (t.target !== null && affected.has(appFile.get(t.target) ?? "")) ||
        idx.routes.some(
          (r) => t.target !== null && r.app === t.target && routes.some((x) => x.id === r.id),
        ),
    )
    .map((t) => t.name);
  const tests = [...affected.keys()].filter((f) => idx.facts.get(f)?.isTest);

  return {
    files,
    apps,
    routes,
    middlewares,
    rpcTypes,
    tests,
    suggestedChecks: suggestChecks(idx, files, tests, routes.length > 0),
  };
}

function suggestChecks(
  idx: ProjectIndex,
  files: string[],
  tests: string[],
  touchesRoutes: boolean,
): string[] {
  const checks: string[] = [];
  const src = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  const runtime = idx.detection.runtime;
  if (src.length) {
    checks.push(runtime === "deno" ? `deno check ${src.join(" ")}` : "npx tsc --noEmit");
  }
  const cats = new Set<string>();
  if (touchesRoutes) cats.add("routes");
  if (idx.middlewares.some((m) => files.includes(m.file))) cats.add("middleware");
  if (cats.size)
    checks.push(`hono_validate(categories=[${[...cats].map((c) => `"${c}"`).join(", ")}])`);
  if (tests.length) {
    const runner =
      runtime === "deno" ? "deno test -A" : runtime === "bun" ? "bun test" : "npx vitest run";
    checks.push(`${runner} ${tests.join(" ")}`);
  }
  if (idx.rpc.appTypes.length && touchesRoutes)
    checks.push("hono_rpc: re-check hc client types after the route change");
  return checks;
}

const SAFE_REF = /^[^\s\0-][^\s\0]*$/;

/** Files changed between refs, relative to the workspace. The refs reach git as arguments, never a shell. */
export async function gitChangedFiles(ws: string, base: string, head?: string): Promise<string[]> {
  for (const ref of [base, head]) {
    if (ref !== undefined && !SAFE_REF.test(ref)) {
      throw new Error(
        `refusing git ref "${ref}": refs must not start with "-" or contain whitespace`,
      );
    }
  }
  const range = head ? `${base}...${head}` : base;
  try {
    const { stdout } = await run("git", ["diff", "--name-only", "--relative", range, "--"], {
      cwd: ws,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`git diff ${range} failed: ${(err.stderr ?? err.message).trim()}`);
  }
}
