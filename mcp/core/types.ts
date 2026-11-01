/**
 * Shared types of hono-dev. The first half is the frozen contract every part of the plugin
 * relies on (names and fields must not change); the second half is core-internal.
 * File paths in every type are workspace-relative POSIX; AppId = `${file}#${localName}`.
 */

// ---------------------------------------------------------------------------
// Contract: detection
// ---------------------------------------------------------------------------

export type Runtime = "node" | "deno" | "bun" | "cloudflare-workers" | "unknown";
export type AppId = string;

export interface Detection {
  isHono: boolean;
  honoVersion: {
    declared: string | null;
    resolved: string | null;
    major: number | null;
    supported: boolean;
  };
  honoSpecifiers: string[];
  runtime: Runtime;
  runtimes: { runtime: Runtime; evidence: string[] }[];
  deployTargets: ("fly" | "docker" | "cloudflare" | "deno-deploy" | "vercel")[];
  entry: {
    file: string;
    app: AppId | null;
    serve: "node-server" | "deno-serve" | "bun-serve" | "export-default" | "unknown";
    line: number;
  } | null;
  configFiles: {
    packageJson: string | null;
    denoJson: string | null;
    tsconfig: string | null;
    wrangler: string | null;
    lockfile: string | null;
  };
  workspaceMembers: string[];
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Contract: routing model
// ---------------------------------------------------------------------------

export type Confidence = "extracted" | "inferred";

export interface HandlerRef {
  file: string;
  line: number;
  name: string | null;
}

export interface AppNode {
  id: AppId;
  file: string;
  local: string;
  line: number;
  ctor: "Hono" | "OpenAPIHono" | "derived";
  basePath: string;
  derivedFrom: AppId | null;
  exportedAs: string[];
  isRoot: boolean;
  errorHandler: HandlerRef | null;
  notFoundHandler: HandlerRef | null;
  strict: boolean;
}

export interface MountEdge {
  parent: AppId;
  child: AppId;
  prefix: string;
  kind: "route" | "basePath" | "mount";
  file: string;
  line: number;
  confidence: Confidence;
}

export interface MountHop {
  app: AppId;
  prefix: string;
  file: string;
  line: number;
}

export interface Registration {
  /** Stable: `${root ?? app}|${seq}`. */
  id: string;
  /** Root app whose final table holds this registration; null = orphan table. */
  root: AppId | null;
  seq: number;
  /** The instance the registration was made through. */
  app: AppId;
  method: string;
  fullPath: string;
  localPath: string;
  file: string;
  line: number;
  /** Mount hops from the root to the defining app. */
  mountChain: MountHop[];
  pathNonLiteral: boolean;
  reachable: boolean;
  confidence: Confidence;
  notes: string[];
}

export interface MiddlewareRef {
  name: string | null;
  source: string | null;
  isAuth: boolean;
  file: string;
  line: number;
}

export interface ValidatorRef {
  target: "json" | "form" | "query" | "param" | "header" | "cookie" | "unknown";
  library: "zod" | "valibot" | "standard-schema" | "typebox" | "arktype" | "custom" | "unknown";
  via: string;
  schema: string | null;
  scope: "route" | "mount";
  file: string;
  line: number;
}

export interface ChainStep {
  middlewareId: string | null;
  name: string | null;
  scope: "global" | "mount" | "route";
  isAuth: boolean;
  file: string;
  line: number;
  seq: number;
}

export interface EnvRead {
  key: string | null;
  api: "process.env" | "Deno.env.get" | "Bun.env" | "c.env" | "env(c)" | "import.meta.env";
  file: string;
  line: number;
  validated: boolean;
}

export interface EnvValidation {
  file: string;
  line: number;
  via: "zod" | "valibot" | "t3-env" | "envalid" | "custom";
  keys: string[] | "all";
}

export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralValue[]
  | { [k: string]: LiteralValue }
  | { $expr: string };

export interface HandlerFacts {
  file: string;
  line: number;
  kind: "inline" | "identifier" | "factory" | "unknown";
  resolved: string | null;
  bodyReads: {
    api: "json" | "parseBody" | "formData" | "text" | "arrayBuffer" | "blob";
    line: number;
  }[];
  validReads: { target: string; line: number }[];
  paramReads: { name: string | null; line: number }[];
  queryReads: { name: string | null; line: number }[];
  /** Every call into a DB client or into a file that imports one; A001 drops `serviceDirs`. */
  dbAccess: { via: string; source: string; line: number }[];
  envReads: EnvRead[];
  calls: { callee: string; resolved: string | null; line: number }[];
  throwsHttpException: boolean;
  /**
   * The handler hands `c`, `c.req` or `c.req.raw` to other code (an SDK, a controller), so what it
   * does with the body cannot be read from its own text. Absent when the handler was not analysed.
   */
  requestEscapes?: boolean;
}

export interface MiddlewareFnFacts {
  callsNext: boolean;
  awaitsOrReturnsNext: boolean;
  line: number;
  /** The function has a second parameter to call. Absent on facts cached before it existed. */
  declaresNext?: boolean;
  /** `next` is used as a value (`mw(c, next)`), so the chain may continue without a direct call. */
  passesNext?: boolean;
  /** File that defines the function (differs from the registering file for imported middleware). */
  file?: string;
}

export interface RouteEntry extends Registration {
  kind: "route" | "mount";
  params: string[];
  handler: HandlerFacts | null;
  inline: MiddlewareRef[];
  validators: ValidatorRef[];
  chain: ChainStep[];
  unreached: ChainStep[];
  errorHandler: HandlerRef | null;
  openapi: boolean;
}

export interface MiddlewareEntry extends Registration {
  name: string | null;
  source: string | null;
  kind: "builtin" | "third-party" | "local" | "inline";
  isAuth: boolean;
  options: LiteralValue | null;
  fn: MiddlewareFnFacts | null;
  registeredAfterRoutes: string[];
}

// ---------------------------------------------------------------------------
// Contract: rpc, graph, trace, impact, export
// ---------------------------------------------------------------------------

export interface RpcInfo {
  appTypes: {
    name: string;
    file: string;
    line: number;
    target: AppId | null;
    chained: boolean;
    routeCount: number;
  }[];
  clients: {
    file: string;
    line: number;
    typeArg: string | null;
    appType: string | null;
    baseUrl: string | null;
  }[];
}

export interface ImportGraph {
  importsOf: Map<string, { target: string; line: number; dynamic: boolean; typeOnly: boolean }[]>;
  importedBy: Map<string, string[]>;
  externalsOf: Map<string, { specifier: string; canonical: string; line: number }[]>;
  unresolved: { file: string; specifier: string; line: number; reason: string }[];
}

export interface ImportFact {
  specifier: string;
  names: { imported: string; local: string; isType: boolean }[];
  default: string | null;
  namespace: string | null;
  isTypeOnly: boolean;
  dynamic: boolean;
  reexport: boolean;
  line: number;
  resolved: string | null;
  canonical: string | null;
}

export interface TraceResult {
  method: string;
  path: string;
  root: AppId | null;
  steps: {
    kind: "middleware" | "handler";
    entryId: string;
    name: string | null;
    file: string;
    line: number;
    params: Record<string, string>;
    reached: boolean;
  }[];
  handler: RouteEntry | null;
  params: Record<string, string>;
  errorHandler: HandlerRef | null;
  notFound: boolean;
  allowedMethods: string[];
}

export interface ImpactResult {
  files: string[];
  apps: AppId[];
  routes: { id: string; method: string; fullPath: string; file: string; why: string[] }[];
  middlewares: { id: string; fullPath: string; why: string[] }[];
  rpcTypes: string[];
  tests: string[];
  suggestedChecks: string[];
}

export interface ExportResult {
  ok: true;
  path: string;
  nodes: number;
  links: number;
  byRelation: Record<string, number>;
  livespecSnippet: string;
}

// ---------------------------------------------------------------------------
// Contract: validators and config
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";
export type Category =
  | "routes"
  | "middleware"
  | "validation"
  | "security"
  | "architecture"
  | "rpc"
  | "conventions";

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number | null;
  message: string;
  hint: string | null;
  confidence: Confidence;
  source: "hono-dev";
  route?: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    unverified: string[];
    categories: Category[];
  };
}

export interface HonoDevConfig {
  ignore: string[];
  maxFileBytes: number;
  entry: string | null;
  dbSpecifiers: string[];
  authMiddleware: string[];
  serviceDirs: string[];
  envValidationModules: string[];
}

// ---------------------------------------------------------------------------
// Core-internal: syntactic facts (one ModuleFacts per source file, cacheable as JSON)
// ---------------------------------------------------------------------------

export interface IndexStats {
  files: number;
  parsed: number;
  reused: number;
  removed: number;
  ms: number;
  builtAt: string;
}

/** A path argument: a literal string, or the source text of a non-literal expression. */
export interface PathValue {
  value: string;
  literal: boolean;
}

export interface ArgFact {
  kind: "function" | "identifier" | "call" | "other";
  text: string;
  line: number;
  spread: boolean;
  /** Identifier name, member-access last segment, or callee name. */
  name: string | null;
  /** First identifier of the expression (resolved through the module's imports). */
  root: string | null;
  callee: string | null;
  /** Arguments of a call as literals. */
  literals: LiteralValue[];
  args: ArgFact[];
  fn: RawFn | null;
}

export interface RawFn {
  line: number;
  endLine: number;
  isAsync: boolean;
  nextParam: string | null;
  ctxParam: string | null;
  callsNext: boolean;
  awaitsOrReturnsNext: boolean;
  bodyReads: HandlerFacts["bodyReads"];
  validReads: HandlerFacts["validReads"];
  paramReads: HandlerFacts["paramReads"];
  queryReads: HandlerFacts["queryReads"];
  calls: { callee: string; root: string | null; line: number }[];
  throwsHttpException: boolean;
  /** Error responses that expose `err.message`, `err.stack` or the raw error (onError bodies). */
  leaksError: boolean;
  /** The `next` parameter is used other than as the callee of a call (passed on, returned). */
  nextPassed: boolean;
  /** `c`, `c.req` or `c.req.raw` is handed to non-Hono code, or `c.req.raw` is used beyond headers. */
  requestEscapes: boolean;
}

export interface InstanceFact {
  local: string;
  ctor: "Hono" | "OpenAPIHono" | "derived";
  line: number;
  strict: boolean;
  derivedFrom: string | null;
  basePath: PathValue | null;
  /** Route-registering calls in the initializer chain (`const x = new Hono().get().post()`). */
  chainedOps: number;
  conditional: boolean;
}

export type RegVia =
  | "get"
  | "post"
  | "put"
  | "delete"
  | "options"
  | "patch"
  | "query"
  | "all"
  | "on"
  | "openapi"
  | "use"
  | "mount";

export interface OpenApiMeta {
  validators: { target: string; schema: string | null }[];
}

export type OpFact =
  | { op: "decl"; instance: InstanceFact }
  | {
      op: "reg";
      via: RegVia;
      target: string;
      line: number;
      conditional: boolean;
      methods: string[];
      /** One per path of `on(methods, paths)`; `use()` without a path yields `*`. */
      paths: PathValue[];
      args: ArgFact[];
      openapi: OpenApiMeta | null;
    }
  | {
      op: "route";
      target: string;
      line: number;
      conditional: boolean;
      prefix: PathValue;
      child: string | null;
      childText: string;
    }
  | {
      op: "error";
      target: string;
      line: number;
      conditional: boolean;
      handler: ArgFact | null;
    }
  | {
      op: "notfound";
      target: string;
      line: number;
      conditional: boolean;
      handler: ArgFact | null;
    };

export interface ExportFact {
  name: string;
  kind: "local" | "from" | "star";
  local: string | null;
  from: string | null;
  imported: string | null;
  isType: boolean;
  line: number;
}

export interface ServeFact {
  kind: "node-server" | "deno-serve" | "bun-serve" | "export-default";
  appRef: string | null;
  line: number;
}

export interface RpcTypeFact {
  name: string;
  /** The identifier named by `typeof x`. */
  target: string | null;
  line: number;
  exported: boolean;
}

export interface HcCallFact {
  line: number;
  typeArg: string | null;
  baseUrl: string | null;
}

export interface EnvValidationFact {
  line: number;
  via: EnvValidation["via"];
  keys: string[] | "all";
}

export interface DeprecatedUseFact {
  api: "c.req.routePath" | "c.req.matchedRoutes" | "app.fire";
  line: number;
}

export interface ModuleFacts {
  path: string;
  isTest: boolean;
  imports: ImportFact[];
  envReads: EnvRead[];
  parseErrors: string[];
  size: number;
  mtime: number;
  exports: ExportFact[];
  ops: OpFact[];
  /** `const route = app.get(...)`: another name for the same instance, with its chained-op count. */
  aliases: Record<string, { target: string; chainedOps: number }>;
  functions: Record<string, RawFn>;
  /** Module-level variables, used to tell DB clients from plain values. */
  topLevelValues: string[];
  /** Same-module `const NAME = "literal"` values, used to resolve route prefixes. */
  constants: Record<string, string>;
  serves: ServeFact[];
  rpcTypes: RpcTypeFact[];
  hcCalls: HcCallFact[];
  envValidations: EnvValidationFact[];
  /** Every `new Hono()`-like declaration, including those inside function bodies. */
  instanceDeclsInFunctions: number;
  /** Member-access uses of APIs Hono marks `@deprecated` that no other fact records. */
  deprecatedUses: DeprecatedUseFact[];
}
