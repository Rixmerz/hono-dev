---
type: llm
criteria: Score 1 if the answer explains that a use() registered after a mount does not apply to it, because Hono runs entries in table order
focus: last_message
---
Score 1 if the answer explains the mechanism: Hono keeps one ordered table per instance;
`route()` copies the child's entries into the parent at call time, at that position;
a request runs the matching entries in table order and the first handler that returns
without calling `next()` ends it; the `use('*', ...)` entry of the later-mounted
`/v1/integrations` sub-app therefore sits after the google-calendar handlers and is
never reached for them. Naming the middleware rules M001 or M002 is a plus but not
required. Score 0.5 if the conclusion (auth does not run) is right but the order
mechanism is missing or wrong. Score 0 if the answer says the auth middleware applies.
