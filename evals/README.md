# evals/

Behavioural checks for the hono-dev skills and hooks, run with the Claude Code
plugin evaluator from the plugin root:

    claude plugin eval .

Layout (one directory per case):

    evals/<case>/prompt.md        frontmatter: name, tags, runs, max_turns; body: the prompt
    evals/<case>/graders/*.md     frontmatter: type (regex | tool_used | tool_order | llm)
                                  plus that grader's options; body: the rubric for llm graders

Every prompt names a fixture under `fixtures/` (relative to the plugin root) as the
working project: `hono-node` for the clean single-app cases, `hono-mounted` for the
multi-level mounted app. Tool names in `tool_used` and `tool_order` graders are the
tool-name suffixes (`hono_routes`, `hono_trace`, ...); the installed MCP prefix is not part of the match. If your Claude
Code version requires the full name, prefix the values in the grader files.

Cases:

| case             | checks                                                                          |
|------------------|---------------------------------------------------------------------------------|
| session-detect   | first assistant message names the Hono version and the runtime (SessionStart hook) |
| add-route        | `hono_routes` called, and before `Write`; conflict or shadowing checked (llm)   |
| mounted-path     | `hono_routes` called; answer reports `/v1/contacts/:id`, not the local `/:id`   |
| middleware-order | `hono_trace` called; answer explains why the later `use()` never runs (llm)     |
| validate-project | `hono_validate` called; answer ends with ok / not ok                            |

Notes:

- `runs: 3` per case; the initial pass threshold is 0.8. Evals consume tokens, so run
  them on demand rather than on every push.
- `add-route` writes a route file into `fixtures/hono-mounted`. Run on a clean tree and
  discard the fixture changes afterwards.
- `mounted-path` and `middleware-order` are read-only and depend on the section 7 proof
  case kept in `fixtures/hono-mounted` (see `fixtures/hono-mounted/EXPECTED.md`).
- `evals/results/` is written by the evaluator and is gitignored.
