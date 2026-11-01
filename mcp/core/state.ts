/**
 * Plugin state lives OUTSIDE the analysed workspace (docs/adr/0003): the facts cache, the dirty
 * marker and warnings.jsonl. Analysis never writes into a workspace; only graph export does.
 */
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex } from "./fs.ts";

/** First 16 hex chars of sha256(realpath(ws)). */
export function workspaceKey(ws: string): string {
  let real: string;
  try {
    real = realpathSync(ws);
  } catch {
    real = resolve(ws); // workspace not on disk (yet): key by the lexical path
  }
  return sha256Hex(real).slice(0, 16);
}

/** First match of $HONO_DEV_STATE_DIR, ${CLAUDE_PLUGIN_DATA}/state, ${XDG_CACHE_HOME:-~/.cache}/hono-dev. */
export function stateDir(ws: string): string {
  const key = workspaceKey(ws);
  const explicit = process.env.HONO_DEV_STATE_DIR;
  if (explicit) return join(explicit, key);
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return join(pluginData, "state", key);
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "hono-dev", key);
}

interface DirtyMarker {
  all: boolean;
  paths: string[];
}

async function readMarker(file: string): Promise<DirtyMarker> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<DirtyMarker>;
    return {
      all: raw.all === true,
      paths: Array.isArray(raw.paths) ? raw.paths.filter((p) => typeof p === "string") : [],
    };
  } catch {
    return { all: false, paths: [] }; // missing or corrupt marker: nothing is known to be dirty
  }
}

/** Mark files (workspace-relative) dirty; no files means the whole index is stale. */
export async function markDirty(ws: string, files?: string[]): Promise<void> {
  const dir = stateDir(ws);
  const file = join(dir, "dirty.json");
  await mkdir(dir, { recursive: true });
  const cur = await readMarker(file);
  if (!files || files.length === 0) cur.all = true;
  else cur.paths = [...new Set([...cur.paths, ...files.map((f) => f.replace(/^\.\//, ""))])];
  await writeFile(file, JSON.stringify(cur));
}

/** Read and clear the dirty marker. */
export async function consumeDirty(ws: string): Promise<Set<string> | "all"> {
  const file = join(stateDir(ws), "dirty.json");
  const marker = await readMarker(file);
  await rm(file, { force: true });
  return marker.all ? "all" : new Set(marker.paths);
}

export async function appendWarning(ws: string, record: Record<string, unknown>): Promise<void> {
  const dir = stateDir(ws);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  await appendFile(join(dir, "warnings.jsonl"), `${line}\n`);
}
