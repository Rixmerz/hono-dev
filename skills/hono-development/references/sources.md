# Sources and verification log — the knowledge skills

Every Hono API statement in `hono-development`, `hono-routing`, `hono-middleware`,
`hono-validation`, `hono-rpc`, `hono-testing` and `_shared/references/versions.md` was
checked against the installed package, not recalled. This file says what was read and how a
claim can be reproduced. When the installed source and a skill disagree, the installed
source wins and the skill is the bug.

## Packages read

| Package | Version | How it was obtained | What was read |
|---|---|---|---|
| `hono` | 4.13.16 | `npm pack hono@4.13.16` into an empty `/tmp` directory, extracted | `dist/hono-base.js`, `dist/hono.js`, `dist/compose.js`, `dist/router.js`, `dist/http-exception.js`, `dist/utils/url.js`, `dist/validator/validator.js`, `dist/middleware/cors/index.js`, `dist/helper/testing/index.js`, `dist/types/**` (`hono-base`, `request`, `validator`, `client/*`, `helper/{testing,factory,route,adapter}`, `middleware/*`, `adapter/*`), `package.json` `exports` |
| `@hono/zod-validator` | 0.9.1 | `npm pack`, extracted | `package.json` peers, `dist/index.d.mts` |
| `@hono/valibot-validator` | 0.6.2 | same | peers, `dist/index.d.mts` |
| `@hono/standard-validator` | 0.4.1 | same | peers, `dist/index.d.mts` |
| `@hono/zod-openapi` | 1.6.3 | same | peers, `dist/index.d.mts` (`OpenAPIHono`, `createRoute`, `doc`, `doc31`) |
| `@hono/node-server` | 2.1.5 | same | `package.json` `engines`, `peerDependencies`, `exports`; `dist/index.d.mts` `serve` |
| release notes | `v4.0.0`–`v4.13.0` | `gh api repos/honojs/hono/releases/tags/<tag>` | the minors table in `versions.md` |
| docs | hono.dev | `curl` of `/docs/getting-started/{nodejs,bun,deno,cloudflare-workers}` | the runtime entry shapes in `versions.md`; the Workers "Bindings" paragraph |

The pins are those of the plugin contract. Packages and TypeScript used by the probes below:
`vitest@5.0.5`, `typescript@6.0.3`, `zod@4.6.7`, `valibot@1.5.0`, `@types/node@24`.

## Behaviour probes

A scratch project outside the repository (`hono@4.13.16` plus the packages above) ran
Vitest tests that call `app.request(...)`, and `tsc --noEmit` over files using
`@ts-expect-error` so a type that stopped erroring would fail the build. Results quoted in the
skills:

| Claim | Result |
|---|---|
| `v1.route('/integrations/google-calendar', gcal)` before `v1.route('/integrations', integrations)` with `integrations.use('*', mw)` | `app.routes` = `GET /v1/integrations/google-calendar/events`, `ALL /v1/integrations/*`, `GET /v1/integrations/list`; `mw` ran for `/list`, not for `google-calendar/events` |
| `route()` copies at call time | route added to the child afterwards → 404 through the parent |
| `basePath()` shares the table | `app.routes[0].path` = `/api/x` after `app.basePath('/api').get('/x')` |
| nested `basePath('/cms')` under `route('/admin')` under `route('/v1')` | `GET /v1/admin/cms/pages/:id` |
| `use()` after a route or after a `route()` mount | does not run for it |
| `cors()` before / after an auth middleware, preflight | 204 / 401 |
| un-awaited `next()` | 200, response header set after it missing |
| middleware that neither calls `next()` nor responds | 500, `Context is not finalized...` |
| child `onError` before / after `route()` | child handler / parent default |
| same method and path twice; `/users/:id` before `/users/me` | first registration answers |
| `/x/` against `/x`, strict and `strict: false` | 404 / 200 |
| route added after the first request | `Can not add a route since the matcher is already built.` |
| `app.mount('/ext', h)`, `app.all('/ext2/*', mount(h))` | both `ALL .../*`, handler sees the path without the prefix |
| `routePath(c)`, `baseRoutePath(c)` from `hono/route` | `/v1/things/:id`, `/v1/things` |
| validator targets: query array, coerce, param uuid, header casing, form, malformed JSON, missing `Content-Type`, hooks | see `hono-validation/references/validation.md` §2 |
| `OpenAPIHono` route table and document | `GET /v1/users/:id` twice, `paths` key `/v1/users/{id}` |
| chained vs statement-style app type; `basePath` in the client path; `$path()` literal type; wrong `json` input | compile results in `hono-rpc/references/rpc.md` |
| `c.json(x)` without a status | `res.status` is `ContentfulStatusCode`, not `200` (first draft of the skill claimed `200`; the probe corrected it) |
| `app.request` forms; `c.env` without a third argument; missing `ExecutionContext`; `testClient` with env; HEAD; wrong method | `hono-testing/references/testing.md` §1–2 |
| `deno test` with `app.request` and `testClient` | 2 passed on hono 4.12.0 (4.13.16 was newer than Deno's minimum dependency age on the day of the run; the check was not bypassed) |

## Not verified here

- `@hono/zod-openapi` runtime behaviour beyond the probe above (hooks, `defaultHook`).
- Bun: the entry shape comes from hono.dev only; Bun was not run.
- Cloudflare: `nodejs_compat` and `process.env` on Workers (rule C001) are Cloudflare behaviour,
  not Hono's; check Cloudflare's documentation before editing `wrangler.*`.
- The behaviour of the plugin's own tools. The skills use the names, parameters and fields
  of the plugin contract; the tools are built beside this part and joined after.
