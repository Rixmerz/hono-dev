/**
 * Hook dispatcher: `hono-dev-run hook <detect|invalidate|validate> [flags]`. Every hook fails open:
 * an error is written to warnings.jsonl in the state directory (never to the project) and the
 * process still exits 0, so a broken hook can never block an edit.
 */
import { appendWarning } from "../mcp/core/state.ts";
import { detectHono } from "./detect_hono.ts";
import { type HookInput, hooksDisabled, projectDir, readInput } from "./hook-io.ts";
import { invalidateIndex } from "./invalidate_index.ts";
import { validateEdit } from "./validate_edit.ts";

const HOOKS: Record<string, (input: HookInput, flags: string[]) => Promise<void>> = {
  detect: detectHono,
  invalidate: invalidateIndex,
  validate: validateEdit,
};

export async function runHook(args: string[]): Promise<void> {
  process.exitCode = 0;
  const [name, ...flags] = args;
  const hook = name ? HOOKS[name] : undefined;
  if (!hook || hooksDisabled()) return;
  const input = await readInput();
  try {
    await hook(input, flags);
  } catch (e) {
    try {
      await appendWarning(projectDir(input), {
        hook: name,
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // the state directory is unwritable too: there is nowhere left to report to
    }
  }
}
