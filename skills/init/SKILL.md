---
name: init
description: >-
  Detect the Hono project, print what hono-dev found, and print the livespec, gitignore and (when vise is present) vise snippets for the user to add. Prints only; writes nothing into the project. Arg: optional workspace path.
disable-model-invocation: true
argument-hint: "[workspace]"
---

Workspace: `$0` if given, otherwise the absolute path of the current project (run `pwd`). Every hono tool call takes `workspace` as that absolute path.

Tool names: `hono_project` is the tool name as the hono MCP server registers it. The prefix your tool list shows depends on how the plugin was mounted; use whichever prefix it shows.

This command never writes into the project: no Write, no Edit, no shell redirect, no `tee`, not even after the user says yes. It prints text; the user pastes it.

1. Call `hono_project` with `{ workspace }`.
   - If the result is `ok: false`, print the tool's `error` and `hint` and the detection evidence it returns (which `hono` dependency, `deno.json` import or `wrangler` file was found or missing), then stop. Create nothing.
   - Otherwise print one block: Hono version, runtime and deploy targets, entry file, counts of routes and apps, the workspace members when the workspace is a monorepo, and the index state.
2. Detect neighbours by footprint with `ls`, never by guessing: `.livespec.toml` (livespec config), `.mcp-docs/docs.db` (livespec index), `.vise/` (vise). Print one line per neighbour: present or absent.
3. Print the snippets below. For each one read the file under `${CLAUDE_PLUGIN_ROOT}`, then print the target path in the project and the exact content, and say it is for the user to add.
   - `.livespec.toml`: the `[graph]` section from `${CLAUDE_PLUGIN_ROOT}/integrations/livespec/livespec.toml.snippet`. Only when a livespec footprint was found; otherwise say in one line that it applies once livespec is set up. Say that the file it points at, `.hono-dev/graph.json`, does not exist until the user runs the graph export (the `hono_graph_export` tool, or `hono-mcp export <workspace>`); that export is the one write hono-dev ever makes inside a project, and only on request.
   - `.gitignore`: the lines from `${CLAUDE_PLUGIN_ROOT}/integrations/gitignore.snippet`. Grep the project's `.gitignore` first (read-only) and print nothing for this item if `.hono-dev` is already covered. Mention that `.hono-dev/config.json` is the optional user config and stays versioned, and that a team which versions `graph.json` should leave the ignore line out.
   - vise, only when `.vise/` was found: `${CLAUDE_PLUGIN_ROOT}/integrations/vise/capabilities.yaml` as keys for `.vise/capabilities.yaml`, and `${CLAUDE_PLUGIN_ROOT}/integrations/vise/quality.hono.yaml` for `.vise/quality.yaml` with `<ABS_PATH_TO_PLUGIN>` replaced by the absolute value of `${CLAUDE_PLUGIN_ROOT}` (`quality.yaml` does not expand variables). If those files already exist, say which keys are missing instead of printing the whole template. The five consultation recipes are in `${CLAUDE_PLUGIN_ROOT}/recipes/`, to copy into `.vise/recipes/`.
4. Print these reminders, in this order:
   - Hooks are already active, nothing to enable: detect on session start, invalidate and validate after edits. They never block. Kill switch: `HONO_DEV_HOOKS=off`.
   - Where the state lives: outside the project, under the plugin data directory (`HONO_DEV_STATE_DIR` overrides it). The only file hono-dev may create inside the project is the exported graph.
   - Knowledge skills to name in briefs to vise subagents (they do not load them on their own): `hono-dev:hono-development`, `hono-dev:hono-routing`, `hono-dev:hono-middleware`, `hono-dev:hono-validation`, `hono-dev:hono-rpc`, `hono-dev:hono-testing`, `hono-dev:hono-deploy`, `hono-dev:hono-mcp-server`.
5. End with one line: `Nothing was written in <workspace>.`
