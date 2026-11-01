/**
 * Project detection. Two passes: `detectStatic` reads manifests, lockfiles and marker files only;
 * `finalizeDetection` adds what the parsed sources show (Hono imports, serve calls, entry).
 */
import { join } from "node:path";
import type { Manifests } from "./config.ts";
import { exists, readText } from "./fs.ts";
import { canonicalSpecifier, isHonoSpecifier } from "./resolve.ts";
import type { AppId, Detection, HonoDevConfig, ModuleFacts, Runtime } from "./types.ts";

export interface StaticDetection {
  declared: string | null;
  resolved: string | null;
  resolvedFrom: string | null;
  specifiers: string[];
  runtimes: Map<Runtime, string[]>;
  deployTargets: Detection["deployTargets"];
  configFiles: Detection["configFiles"];
  workspaceMembers: string[];
  evidence: string[];
  /** Hono is named by a manifest (dependency or import map). */
  declaredInManifest: boolean;
}

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "yarn.lock",
];

async function firstExisting(workspace: string, names: string[]): Promise<string | null> {
  for (const n of names) if (await exists(join(workspace, n))) return n;
  return null;
}

/** `^4.6.0` / `npm:hono@4` / `jsr:@hono/hono@^4` → the version part, or null. */
function versionOf(spec: string): string | null {
  const m = spec.match(/@(?!.*@)([~^<>=v]*\d[^/\s]*)/);
  return m ? m[1] : null;
}

function majorOf(version: string | null): number | null {
  const m = version?.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function resolveFromLockfiles(
  workspace: string,
  lockfiles: string[],
): Promise<{ version: string; from: string } | null> {
  for (const name of lockfiles) {
    const text = await readText(join(workspace, name));
    if (!text) continue;
    let v: string | null = null;
    if (name === "package-lock.json") {
      try {
        const lock = JSON.parse(text) as {
          packages?: Record<string, { version?: string }>;
          dependencies?: Record<string, { version?: string }>;
        };
        v =
          lock.packages?.["node_modules/hono"]?.version ?? lock.dependencies?.hono?.version ?? null;
      } catch {
        v = null; // corrupt lockfile: try the next one
      }
    } else if (name === "pnpm-lock.yaml") {
      v =
        text.match(/^\s+hono:\s*\n\s+specifier:[^\n]*\n\s+version:\s*([\d.]+[^\s(]*)/m)?.[1] ??
        text.match(/(?:^|[\s'"/])hono@(\d+\.\d+\.\d+[\w.-]*)/m)?.[1] ??
        null;
    } else if (name === "bun.lock") {
      v = text.match(/"hono":\s*\[\s*"hono@(\d+\.\d+\.\d+[^"]*)"/)?.[1] ?? null;
    } else if (name === "deno.lock") {
      v =
        text.match(/"npm:hono@[^"]*":\s*"(\d+\.\d+\.\d+[^"]*)"/)?.[1] ??
        text.match(/"jsr:@hono\/hono@[^"]*":\s*"(\d+\.\d+\.\d+[^"]*)"/)?.[1] ??
        text.match(/"hono@(\d+\.\d+\.\d+[^"]*)"/)?.[1] ??
        null;
    } else if (name === "yarn.lock") {
      v = text.match(/^"?hono@[^\n]*\n\s+version "?([\d.]+[^"\n]*)/m)?.[1] ?? null;
    }
    if (v) return { version: v, from: name };
  }
  return null;
}

export async function detectStatic(workspace: string, m: Manifests): Promise<StaticDetection> {
  const evidence: string[] = [];
  const specifiers = new Set<string>();
  let declared: string | null = null;

  const pkgHono = m.deps.hono;
  if (pkgHono) {
    declared = pkgHono;
    specifiers.add(`hono@${pkgHono}`);
    evidence.push(`package.json depends on hono ${pkgHono}`);
  }
  for (const [key, value] of Object.entries(m.denoImports)) {
    if (!isHonoSpecifier(canonicalSpecifier(value)) && !isHonoSpecifier(canonicalSpecifier(key)))
      continue;
    if (canonicalSpecifier(value) !== "hono") continue;
    specifiers.add(value);
    declared ??= versionOf(value);
    evidence.push(`${m.denoJson?.path ?? "deno.json"} imports["${key}"] = ${value}`);
  }
  for (const dep of Object.keys(m.deps)) {
    if (dep.startsWith("@hono/")) evidence.push(`package.json depends on ${dep}`);
  }

  const wrangler = await firstExisting(workspace, [
    "wrangler.toml",
    "wrangler.json",
    "wrangler.jsonc",
  ]);
  const fly = await exists(join(workspace, "fly.toml"));
  const docker = await firstExisting(workspace, ["Dockerfile"]);
  const vercel = await exists(join(workspace, "vercel.json"));
  const bunMarker = await firstExisting(workspace, ["bun.lock", "bun.lockb", "bunfig.toml"]);

  const runtimes = new Map<Runtime, string[]>();
  const note = (r: Runtime, why: string) => runtimes.set(r, [...(runtimes.get(r) ?? []), why]);
  if (wrangler) note("cloudflare-workers", wrangler);
  if (m.denoJson) note("deno", m.denoJson.path);
  if (bunMarker) note("bun", bunMarker);
  if ("@hono/node-server" in m.deps) note("node", "package.json depends on @hono/node-server");

  const deployTargets: Detection["deployTargets"] = [];
  if (fly) deployTargets.push("fly");
  if (docker) deployTargets.push("docker");
  if (wrangler) deployTargets.push("cloudflare");
  const tasks = JSON.stringify(m.denoJson?.raw.tasks ?? {});
  if (m.denoJson && ("deploy" in m.denoJson.raw || /deployctl|deno deploy/.test(tasks)))
    deployTargets.push("deno-deploy");
  if (vercel) deployTargets.push("vercel");

  const lockfiles: string[] = [];
  for (const l of LOCKFILES) if (await exists(join(workspace, l))) lockfiles.push(l);
  const fromLock = await resolveFromLockfiles(workspace, lockfiles);
  let resolved = fromLock?.version ?? null;
  let resolvedFrom = fromLock?.from ?? null;
  if (!resolved) {
    const installed = await readText(join(workspace, "node_modules", "hono", "package.json"));
    if (installed) {
      try {
        resolved = (JSON.parse(installed) as { version?: string }).version ?? null;
        resolvedFrom = "node_modules/hono/package.json";
      } catch {
        resolved = null; // unreadable package.json: leave the resolved version unknown
      }
    }
  }

  return {
    declared,
    resolved,
    resolvedFrom,
    specifiers: [...specifiers],
    runtimes,
    deployTargets,
    configFiles: {
      packageJson: m.packageJson?.path ?? null,
      denoJson: m.denoJson?.path ?? null,
      tsconfig: m.tsconfig?.path ?? null,
      wrangler,
      lockfile: fromLock?.from ?? lockfiles[0] ?? null,
    },
    workspaceMembers: m.workspaceMembers,
    evidence,
    declaredInManifest: specifiers.size > 0,
  };
}

const PRIORITY: Runtime[] = ["cloudflare-workers", "deno", "bun", "node"];

export interface EntryCandidate {
  file: string;
  app: AppId | null;
  serve: NonNullable<Detection["entry"]>["serve"];
  line: number;
}

/** The serving entry: an explicit serve call outranks `export default`. */
export function pickEntry(
  facts: Map<string, ModuleFacts>,
  config: HonoDevConfig,
  resolve: (file: string, ref: string) => AppId | null,
): EntryCandidate | null {
  const rank = { "node-server": 0, "deno-serve": 0, "bun-serve": 0, "export-default": 1 } as const;
  const found: (EntryCandidate & { rank: number })[] = [];
  for (const mod of facts.values()) {
    if (mod.isTest) continue;
    for (const s of mod.serves) {
      found.push({
        file: mod.path,
        app: s.appRef ? resolve(mod.path, s.appRef) : null,
        serve: s.kind,
        line: s.line,
        rank: rank[s.kind],
      });
    }
    for (const ex of mod.exports) {
      if (ex.name !== "default" || !ex.local || ex.isType) continue;
      const app = resolve(mod.path, ex.local);
      if (app && !found.some((f) => f.file === mod.path && f.serve === "export-default")) {
        found.push({ file: mod.path, app, serve: "export-default", line: ex.line, rank: 1 });
      }
    }
  }
  if (config.entry) {
    const forced = found.find((f) => f.file === config.entry);
    return forced ?? { file: config.entry, app: null, serve: "unknown", line: 1 };
  }
  found.sort(
    (a, b) => a.rank - b.rank || (b.app ? 1 : 0) - (a.app ? 1 : 0) || a.file.localeCompare(b.file),
  );
  const best = found[0];
  return best ? { file: best.file, app: best.app, serve: best.serve, line: best.line } : null;
}

export function finalizeDetection(
  st: StaticDetection,
  facts: Map<string, ModuleFacts>,
  entry: EntryCandidate | null,
  hasApps: boolean,
): Detection {
  const runtimes = new Map(st.runtimes);
  const evidence = [...st.evidence];
  const specifiers = new Set(st.specifiers);
  let sourceHono = false;
  const note = (r: Runtime, why: string) => runtimes.set(r, [...(runtimes.get(r) ?? []), why]);

  for (const mod of facts.values()) {
    if (mod.isTest) continue;
    for (const imp of mod.imports) {
      const c = imp.canonical;
      if (!c || imp.isTypeOnly) continue;
      if (isHonoSpecifier(c) || c === "@hono/zod-openapi") {
        sourceHono = true;
        if (c === "hono" && /^(npm|jsr):|^https?:/.test(imp.specifier))
          specifiers.add(imp.specifier);
      }
      if (c === "@hono/node-server")
        note("node", `${mod.path}:${imp.line} imports @hono/node-server`);
    }
    for (const s of mod.serves) {
      if (s.kind === "deno-serve") note("deno", `${mod.path}:${s.line} Deno.serve`);
      if (s.kind === "bun-serve") note("bun", `${mod.path}:${s.line} Bun.serve`);
      if (s.kind === "node-server")
        note("node", `${mod.path}:${s.line} serve() from @hono/node-server`);
    }
  }
  if (sourceHono && !st.declaredInManifest)
    evidence.push("sources import hono without a manifest entry");

  let runtime: Runtime = "unknown";
  const byServe: Record<string, Runtime> = {
    "deno-serve": "deno",
    "bun-serve": "bun",
    "node-server": "node",
  };
  if (entry && byServe[entry.serve]) runtime = byServe[entry.serve];
  else runtime = PRIORITY.find((r) => runtimes.has(r)) ?? "unknown";

  const isHono = st.declaredInManifest || sourceHono;
  const declared = st.declared;
  const version = st.resolved ?? declared;
  const major = majorOf(version);
  const confidence: Detection["confidence"] = !isHono
    ? "low"
    : declared && hasApps
      ? "high"
      : declared || hasApps
        ? "medium"
        : "low";
  if (entry) evidence.push(`entry ${entry.file}:${entry.line} (${entry.serve})`);

  return {
    isHono,
    honoVersion: { declared, resolved: st.resolved, major, supported: major === 4 },
    honoSpecifiers: [...specifiers],
    runtime,
    runtimes: PRIORITY.filter((r) => runtimes.has(r)).map((r) => ({
      runtime: r,
      evidence: runtimes.get(r) ?? [],
    })),
    deployTargets: st.deployTargets,
    entry,
    configFiles: st.configFiles,
    workspaceMembers: st.workspaceMembers,
    confidence,
    evidence,
  };
}
