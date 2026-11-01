---
type: llm
criteria: Score 1 if the answer gives /v1/contacts/:id as the path to request and never presents the bare local /:id as the path
focus: last_message
---
Score 1 if the final answer reports `/v1/contacts/:id` as the path to request, and
`POST /v1/contacts/import` as the neighbouring POST route, with the `/v1` and
`/contacts` prefixes taken from the mounts. Mentioning `/:id` as the local path the
sub-app declares is fine when it is clearly labelled local. Score 0 if the answer
presents `/:id` (or any path without the mount prefixes) as the path to request.
Score 0.5 if `/v1/contacts/:id` is right but the POST route is missing or unprefixed.
