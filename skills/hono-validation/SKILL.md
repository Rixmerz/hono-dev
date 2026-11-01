---
name: hono-validation
description: >-
  How request validation works in a Hono 4.x project: the validator() core in hono/validator,
  zValidator, vValidator and sValidator (zod, valibot, Standard Schema), the six targets
  (json, form, query, param, header, cookie), c.req.valid(), hooks and error shapes, the
  Content-Type rule for json and form, and OpenAPIHono with createRoute. Use when adding or
  changing a POST/PUT/PATCH body, a query or param schema, a validation error response, or
  when a handler reads c.req.json() directly, a 400 appears unexpectedly, or a task mentions
  zod, valibot, schema or validator. Query hono_validators and hono_route before editing.
user-invocable: false
paths: "src/routes/**,src/validators/**,src/schemas/**"
---

# hono-validation

A validator in Hono is a middleware that parses one part of the request, writes the result
to the request's validated data, and either calls `next()` or returns a response. A handler
that skips it and calls `c.req.json()` is unvalidated, whatever the schema file says. Ask
which routes have which validator before writing a schema.

References: `references/validation.md`, `../_shared/references/versions.md`.

## Before touching anything

| Question | Call |
|---|---|
| Which routes have no body validator at all? | `hono_validators(workspace="/abs/path", missing_only=true)` |
| Validators under one prefix, with target and library | `hono_validators(workspace="/abs/path", prefix="/v1/contacts")` — `ValidatorRef`: `target`, `library`, `via`, `schema`, `scope` |
| Everything about the route I will edit | `hono_route(workspace="/abs/path", method="POST", path="/v1/contacts/import")` — `validators[]`, `handler.bodyReads[]`, `handler.validReads[]` |
| Which Hono and which validator packages are installed? | `hono_project(workspace="/abs/path")`; `hono_dependencies(workspace="/abs/path", file="src/routes/v1/contacts.ts", direction="imports")` |
| Where else is this schema file used? | `hono_dependencies(workspace="/abs/path", file="src/schemas/contact.ts", direction="importers")`; `hono_impact(workspace="/abs/path", files=["src/schemas/contact.ts"])` |
| Does the client type pick the schema up? | `hono_rpc(workspace="/abs/path")` |

## Decision rules

### Pick the validator the project already uses

| You see | Use | Schema errors |
|---|---|---|
| `@hono/zod-validator` | `zValidator(target, schema, hook?)` | `400` with `{ success: false, error: { name: 'ZodError', ... } }` |
| `@hono/valibot-validator` | `vValidator(target, schema, hook?)` | `400` with the failed `SafeParseResult` |
| `@hono/standard-validator` | `sValidator(target, schema, hook?)` for any Standard Schema library (zod, valibot, arktype, ...) | `400` with `{ success: false, error: Issue[], data }` |
| nothing installed | `validator(target, (value, c) => ...)` from `hono/validator` | whatever the function returns: return a `Response` to stop, return the parsed value to continue |
| `@hono/zod-openapi` | `OpenAPIHono` with `createRoute` and `.openapi(route, handler)` | the `defaultHook` or the route hook |

Do not add a second library to a repo that has one (`engineering-baseline`: the project's
convention wins). Package peer ranges are in `../_shared/references/versions.md`.

### Targets and what each one reads (hono 4.13.16: `dist/validator/validator.js`)

| Target | Source | Notes (*probe* = run on 4.13.16) |
|---|---|---|
| `json` | `c.req.json()` | only when `Content-Type` is JSON; otherwise the value is `{}` and a strict schema fails with `400` (*probe*: no header → 400). Invalid JSON → `HTTPException 400 "Malformed JSON in request body"` |
| `form` | `multipart/form-data` or `application/x-www-form-urlencoded` | same rule; keys ending in `[]` and repeated keys become arrays |
| `query` | `c.req.queries()` | single values are strings, repeated keys are arrays (*probe*: `?tag=a&tag=b` → `["a","b"]`); use `z.coerce.number()` for numbers |
| `param` | `c.req.param()` | always strings; validate `uuid`, numeric ids here |
| `header` | `c.req.header()` | keys are lower-case (*probe*: `X-Api-Key` arrives as `x-api-key`) |
| `cookie` | `getCookie(c)` | |

`json` and `form` are not valid targets for `get` or `head` routes at the type level
(`ValidationTargetByMethod` in `dist/types/validator/validator.d.ts`): V004.

### Read validated data only through `c.req.valid(target)`

- It is typed from the validators earlier in the same chain. Reading a target without its
  validator is a type error (*probe*, `tsc`: `c.req.valid('json')` on a route with no json
  validator) and V003 for the cases the type checker cannot see.
- A POST/PUT/PATCH handler that calls `c.req.json()`, `parseBody()` or `formData()` with no
  json or form validator in its chain is V001; a body route where the body use cannot be
  analysed is V002. Route params read through `c.req.param()` without a `param` validator
  are V005.
- Validate at the edge of the route, before the handler: `app.post('/', zValidator('json', schema), handler)`.

### Custom error responses

- Pass a hook as the third argument: `(result, c) => { if (!result.success) return c.json({ code: 'bad_input' }, 422) }`
  (*probe*: zod hook returning 422). Returning nothing lets the default `400` happen.
- Prefer one shared hook (a `defaultHook` on `OpenAPIHono`, or a helper wrapping `zValidator`)
  over repeating the shape in each route. Do not return `err.message` or issue paths that leak
  internals (S005 covers `onError`).

### OpenAPIHono (`@hono/zod-openapi` 1.6.3)

`createRoute({ method, path: '/users/{id}', request: { params, query, body }, responses })`
declares the contract; `.openapi(route, handler, hook?)` registers validators and the handler
and fills the OpenAPI registry. Its path syntax is `{id}`; Hono sees `:id`. *Probe*: on
`new OpenAPIHono().route('/v1', api)` the Hono table holds `GET /v1/users/:id` **twice**
(validator entry, then handler), and `app.doc('/doc', ...)` serves `/v1/users/{id}` in
`paths`. Two entries with the same method and path produced by `.openapi()` are the library's
shape, not a duplicate registration; judge R001 by the call sites in source.
`app.doc()` must be called before the first request (the router freezes at the first match).

## Minimal change

1. `hono_route` the route (or `hono_validators(prefix=...)` the neighbourhood). Copy the
   validator package, schema location and hook of a sibling.
2. Add the schema next to the existing ones; infer the type from the schema
   (`z.infer`, `v.InferOutput`) rather than declaring it twice.
3. Add the validator to the route call, remove the direct `c.req.json()`, read
   `c.req.valid('json')`.
4. Test the three inputs: valid, invalid body, wrong or missing `Content-Type`
   (`hono-testing`: `app.request(path, { method: 'POST', headers, body })`).
5. Validate: `hono_validate(workspace="/abs/path", categories=["validation"], files=[...])`,
   the project's type check and tests, then `hono_validators(workspace="/abs/path", missing_only=true)`
   and confirm the route is gone from the list.

## Traps

| Trap | ID |
|---|---|
| POST/PUT/PATCH reads the body and no json/form validator guards it | V001 |
| body route whose body use cannot be analysed and has no validator | V002 |
| `c.req.valid(target)` with no validator for that target | V003 |
| json/form validator on a GET/HEAD route | V004 |
| route params read with no `param` validator | V005 |
| no `bodyLimit()` on a route that reads `formData`/`parseBody` | S007 |
| client sent JSON without `Content-Type: application/json`: the validator sees `{}` | use the right header in tests |

## Precedence

The project's existing conventions outrank this skill; the user's request and safety
outrank both (`engineering-baseline`). Validating external input at the trust boundary
(CWE-20) is safety: never drop a validator to make a test pass.
