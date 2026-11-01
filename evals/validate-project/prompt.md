---
name: validate-project
tags: [skill:validate, tool:hono_validate, read-only]
runs: 3
max_turns: 8
---
The working project is the Hono 4 app at `fixtures/hono-node` (relative to the plugin
root; use its absolute path as `workspace` for every hono tool).

Run the hono-dev structural validation on this project. Report the findings grouped
by severity and end with a single line that says `ok` or `not ok`.
