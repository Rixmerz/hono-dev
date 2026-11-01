/** Reading package.json / deno.json(c) / tsconfig.json(c) and the optional .hono-dev/config.json. */
import { join } from "node:path";
import ts from "typescript";
import { dirname, exists, joinRel, readText } from "./fs.ts";
import type { HonoDevConfig } from "./types.ts";

export type JsonObject = Record<string, unknown>;

export const DEFAULT_CONFIG: HonoDevConfig = {
  ignore: [],
  maxFileBytes: 1_000_000,
  entry: null,
  dbSpecifiers: [],
  authMiddleware: [],
  serviceDirs: ["src/services", "services", "src/lib"],
  envValidationModules: [],
};

export function asRecord(v: unknown): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
}

export function asStringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(v))) if (typeof val === "string") out[k] = val;
  return out;
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

/** Parse JSON with comments and trailing commas using the TypeScript parser (no extra dependency). */
export function parseJsonc(text: string): JsonObject | null {
  const { config, error } = ts.parseConfigFileTextToJson("config.json", text);
  if (error || config === undefined) return null;
  return asRecord(config);
}

async function readJsonc(abs: string): Promise<JsonObject | null> {
  const text = await readText(abs);
  return text === null ? null : parseJsonc(text);
}

export interface Manifests {
  packageJson: { path: string; raw: JsonObject } | null;
  denoJson: { path: string; raw: JsonObject } | null;
  tsconfig: { path: string; raw: JsonObject } | null;
  /** Merged deno.json `imports` plus an external `importMap` file. */
  denoImports: Record<string, string>;
  denoDir: string;
  /** package.json dependencies, devDependencies, peerDependencies and optionalDependencies. */
  deps: Record<string, string>;
  /** package.json `imports` (`#alias` subpath imports). */
  pkgImports: JsonObject;
  /** tsconfig `paths`, with the directory they are relative to (workspace-relative). */
  tsPaths: { baseDir: string; paths: Record<string, string[]> } | null;
  workspaceMembers: string[];
}

async function firstJson(
  workspace: string,
  names: string[],
): Promise<{ path: string; raw: JsonObject } | null> {
  for (const name of names) {
    const raw = await readJsonc(join(workspace, name));
    if (raw) return { path: name, raw };
  }
  return null;
}

async function readTsPaths(
  workspace: string,
  file: string,
  raw: JsonObject,
  depth = 0,
): Promise<{ baseDir: string; paths: Record<string, string[]> } | null> {
  const co = asRecord(raw.compilerOptions);
  const dir = dirname(file);
  const baseUrl = typeof co.baseUrl === "string" ? joinRel(dir, co.baseUrl) : null;
  const paths: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(asRecord(co.paths))) {
    const arr = asStringArray(v);
    if (arr) paths[k] = arr;
  }
  if (Object.keys(paths).length > 0) return { baseDir: baseUrl ?? dir, paths };
  if (typeof raw.extends === "string" && raw.extends.startsWith(".") && depth < 5) {
    const ext = joinRel(dir, raw.extends.endsWith(".json") ? raw.extends : `${raw.extends}.json`);
    const parent = await readJsonc(join(workspace, ext));
    if (parent) return readTsPaths(workspace, ext, parent, depth + 1);
  }
  return null;
}

export async function readManifests(workspace: string): Promise<Manifests> {
  const packageJson = await firstJson(workspace, ["package.json"]);
  const denoJson = await firstJson(workspace, ["deno.json", "deno.jsonc"]);
  const tsconfig = await firstJson(workspace, ["tsconfig.json", "tsconfig.jsonc"]);

  let denoImports = asStringRecord(denoJson?.raw.imports);
  if (denoJson && typeof denoJson.raw.importMap === "string") {
    const map = await readJsonc(join(workspace, denoJson.raw.importMap));
    if (map) denoImports = { ...asStringRecord(map.imports), ...denoImports };
  }

  const deps: Record<string, string> = {};
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    Object.assign(deps, asStringRecord(packageJson?.raw[key]));
  }

  const memberSource = (m: unknown) =>
    asStringArray(m) ?? asStringArray(asRecord(m).packages) ?? asStringArray(asRecord(m).members);
  const members = [
    ...(memberSource(packageJson?.raw.workspaces) ?? []),
    ...(memberSource(denoJson?.raw.workspace) ?? []),
  ];

  return {
    packageJson,
    denoJson,
    tsconfig,
    denoImports,
    denoDir: denoJson ? dirname(denoJson.path) : "",
    deps,
    pkgImports: asRecord(packageJson?.raw.imports),
    tsPaths: tsconfig ? await readTsPaths(workspace, tsconfig.path, tsconfig.raw) : null,
    workspaceMembers: [...new Set(members.map((m) => m.replace(/^\.\//, "").replace(/\/$/, "")))],
  };
}

/** `<ws>/.hono-dev/config.json`, read-only; defaults when absent or unreadable. */
export async function readHonoDevConfig(workspace: string): Promise<HonoDevConfig> {
  const abs = join(workspace, ".hono-dev", "config.json");
  if (!(await exists(abs))) return { ...DEFAULT_CONFIG };
  const raw = await readJsonc(abs);
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    ignore: asStringArray(raw.ignore) ?? [],
    maxFileBytes:
      typeof raw.maxFileBytes === "number" ? raw.maxFileBytes : DEFAULT_CONFIG.maxFileBytes,
    entry: typeof raw.entry === "string" ? raw.entry : null,
    dbSpecifiers: asStringArray(raw.dbSpecifiers) ?? [],
    authMiddleware: asStringArray(raw.authMiddleware) ?? [],
    serviceDirs: asStringArray(raw.serviceDirs) ?? [...DEFAULT_CONFIG.serviceDirs],
    envValidationModules: asStringArray(raw.envValidationModules) ?? [],
  };
}
