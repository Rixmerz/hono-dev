import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectIndex } from "../core/index.ts";
import type { MiddlewareEntry, RouteEntry } from "../core/types.ts";

// Every test file imports this module first: keep plugin state out of ~/.cache.
const stateRoot = await mkdtemp(join(tmpdir(), "hono-dev-state-"));
process.env.HONO_DEV_STATE_DIR = stateRoot;

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

export function fixture(name: string): string {
  return join(FIXTURES, name);
}

const cache = new Map<string, Promise<ProjectIndex>>();
/** Fixture indexes are read-only: share one per fixture within a test file. */
export function loadFixture(name: string): Promise<ProjectIndex> {
  let p = cache.get(name);
  if (!p) {
    p = ProjectIndex.load(fixture(name), { force: true });
    cache.set(name, p);
  }
  return p;
}

const temps: string[] = [];

/** Write an inline project into a fresh temp directory; returns its (real) path. */
export async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hono-dev-proj-"));
  temps.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

/** Copy a fixture to a temp directory, for tests that write. */
export async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hono-dev-copy-"));
  temps.push(dir);
  await cp(fixture(name), dir, { recursive: true });
  return dir;
}

export async function loadProject(files: Record<string, string>): Promise<ProjectIndex> {
  return ProjectIndex.load(await makeProject(files), { force: true });
}

export async function cleanupTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/**
 * hono-base registers one table entry per handler argument, not per route call, so a RouteEntry
 * stands for `inline + route-scope validators + handler` entries (docs/adr/0002).
 */
export function expandedTable(idx: ProjectIndex, root: string): { method: string; path: string }[] {
  const table = idx.table(root);
  if (!table) throw new Error(`no table for ${root}`);
  const out: { method: string; path: string }[] = [];
  for (const e of table.entries) {
    const count =
      "chain" in e
        ? (e as RouteEntry).inline.length +
          (e as RouteEntry).validators.filter((v) => v.scope === "route").length +
          ((e as RouteEntry).handler ? 1 : 0)
        : 1;
    for (let i = 0; i < count; i++) out.push({ method: e.method, path: e.fullPath });
  }
  return out;
}

export function routeAt(idx: ProjectIndex, method: string, fullPath: string): RouteEntry {
  const r = idx.findRoute(method, fullPath);
  if (!r) throw new Error(`route not found: ${method} ${fullPath}`);
  return r;
}

export function middlewareNames(entries: { name: string | null }[]): (string | null)[] {
  return entries.map((e) => e.name);
}

export type { MiddlewareEntry, RouteEntry };
