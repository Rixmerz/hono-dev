# Validation — reference (Hono 4.x)

Sources: `hono@4.13.16` `dist/validator/validator.js`, `dist/types/validator/validator.d.ts`,
`dist/types/request.d.ts` (`valid`, `addValidatedData`); the tarballs of
`@hono/zod-validator@0.9.1`, `@hono/valibot-validator@0.6.2`, `@hono/standard-validator@0.4.1`
and `@hono/zod-openapi@1.6.3` (`package.json` peers, `dist/index.d.mts`). *probe* marks a
behaviour run with Vitest 5.0.5 on Node 26, zod 4.6.7, valibot 1.5.0, TypeScript 6.0.3, in an
empty scratch directory.

## 1. The core: `validator(target, fn)` (`hono/validator`)

```js
const validator = (target, validationFunc) => async (c, next) => {
  let value = {};
  const contentType = c.req.header("Content-Type");
  switch (target) {
    case "json": if (!contentType || !jsonRegex.test(contentType)) break;
                 try { value = await c.req.json(); } catch { throw new HTTPException(400, { message: "Malformed JSON in request body" }); }
    case "form": ...    case "query": value = ... c.req.queries() ...
    case "param": value = c.req.param();   case "header": value = c.req.header();   case "cookie": value = getCookie(c);
  }
  const res = await validationFunc(value, c);
  if (res instanceof Response) return res;
  c.req.addValidatedData(target, res);
  return await next();
};
```

- `validationFunc` returns either a `Response` (the request stops) or the validated value,
  stored under `target` and read later with `c.req.valid(target)`.
- `json`: a missing or non-JSON `Content-Type` leaves `value = {}` (*probe*: valid body, no
  header → `400` from the schema). Unparseable JSON throws `HTTPException(400)`.
- `form`: `multipart/form-data` or `application/x-www-form-urlencoded`; the parsed `FormData` is cached on
  `c.req.bodyCache.formData`.
- `query`: `Object.fromEntries` of `c.req.queries()` with one-element arrays unwrapped.
- Types: `ValidationTargetByMethod<M>` removes `json` and `form` for `get | head`.
- `c.req.valid<T extends keyof I & keyof ValidationTargets>(target: T)` is typed by the chain's
  input `I` (`request.d.ts:218`). *probe* (`tsc`): `c.req.valid('json')` on a route with no
  json validator does not compile.

## 2. Library adapters

| Package | Export | Signature (from `dist/index.d.mts`) | Failure |
|---|---|---|---|
| `@hono/zod-validator` 0.9.1 | `zValidator` | `(target, schema: ZodSchema, hook?, options?)` with zod v3 or v4 | `Response & TypedResponse<ZodSafeParseResult failure, 400, 'json'>` |
| `@hono/valibot-validator` 0.6.2 | `vValidator` | `(target, schema: GenericSchema \| GenericSchemaAsync, hook?)` | `TypedResponse<failed SafeParseResult, 400, 'json'>` |
| `@hono/standard-validator` 0.4.1 | `sValidator` | `(target, schema: StandardSchemaV1, hook?)` | `TypedResponse<{ success: false, error: readonly Issue[], data }, 400, 'json'>` |

The hook has the shape `(result, c) => Response | void | Promise<...>` where `result` is
`{ success, data | error } & { target }`. Returning a response replaces the default `400`.

*probe* results (Hono 4.13.16, invalid or empty body unless noted):

| Call | Observed |
|---|---|
| `zValidator('json', z.object({ name: z.string() }))`, body `{}` | `400`, body `{"success":false,"error":{"name":"ZodError",...}}` |
| same with hook returning `c.json({ code: 'bad_input' }, 422)` on failure | `422` |
| `validator('json', fn)` returning `c.text('nope', 400)` | `400` `nope` |
| `vValidator('json', v.object({ n: v.number() }))`, `{}` / `{ n: 2 }` | `400` / `200` |
| `sValidator('json', z.object({ n: z.number() }))`, `{}` / `{ n: 2 }` | `400` (JSON) / `200` |
| `zValidator('query', z.object({ page: z.coerce.number().default(1) }))`, `?page=3` / none | `{page:3}` / `{page:1}` |
| `zValidator('param', z.object({ id: z.string().uuid() }))`, `/p/nope` | `400` |
| `zValidator('header', z.object({ 'x-api-key': z.string() }))`, sent as `X-Api-Key` | `{ 'x-api-key': 'k' }` |
| `zValidator('form', ...)` with a urlencoded body | parsed |
| `testClient(app).v.$post({ json: { n: 5 } })` | `200`, `{ n: 5 }` |

## 3. `OpenAPIHono` (`@hono/zod-openapi` 1.6.3, peers `hono >=4.10.0`, `zod ^4.0.0`)

```ts
const route = createRoute({
  method: 'get', path: '/users/{id}',
  request: { params: z.object({ id: z.string().min(3) }) },
  responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ id: z.string() }) } } } },
})
const api = new OpenAPIHono().openapi(route, (c) => c.json({ id: c.req.valid('param').id }, 200))
const app = new OpenAPIHono().route('/v1', api)
app.doc('/doc', { openapi: '3.0.0', info: { title: 'api', version: '1' } })
```

*probe*: `app.routes` = `GET /v1/users/:id` twice (validator entry and handler) plus `GET /doc`;
`/v1/users/ab` → `400`, `/v1/users/abc` → `200`; the document's `paths` key is
`/v1/users/{id}`. Handlers should return `c.json(body, 200)` with the status spelled out so the
response type lines up with `responses`. `OpenAPIHono` also exposes `.openapiRoutes([...])`,
`.doc31(...)`, `getOpenAPIDocument(...)`, and `defaultHook` in its options
(`dist/index.d.mts:176-231`). `route()` and `basePath()` are overridden to return
`OpenAPIHono`; mounting follows the copy-at-call rule of `hono-routing`.

## 4. What the tools extract

`hono_validators` returns one `ValidatorRef` per validator in a route's chain (`scope: 'route'`)
or on its mount (`scope: 'mount'`): `target` (`json | form | query | param | header | cookie |
unknown`), `library` (`zod | valibot | standard-schema | typebox | arktype | custom |
unknown`), `via` (the call name, e.g. `zValidator`), `schema` (the schema identifier or `null`).
Per handler, `hono_route` reports `bodyReads` (`json | parseBody | formData | text |
arrayBuffer | blob`) and `validReads` (the `c.req.valid(target)` calls), which is what V001 and
V003 compare against `validators`.

## Validator IDs

V001–V005, S005, S007 — see `../../_shared/references/rules.md`.
