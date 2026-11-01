/** Hook plumbing: the JSON Claude Code sends on stdin, the output it reads, the kill switch. */
import { realpathSync } from "node:fs";
import { relative } from "node:path";

export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  /** FileChanged: the file that changed. */
  file_path?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

export async function readInput(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<HookInput> {
  const chunks: string[] = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? c : c.toString("utf8"));
  const text = chunks.join("").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as HookInput) : {};
  } catch {
    return {}; // a hook never fails the session over unreadable input
  }
}

/** HONO_DEV_HOOKS=off (also 0 and false) silences every hook. */
export function hooksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["off", "0", "false"].includes((env.HONO_DEV_HOOKS ?? "").toLowerCase());
}

/** The hook's own working directory first: CwdChanged and DirectoryAdded move it away from the session root. */
export function projectDir(input: HookInput): string {
  return input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Path of `file` relative to `dir` in POSIX form; null when it lies outside. */
export function relativeTo(dir: string, file: string): string | null {
  let base = dir;
  let target = file;
  try {
    base = realpathSync(dir);
    target = realpathSync(file);
  } catch {
    // the file may be new or gone: compare the paths as given
  }
  const rel = relative(base, target).replace(/\\/g, "/");
  return rel === "" || rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel) ? null : rel;
}

/** The documented shape: additionalContext is a plain string. */
export function emitContext(event: string, text: string): void {
  console.log(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
  );
}
