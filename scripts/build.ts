/**
 * Bundle mcp/entry.ts (server, CLI and hooks) with its dependencies, TypeScript 6.0.3 included, into
 * dist/entry.cjs. The launcher runs that file, so the plugin works from a checkout with no
 * `npm install` and never resolves TypeScript from the project it analyses.
 *
 * `node scripts/build.ts` writes it; the dist test calls `bundle()` and compares.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE = join(ROOT, "dist", "entry.cjs");

/** The bundle as text; deterministic, so a stale dist/ is detectable by comparison. */
export async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, "mcp", "entry.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node24",
    minify: true,
    legalComments: "eof",
    logLevel: "warning",
    // nothing external: a dependency left out would be resolved from wherever the plugin runs
    external: [],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no output");
  return file.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await bundle();
  await mkdir(dirname(BUNDLE), { recursive: true });
  await writeFile(BUNDLE, text);
  console.log(`wrote ${BUNDLE} (${(text.length / 1e6).toFixed(1)} MB)`);
}
