---
type: llm
criteria: Score 1 if the FIRST assistant message names Hono and its major version and the runtime for this
focus: last_message
---
Score 1 if the FIRST assistant message names Hono with its major version for this
project (4.x, or a 4.x version string) and the runtime (Node); the SessionStart hook
injects both facts, so no tool call is needed. Score 0.5 if the facts appear only in a
later message (after a tool call), or if the version is named but the runtime is
missing. Score 0 if the framework is wrong, the version is missing, or the assistant
says it cannot tell.
