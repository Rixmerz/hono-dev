/**
 * PostToolUse on Edit/Write/MultiEdit: run the fast rules for the edited file and hand back at most
 * 8 findings. Feedback only: it never blocks, and what it logs goes to the state directory.
 */
import { ProjectIndex, validateWorkspace } from "../mcp/core/index.ts";
import { isSourceFile } from "../mcp/core/fs.ts";
import { appendWarning } from "../mcp/core/state.ts";
import { validate } from "../mcp/validators/index.ts";
import { type HookInput, emitContext, projectDir, relativeTo } from "./hook-io.ts";

const MAX_LINES = 8;

export async function validateEdit(input: HookInput): Promise<void> {
  const file = input.tool_input?.file_path;
  if (typeof file !== "string") return;
  const dir = projectDir(input);
  const rel = relativeTo(dir, file);
  if (rel === null || !isSourceFile(rel)) return;

  const ws = await validateWorkspace(dir);
  const idx = await ProjectIndex.load(ws);
  if (!idx.detection.isHono) return;
  const result = await validate(idx, { files: [rel], fast: true });
  const findings = result.findings.filter((f) => f.severity !== "info");
  if (findings.length === 0) return;

  await appendWarning(ws, { file: rel, findings: findings.map((f) => f.id) });
  const lines = findings
    .slice(0, MAX_LINES)
    .map(
      (f) =>
        `- ${f.id} ${f.file}:${f.line ?? "-"} ${f.message}${f.hint ? ` (hint: ${f.hint})` : ""}`,
    );
  if (findings.length > MAX_LINES)
    lines.push(`- … ${findings.length - MAX_LINES} more: hono_validate`);
  emitContext("PostToolUse", `[hono-dev] ${rel}:\n${lines.join("\n")}`);
}
