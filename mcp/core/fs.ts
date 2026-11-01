/** Filesystem helpers: walking, hashing, path normalisation. All returned paths are POSIX. */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
export const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?)\/|[._-](?:test|spec)\.[cm]?[jt]sx?$/;
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hono-dev",
  ".wrangler",
  ".vise",
  ".mcp-docs",
  ".next",
  ".output",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
]);

const REGEXP_SPECIALS = ".+^$" + "{}()|[]\\";

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export function rel(workspace: string, abs: string): string {
  const r = toPosix(relative(workspace, abs));
  return r.startsWith("./") ? r.slice(2) : r;
}

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTS.some((e) => path.endsWith(e)) && !path.endsWith(".d.ts");
}

export function stripExt(path: string): string {
  const i = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return i > slash ? path.slice(0, i) : path;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Resolve `../x` style specifiers against a workspace-relative POSIX directory. */
export function joinRel(dir: string, spec: string): string {
  const parts = (dir ? dir.split("/") : []).filter(Boolean);
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export interface FileStat {
  path: string; // workspace-relative POSIX
  abs: string;
  size: number;
  mtime: number;
}

/** `assets/`, `*.min.js` or `**\/generated/**` style globs; a bare directory name matches at any depth. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.startsWith("./")) g = g.slice(2);
  const anchored = g.startsWith("/");
  if (anchored) g = g.slice(1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (REGEXP_SPECIALS.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${anchored ? "^" : "(^|/)"}${re}`);
}

/** Recursively list files under `dir`; returns workspace-relative paths sorted by name. */
export async function walkFiles(
  workspace: string,
  dir: string,
  opts: { extensions?: readonly string[]; ignore?: string[] } = {},
): Promise<FileStat[]> {
  const out: FileStat[] = [];
  const ignore = (opts.ignore ?? []).map(globToRegExp);
  async function visit(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip it, the walk is best-effort
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = join(current, e.name);
      const r = rel(workspace, abs);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (ignore.some((re) => re.test(`${r}/`))) continue;
        await visit(abs);
      } else if (e.isFile()) {
        if (opts.extensions && !opts.extensions.some((x) => e.name.endsWith(x))) continue;
        if (ignore.some((re) => re.test(r))) continue;
        try {
          const st = await stat(abs);
          out.push({ path: r, abs, size: st.size, mtime: st.mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }
  await visit(dir);
  return out;
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/** File text, or null when missing or unreadable. */
export async function readText(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
