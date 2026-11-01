/**
 * Syntactic extraction of Hono facts from one module. Only `ts.createSourceFile` is used: no
 * Program and no type checker, so the facts are cheap, cacheable as JSON and independent of the
 * rest of the project. Import resolution and the app simulation happen later (compose.ts).
 */
import ts from "typescript";
import { TEST_FILE_PATTERN } from "./fs.ts";
import { canonicalSpecifier } from "./resolve.ts";
import type {
  ArgFact,
  EnvRead,
  DeprecatedUseFact,
  EnvValidationFact,
  ExportFact,
  HcCallFact,
  ImportFact,
  InstanceFact,
  LiteralValue,
  ModuleFacts,
  OpenApiMeta,
  OpFact,
  PathValue,
  RawFn,
  RegVia,
  RpcTypeFact,
  ServeFact,
} from "./types.ts";

/** Bump when the shape or the meaning of ModuleFacts changes: invalidates the facts cache. */
export const PARSER_VERSION = 4;

const HTTP_METHODS = ["get", "post", "put", "delete", "options", "patch", "query"] as const;
const CHAIN_RETURNING_THIS = new Set(["onError", "notFound", "mount", "use", "route", "on", "all"]);
const BODY_APIS = ["json", "parseBody", "formData", "text", "arrayBuffer", "blob"] as const;
const CONTEXT_NAMES = new Set(["c", "ctx", "context"]);
const RESPONDERS = new Set(["json", "text", "html", "body", "newResponse", "redirect"]);
/** Members of `c.req.raw` that read request metadata or consume the body through a known API. */
const RAW_REQUEST_SAFE = new Set([
  "headers",
  "url",
  "method",
  "signal",
  "json",
  "text",
  "formData",
  "arrayBuffer",
  "blob",
]);

type Node = ts.Node;
type Expr = ts.Expression;

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function skipWrappers(e: Expr): Expr {
  let cur = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isAwaitExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    } else return cur;
  }
}

function isFunctionLike(e: Node): e is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e);
}

function modifierKinds(node: Node): Set<ts.SyntaxKind> {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return new Set((mods ?? []).map((m) => m.kind));
}

class Extractor {
  readonly sf: ts.SourceFile;
  readonly path: string;
  readonly imports: ImportFact[] = [];
  readonly exports: ExportFact[] = [];
  readonly ops: OpFact[] = [];
  readonly functions: Record<string, RawFn> = {};
  readonly topLevelValues: string[] = [];
  readonly constants: Record<string, string> = {};
  readonly aliases: Record<string, { target: string; chainedOps: number }> = {};
  readonly serves: ServeFact[] = [];
  readonly rpcTypes: RpcTypeFact[] = [];
  readonly hcCalls: HcCallFact[] = [];
  readonly envReads: EnvRead[] = [];
  readonly envValidations: EnvValidationFact[] = [];
  readonly deprecatedUses: DeprecatedUseFact[] = [];
  instanceDeclsInFunctions = 0;
  private readonly sticky = new Map<string, PathValue>();
  private readonly ctorLocals = new Map<string, "Hono" | "OpenAPIHono">();
  private readonly importedFrom = new Map<string, { canonical: string; imported: string }>();
  private readonly routeDefs = new Map<
    string,
    { method: string; path: PathValue; validators: OpenApiMeta["validators"] }
  >();
  private readonly schemaDecls = new Map<string, ts.Expression>();
  private readonly validatedRanges: [number, number][] = [];
  /** `const secret = process.env.X`: the local name, the function it lives in, and the read. */
  private readonly envBindings: { name: string; scope: Node; read: number }[] = [];

  constructor(path: string, text: string) {
    this.path = path;
    this.sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  }

  lineOf(node: Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1;
  }

  endLineOf(node: Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  }

  textOf(node: Node, max = 120): string {
    const t = node.getText(this.sf).replace(/\s+/g, " ");
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  run(): void {
    this.collectImports();
    this.prescan();
    this.visitStatements(this.sf.statements, false);
    this.scanAll(this.sf);
    this.markValidatedEnvReads();
    this.markGuardedEnvReads();
  }

  parseErrors(): string[] {
    const diags = (this.sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    return (diags ?? []).slice(0, 5).map((d) => {
      const { line } = this.sf.getLineAndCharacterOfPosition(d.start ?? 0);
      return `L${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  }

  // -------------------------------------------------------------------------
  // imports / exports
  // -------------------------------------------------------------------------

  private addImport(partial: Partial<ImportFact> & { specifier: string; line: number }): void {
    this.imports.push({
      names: [],
      default: null,
      namespace: null,
      isTypeOnly: false,
      dynamic: false,
      reexport: false,
      resolved: null,
      canonical: null,
      ...partial,
    });
  }

  private collectImports(): void {
    for (const st of this.sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const specifier = st.moduleSpecifier.text;
        const clause = st.importClause;
        const names: ImportFact["names"] = [];
        let def: string | null = null;
        let ns: string | null = null;
        if (clause?.name) def = clause.name.text;
        const nb = clause?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) ns = nb.name.text;
        else if (nb) {
          for (const el of nb.elements) {
            names.push({
              imported: (el.propertyName ?? el.name).text,
              local: el.name.text,
              isType: !!clause?.isTypeOnly || el.isTypeOnly,
            });
          }
        }
        this.addImport({
          specifier,
          names,
          default: def,
          namespace: ns,
          isTypeOnly:
            !!clause?.isTypeOnly ||
            (!def && !ns && names.length > 0 && names.every((n) => n.isType)),
          line: this.lineOf(st),
        });
        const canonical = canonicalSpecifier(specifier);
        if (def) this.importedFrom.set(def, { canonical, imported: "default" });
        for (const n of names) this.importedFrom.set(n.local, { canonical, imported: n.imported });
        if (ns) this.importedFrom.set(ns, { canonical, imported: "*" });
        for (const n of names) {
          if (n.isType) continue;
          const c = canonical;
          if (n.imported === "Hono" && (c === "hono" || c.startsWith("hono/"))) {
            this.ctorLocals.set(n.local, "Hono");
          }
          if (n.imported === "OpenAPIHono") this.ctorLocals.set(n.local, "OpenAPIHono");
        }
      } else if (
        ts.isExportDeclaration(st) &&
        st.moduleSpecifier &&
        ts.isStringLiteral(st.moduleSpecifier)
      ) {
        this.addImport({
          specifier: st.moduleSpecifier.text,
          reexport: true,
          isTypeOnly: st.isTypeOnly,
          line: this.lineOf(st),
        });
      }
    }
  }

  private collectExports(st: Node): void {
    const mods = modifierKinds(st);
    const exported = mods.has(ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.has(ts.SyntaxKind.DefaultKeyword);
    const line = this.lineOf(st);
    if (ts.isVariableStatement(st) && exported) {
      for (const d of st.declarationList.declarations) {
        for (const name of bindingNames(d.name)) {
          this.exports.push({
            name,
            kind: "local",
            local: name,
            from: null,
            imported: null,
            isType: false,
            line,
          });
        }
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && exported) {
      const local = st.name?.text ?? null;
      this.exports.push({
        name: isDefault ? "default" : (local ?? "default"),
        kind: "local",
        local,
        from: null,
        imported: null,
        isType: false,
        line,
      });
    } else if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) && exported) {
      this.exports.push({
        name: st.name.text,
        kind: "local",
        local: st.name.text,
        from: null,
        imported: null,
        isType: true,
        line,
      });
    } else if (ts.isExportDeclaration(st)) {
      const from =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      const clause = st.exportClause;
      if (!clause) {
        if (from)
          this.exports.push({
            name: "*",
            kind: "star",
            local: null,
            from,
            imported: null,
            isType: st.isTypeOnly,
            line,
          });
      } else if (ts.isNamespaceExport(clause)) {
        if (from)
          this.exports.push({
            name: clause.name.text,
            kind: "from",
            local: null,
            from,
            imported: "*",
            isType: st.isTypeOnly,
            line,
          });
      } else {
        for (const el of clause.elements) {
          const name = el.name.text;
          const source = (el.propertyName ?? el.name).text;
          const isType = st.isTypeOnly || el.isTypeOnly;
          if (from)
            this.exports.push({
              name,
              kind: "from",
              local: null,
              from,
              imported: source,
              isType,
              line,
            });
          else
            this.exports.push({
              name,
              kind: "local",
              local: source,
              from: null,
              imported: null,
              isType,
              line,
            });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // prescan: constants, route definitions, schema declarations, top-level values
  // -------------------------------------------------------------------------

  private prescan(): void {
    for (const st of this.sf.statements) {
      this.collectExports(st);
      if (ts.isFunctionDeclaration(st) && st.name && st.body) {
        this.functions[st.name.text] = this.analyzeFn(st);
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) {
            for (const n of bindingNames(d.name)) this.topLevelValues.push(n);
            continue;
          }
          const name = d.name.text;
          const init = skipWrappers(d.initializer);
          if (isFunctionLike(init)) {
            this.functions[name] = this.analyzeFn(init);
            continue;
          }
          this.topLevelValues.push(name);
          const str = this.stringOf(init);
          if (str !== null && st.declarationList.flags & ts.NodeFlags.Const)
            this.constants[name] = str;
          if (ts.isCallExpression(init)) {
            const calleeName = calleeLastName(init);
            if (calleeName === "createMiddleware" || calleeName === "createHandlers") {
              const fnArg = init.arguments.map(skipWrappers).find(isFunctionLike);
              if (fnArg) this.functions[name] = this.analyzeFn(fnArg);
            }
            if (calleeName === "createRoute" && init.arguments[0]) {
              const def = this.readRouteDef(init.arguments[0]);
              if (def) this.routeDefs.set(name, def);
            }
          }
          this.schemaDecls.set(name, init);
        }
      }
      if (ts.isTypeAliasDeclaration(st) && ts.isTypeQueryNode(st.type)) {
        const target = firstEntityName(st.type.exprName);
        this.rpcTypes.push({
          name: st.name.text,
          target,
          line: this.lineOf(st),
          exported: modifierKinds(st).has(ts.SyntaxKind.ExportKeyword),
        });
      }
    }
  }

  private stringOf(e: Expr): string | null {
    const x = skipWrappers(e);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
    return null;
  }

  private readRouteDef(
    arg: Expr,
  ): { method: string; path: PathValue; validators: OpenApiMeta["validators"] } | null {
    const obj = skipWrappers(arg);
    if (!ts.isObjectLiteralExpression(obj)) return null;
    let method: string | null = null;
    let path: PathValue | null = null;
    const validators: OpenApiMeta["validators"] = [];
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
      if (p.name.text === "method") method = this.stringOf(p.initializer)?.toUpperCase() ?? null;
      if (p.name.text === "path") {
        const s = this.stringOf(p.initializer);
        if (s !== null) path = { value: s.replace(/\{([^}]+)\}/g, ":$1"), literal: true };
      }
      if (p.name.text === "request") {
        const req = skipWrappers(p.initializer);
        if (!ts.isObjectLiteralExpression(req)) continue;
        for (const rp of req.properties) {
          if (!ts.isPropertyAssignment(rp) || !ts.isIdentifier(rp.name)) continue;
          const key = rp.name.text;
          const target =
            key === "body"
              ? bodyTarget(rp.initializer)
              : (
                  {
                    params: "param",
                    query: "query",
                    headers: "header",
                    cookies: "cookie",
                  } as Record<string, string>
                )[key];
          if (target)
            validators.push({
              target,
              schema: ts.isIdentifier(rp.initializer) ? rp.initializer.text : null,
            });
        }
      }
    }
    if (!method || !path) return null;
    return { method, path, validators };
  }

  // -------------------------------------------------------------------------
  // statements → ops
  // -------------------------------------------------------------------------

  private visitStatements(stmts: readonly ts.Statement[], conditional: boolean): void {
    for (const st of stmts) this.visitStatement(st, conditional);
  }

  private visitStatement(st: ts.Statement, conditional: boolean): void {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = skipWrappers(d.initializer);
        if (ts.isIdentifier(init)) {
          this.aliases[d.name.text] = { target: init.text, chainedOps: 0 };
          continue;
        }
        this.processChain(init, conditional, d.name.text);
      }
    } else if (ts.isExpressionStatement(st)) {
      this.processChain(skipWrappers(st.expression), conditional, null);
    } else if (ts.isExportAssignment(st)) {
      this.visitExportDefault(st, conditional);
    } else if (ts.isIfStatement(st)) {
      this.visitBranch(st.thenStatement);
      if (st.elseStatement) this.visitBranch(st.elseStatement);
    } else if (ts.isBlock(st)) {
      this.visitStatements(st.statements, conditional);
    } else if (ts.isTryStatement(st)) {
      this.visitStatements(st.tryBlock.statements, true);
      if (st.catchClause) this.visitStatements(st.catchClause.block.statements, true);
      if (st.finallyBlock) this.visitStatements(st.finallyBlock.statements, true);
    } else if (
      ts.isForStatement(st) ||
      ts.isForOfStatement(st) ||
      ts.isForInStatement(st) ||
      ts.isWhileStatement(st)
    ) {
      this.visitBranch(st.statement);
    }
  }

  private visitBranch(st: ts.Statement): void {
    if (ts.isBlock(st)) this.visitStatements(st.statements, true);
    else this.visitStatement(st, true);
  }

  private visitExportDefault(st: ts.ExportAssignment, conditional: boolean): void {
    const e = skipWrappers(st.expression);
    const line = this.lineOf(st);
    if (ts.isIdentifier(e)) {
      this.exports.push({
        name: "default",
        kind: "local",
        local: e.text,
        from: null,
        imported: null,
        isType: false,
        line,
      });
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      const ref = fetchOwner(e);
      this.exports.push({
        name: "default",
        kind: "local",
        local: null,
        from: null,
        imported: null,
        isType: false,
        line,
      });
      if (ref) this.serves.push({ kind: "export-default", appRef: ref, line });
      return;
    }
    const made = this.processChain(e, conditional, "default");
    if (made) {
      this.exports.push({
        name: "default",
        kind: "local",
        local: "default",
        from: null,
        imported: null,
        isType: false,
        line,
      });
    } else {
      this.exports.push({
        name: "default",
        kind: "local",
        local: null,
        from: null,
        imported: null,
        isType: false,
        line,
      });
    }
  }

  private newSynthetic(prefix: string, node: Node): string {
    const { line, character } = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    return `$${prefix}:${line + 1}:${character + 1}`;
  }

  private ctorOf(root: Expr): { ctor: "Hono" | "OpenAPIHono"; strict: boolean } | null {
    if (!ts.isNewExpression(root)) return null;
    const callee = root.expression;
    if (!ts.isIdentifier(callee)) return null;
    const mapped = this.ctorLocals.get(callee.text);
    const ctor =
      mapped ?? (callee.text === "Hono" || callee.text === "OpenAPIHono" ? callee.text : null);
    if (!ctor) return null;
    let strict = true;
    const opts = root.arguments?.[0] && skipWrappers(root.arguments[0]);
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "strict" &&
          p.initializer.kind === ts.SyntaxKind.FalseKeyword
        ) {
          strict = false;
        }
      }
    }
    return { ctor, strict };
  }

  /**
   * Walk a call chain such as `new Hono().basePath("/a").get(...).post(...)` or `app.use(...)`
   * and emit the ops it performs, in order. Returns the local name the chain evaluates to.
   */
  private processChain(expr: Expr, conditional: boolean, bind: string | null): string | null {
    let root = skipWrappers(expr);
    const calls: ts.CallExpression[] = [];
    while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)) {
      calls.unshift(root);
      root = skipWrappers(root.expression.expression);
    }
    let ctorInfo = this.ctorOf(root);
    // `createFactory().createApp()` returns a Hono instance.
    if (
      !ctorInfo &&
      ts.isIdentifier(root) &&
      calls[0] &&
      callName(calls[0]) === "createApp" &&
      calls[0].arguments.length === 0
    ) {
      calls.shift();
      ctorInfo = { ctor: "Hono", strict: true };
    }
    const isCreation = ctorInfo !== null;
    if (!isCreation && !ts.isIdentifier(root)) return null;
    if (!isCreation && calls.length === 0) return null;
    if (!isCreation && !calls.some((c) => isInstanceMethod(callName(c)))) return null;

    const lastBase = calls.map(callName).lastIndexOf("basePath");
    let current: string;
    let created: InstanceFact | null = null;
    if (ctorInfo) {
      const local = lastBase === -1 && bind ? bind : this.newSynthetic("anon", root);
      created = {
        local,
        ctor: ctorInfo.ctor,
        line: this.lineOf(root),
        strict: ctorInfo.strict,
        derivedFrom: null,
        basePath: null,
        chainedOps: 0,
        conditional,
      };
      this.ops.push({ op: "decl", instance: created });
      current = local;
    } else {
      current = (root as ts.Identifier).text;
    }

    let routeOps = 0;
    let last: InstanceFact | null = created;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const name = callName(call);
      const line = this.lineOf(call);
      if (name === "basePath") {
        const arg = call.arguments[0];
        const local = i === lastBase && bind ? bind : this.newSynthetic("derived", call);
        const inst: InstanceFact = {
          local,
          ctor: "derived",
          line,
          strict: true,
          derivedFrom: current,
          basePath: arg ? this.pathOf(arg) : { value: "/", literal: true },
          chainedOps: 0,
          conditional,
        };
        this.ops.push({ op: "decl", instance: inst });
        current = local;
        last = inst;
        continue;
      }
      if (name === "route") {
        const [prefixArg, childArg] = call.arguments;
        const childExpr = childArg ? skipWrappers(childArg) : null;
        let child: string | null = null;
        if (childExpr && (ts.isIdentifier(childExpr) || ts.isPropertyAccessExpression(childExpr))) {
          child = this.textOf(childExpr);
        } else if (childExpr) {
          // inline sub-app: `app.route("/x", new Hono().get(...))`
          const synth = this.processChain(
            childExpr,
            conditional,
            this.newSynthetic("inline", childExpr),
          );
          child = synth;
        }
        this.ops.push({
          op: "route",
          target: current,
          line,
          conditional,
          prefix: prefixArg ? this.pathOf(prefixArg) : { value: "/", literal: true },
          child,
          childText: childExpr ? this.textOf(childExpr) : "",
        });
        routeOps++;
        continue;
      }
      if (name === "onError" || name === "notFound") {
        const h = call.arguments[0];
        this.ops.push({
          op: name === "onError" ? "error" : "notfound",
          target: current,
          line,
          conditional,
          handler: h ? this.analyzeArg(h) : null,
        });
        continue;
      }
      const via = regVia(name);
      if (via) {
        this.pushRegistration(via, name, call, current, conditional);
        if (via !== "use" && via !== "mount") routeOps++;
        continue;
      }
      if (name === "doc" || name === "doc31") {
        const arg = call.arguments[0];
        this.ops.push({
          op: "reg",
          via: "get",
          target: current,
          line,
          conditional,
          methods: ["GET"],
          paths: [arg ? this.pathOf(arg) : { value: "/doc", literal: false }],
          // OpenAPIHono registers the document route itself (hono-base `get` with a generated handler)
          args: [
            {
              kind: "other",
              text: "openapi document handler",
              line,
              spread: false,
              name: "openapiDoc",
              root: null,
              callee: null,
              literals: [],
              args: [],
              fn: null,
            },
          ],
          openapi: null,
        });
        continue;
      }
      if (CHAIN_RETURNING_THIS.has(name)) continue;
      break; // a method that does not return the app (`fetch`, `request`, ...): the chain ends
    }
    if (bind) {
      if (last && last.local === bind) last.chainedOps = routeOps;
      else if (current !== bind) this.aliases[bind] = { target: current, chainedOps: routeOps };
    }
    return current;
  }

  private pushRegistration(
    via: RegVia,
    name: string,
    call: ts.CallExpression,
    target: string,
    conditional: boolean,
  ): void {
    const line = this.lineOf(call);
    const argNodes = [...call.arguments];
    const isPathLike = (a: Expr | undefined) => {
      if (!a) return false;
      const x = skipWrappers(a);
      if (
        ts.isStringLiteral(x) ||
        ts.isNoSubstitutionTemplateLiteral(x) ||
        ts.isTemplateExpression(x)
      )
        return true;
      if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
      if (ts.isIdentifier(x) && x.text in this.constants) return true;
      // `app.get(ROUTES.users, handler)`: a member access followed by more arguments is a path
      return (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && argNodes.length >= 2;
    };

    if (via === "on") {
      const [m, p, ...rest] = argNodes;
      const methods = m ? stringsOf(skipWrappers(m)) : null;
      const paths = p ? pathsOf(this, skipWrappers(p)) : [{ value: "/", literal: false }];
      for (const pv of paths) this.sticky.set(target, pv);
      this.ops.push({
        op: "reg",
        via,
        target,
        line,
        conditional,
        methods: (methods ?? ["ALL"]).map((x) => x.toUpperCase()),
        paths,
        args: rest.map((a) => this.analyzeArg(a)),
        openapi: null,
      });
      return;
    }

    if (via === "use") {
      let path: PathValue = { value: "*", literal: true };
      let handlers = argNodes;
      if (argNodes[0] && isStringArg(this, argNodes[0])) {
        path = this.pathOf(argNodes[0]);
        handlers = argNodes.slice(1);
      }
      this.sticky.set(target, path);
      this.ops.push({
        op: "reg",
        via,
        target,
        line,
        conditional,
        methods: ["ALL"],
        paths: [path],
        args: handlers.map((a) => this.analyzeArg(a)),
        openapi: null,
      });
      return;
    }

    if (via === "mount") {
      const [p, fetchArg] = argNodes;
      this.ops.push({
        op: "reg",
        via,
        target,
        line,
        conditional,
        methods: ["ALL"],
        paths: [p ? this.pathOf(p) : { value: "/", literal: false }],
        args: fetchArg ? [this.analyzeArg(fetchArg)] : [],
        openapi: null,
      });
      return;
    }

    if (via === "openapi") {
      const [def, ...handlers] = argNodes;
      const defExpr = def ? skipWrappers(def) : null;
      let resolved: ReturnType<Extractor["readRouteDef"]> = null;
      if (defExpr && ts.isIdentifier(defExpr)) resolved = this.routeDefs.get(defExpr.text) ?? null;
      else if (
        defExpr &&
        ts.isCallExpression(defExpr) &&
        calleeLastName(defExpr) === "createRoute" &&
        defExpr.arguments[0]
      ) {
        resolved = this.readRouteDef(defExpr.arguments[0]);
      }
      this.ops.push({
        op: "reg",
        via,
        target,
        line,
        conditional,
        methods: [resolved?.method ?? "GET"],
        paths: [resolved?.path ?? { value: defExpr ? this.textOf(defExpr) : "?", literal: false }],
        args: handlers.slice(0, 1).map((a) => this.analyzeArg(a)),
        openapi: { validators: resolved?.validators ?? [] },
      });
      return;
    }

    // get/post/put/delete/options/patch/query/all
    let path: PathValue;
    let handlers = argNodes;
    if (isPathLike(argNodes[0])) {
      path = this.pathOf(argNodes[0]);
      handlers = argNodes.slice(1);
      this.sticky.set(target, path);
    } else {
      path = this.sticky.get(target) ?? { value: "/", literal: true };
    }
    this.ops.push({
      op: "reg",
      via,
      target,
      line,
      conditional,
      methods: [via === "all" ? "ALL" : name.toUpperCase()],
      paths: [path],
      args: handlers.map((a) => this.analyzeArg(a)),
      openapi: null,
    });
  }

  /** A path argument as written: literal when it is (or concatenates) string literals. */
  pathOf(arg: Expr): PathValue {
    const x = skipWrappers(arg);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x))
      return { value: x.text, literal: true };
    if (ts.isIdentifier(x) && x.text in this.constants)
      return { value: this.constants[x.text], literal: true };
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.pathOf(x.left);
      const r = this.pathOf(x.right);
      if (l.literal && r.literal) return { value: l.value + r.value, literal: true };
    }
    return { value: this.textOf(x), literal: false };
  }

  // -------------------------------------------------------------------------
  // arguments, literals and function bodies
  // -------------------------------------------------------------------------

  analyzeArg(arg: Expr, depth = 0): ArgFact {
    const spread = ts.isSpreadElement(arg);
    const e = skipWrappers(spread ? arg.expression : arg);
    const base = { text: this.textOf(arg), line: this.lineOf(arg), spread };
    if (isFunctionLike(e)) {
      const name = ts.isFunctionExpression(e) && e.name ? e.name.text : null;
      return {
        ...base,
        kind: "function",
        name,
        root: null,
        callee: null,
        literals: [],
        args: [],
        fn: this.analyzeFn(e),
      };
    }
    if (ts.isIdentifier(e)) {
      return {
        ...base,
        kind: "identifier",
        name: e.text,
        root: e.text,
        callee: null,
        literals: [],
        args: [],
        fn: null,
      };
    }
    if (ts.isPropertyAccessExpression(e)) {
      return {
        ...base,
        kind: "identifier",
        name: e.name.text,
        root: rootIdentifier(e),
        callee: null,
        literals: [],
        args: [],
        fn: null,
      };
    }
    if (ts.isCallExpression(e)) {
      const calleeText = this.textOf(e.expression);
      const fnArg = e.arguments.map(skipWrappers).find(isFunctionLike);
      return {
        ...base,
        kind: "call",
        name: calleeLastName(e),
        root: rootIdentifier(e.expression),
        callee: calleeText,
        literals: e.arguments.map((a) => this.literal(a)),
        args: depth < 2 ? e.arguments.map((a) => this.analyzeArg(a, depth + 1)) : [],
        fn: fnArg ? this.analyzeFn(fnArg) : null,
      };
    }
    return {
      ...base,
      kind: "other",
      name: null,
      root: rootIdentifier(e),
      callee: null,
      literals: [],
      args: [],
      fn: null,
    };
  }

  literal(arg: Expr): LiteralValue {
    const e = skipWrappers(arg);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (e.kind === ts.SyntaxKind.NullKeyword) return null;
    if (
      ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(e.operand)
    ) {
      return -Number(e.operand.text);
    }
    if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => this.literal(x));
    if (ts.isObjectLiteralExpression(e)) {
      const out: { [k: string]: LiteralValue } = {};
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          out[p.name.text] = this.literal(p.initializer);
        } else if (ts.isShorthandPropertyAssignment(p)) {
          out[p.name.text] = { $expr: p.name.text };
        } else if (ts.isSpreadAssignment(p)) {
          out["..."] = { $expr: this.textOf(p.expression) };
        }
      }
      return out;
    }
    return { $expr: this.textOf(e) };
  }

  /** Summarise a function body: body reads, validated reads, params, calls, `next()` usage. */
  analyzeFn(fn: ts.FunctionLikeDeclaration): RawFn {
    const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    const ctxParam = params[0] ?? null;
    const nextParam = params[1] ?? null;
    const errParam = params[0] ?? null;
    const out: RawFn = {
      line: this.lineOf(fn),
      endLine: this.endLineOf(fn),
      isAsync: modifierKinds(fn).has(ts.SyntaxKind.AsyncKeyword),
      nextParam,
      ctxParam,
      callsNext: false,
      awaitsOrReturnsNext: false,
      bodyReads: [],
      validReads: [],
      paramReads: [],
      queryReads: [],
      calls: [],
      throwsHttpException: false,
      leaksError: false,
      nextPassed: false,
      requestEscapes: false,
    };
    const body = fn.body;
    if (!body) return out;
    const isCtx = (name: string | null) =>
      name !== null && (name === ctxParam || (ctxParam === null && CONTEXT_NAMES.has(name)));
    const escapes = (arg: Expr): boolean => {
      const x = skipWrappers(ts.isSpreadElement(arg) ? arg.expression : arg);
      if (ts.isIdentifier(x)) return isCtx(x.text);
      const ch = memberChain(x);
      return (
        ch !== null &&
        isCtx(ch[0]) &&
        ch[1] === "req" &&
        (ch.length === 2 || (ch.length === 3 && ch[2] === "raw"))
      );
    };
    const visit = (n: Node, exempt: boolean): void => {
      if (
        nextParam &&
        ts.isIdentifier(n) &&
        n.text === nextParam &&
        !(ts.isCallExpression(n.parent) && n.parent.expression === n) &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
        !ts.isParameter(n.parent)
      ) {
        out.nextPassed = true;
      }
      if (ts.isPropertyAccessExpression(n)) {
        const ch = memberChain(n);
        if (ch && isCtx(ch[0]) && ch[1] === "req" && (ch.length === 3 ? ch[2] === "raw" : false)) {
          // `c.req.raw` beyond headers, url, method and the body readers hands the stream on
          const parent = n.parent;
          if (ts.isPropertyAccessExpression(parent) && parent.expression === n) {
            if (!RAW_REQUEST_SAFE.has(parent.name.text)) out.requestEscapes = true;
          } else if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) {
            out.requestEscapes = true;
          }
        } else if (
          ch &&
          ch.length === 2 &&
          isCtx(ch[0]) &&
          ch[1] === "req" &&
          !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) &&
          !ts.isCallExpression(n.parent) &&
          !ts.isNewExpression(n.parent)
        ) {
          out.requestEscapes = true; // `const req = c.req`
        }
      }
      if (ts.isIfStatement(n) && errParam && mentionsHttpException(n.expression, errParam)) {
        visit(n.expression, exempt);
        visit(n.thenStatement, true);
        if (n.elseStatement) visit(n.elseStatement, exempt);
        return;
      }
      if (ts.isNewExpression(n)) {
        if (ts.isIdentifier(n.expression) && n.expression.text === "HTTPException")
          out.throwsHttpException = true;
        const callee = this.textOf(n.expression);
        out.calls.push({ callee, root: rootIdentifier(n.expression), line: this.lineOf(n) });
        if ((n.arguments ?? []).some(escapes)) out.requestEscapes = true;
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const chain = memberChain(callee);
        const line = this.lineOf(n);
        if (nextParam && ts.isIdentifier(callee) && callee.text === nextParam) {
          out.callsNext = true;
          const parent = n.parent;
          if (
            ts.isAwaitExpression(parent) ||
            ts.isReturnStatement(parent) ||
            (ts.isArrowFunction(parent) && parent.body === n) ||
            ts.isParenthesizedExpression(parent)
          ) {
            out.awaitsOrReturnsNext = true;
          }
        }
        if (chain && isCtx(chain[0]) && chain[1] === "req") {
          const api = chain[chain.length - 1];
          const direct = chain.length === 3 || (chain.length === 4 && chain[2] === "raw");
          if (direct && (BODY_APIS as readonly string[]).includes(api)) {
            out.bodyReads.push({ api: api as RawFn["bodyReads"][number]["api"], line });
          }
          const first = n.arguments[0] ? this.stringOf(n.arguments[0]) : null;
          if (chain.length === 3 && api === "valid" && first)
            out.validReads.push({ target: first, line });
          if (chain.length === 3 && api === "param") out.paramReads.push({ name: first, line });
          if (chain.length === 3 && (api === "query" || api === "queries"))
            out.queryReads.push({ name: first, line });
        }
        const root = rootIdentifier(callee);
        if (!isCtx(root)) {
          out.calls.push({ callee: this.textOf(callee), root, line });
          // Hono's own helpers (`getCookie(c)`, `env(c)`) take the context without reading the body
          const canonical = root ? (this.importedFrom.get(root)?.canonical ?? "") : "";
          const honoHelper = canonical === "hono" || /^(?:hono|@hono)\//.test(canonical);
          if (!honoHelper && n.arguments.some(escapes)) out.requestEscapes = true;
        }
        // an error handler is `(err, c)`: its context is the second parameter, not the first
        const respondsOn = (x: string | null) =>
          isCtx(x) || (x !== null && (x === params[1] || CONTEXT_NAMES.has(x)));
        if (!exempt && errParam && this.leakingResponder(n, errParam, respondsOn))
          out.leaksError = true;
      }
      ts.forEachChild(n, (c) => visit(c, exempt));
    };
    visit(body, false);
    return out;
  }

  private leakingResponder(
    call: ts.CallExpression,
    err: string,
    isCtx: (n: string | null) => boolean,
  ): boolean {
    const chain = memberChain(call.expression);
    const responder =
      chain !== null &&
      ((isCtx(chain[0]) && RESPONDERS.has(chain[chain.length - 1])) || chain[0] === "Response");
    if (!responder) return false;
    let leaks = false;
    const scan = (n: Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === err &&
        (n.name.text === "message" || n.name.text === "stack")
      ) {
        leaks = true;
      } else if (
        ts.isIdentifier(n) &&
        n.text === err &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
      ) {
        leaks = true; // the raw error: `c.json(err)`, `${err}`, `String(err)`
      }
      ts.forEachChild(n, scan);
    };
    for (const a of call.arguments) scan(a);
    return leaks;
  }

  // -------------------------------------------------------------------------
  // whole-file scan: env reads, serve calls, hc clients, dynamic imports, env validation
  // -------------------------------------------------------------------------

  private scanAll(root: Node): void {
    const instances = new Set<string>(Object.keys(this.aliases));
    for (const op of this.ops) if (op.op === "decl") instances.add(op.instance.local);
    const visit = (n: Node, inFunction: boolean): void => {
      const fnHere = inFunction || ts.isFunctionLike(n);
      if (ts.isNewExpression(n) && inFunction && this.ctorOf(n)) this.instanceDeclsInFunctions++;
      if (ts.isCallExpression(n)) this.scanCall(n);
      this.scanDeprecated(n, instances);
      this.scanEnv(n);
      ts.forEachChild(n, (c) => visit(c, fnHere));
    };
    visit(root, false);
  }

  /** Getters and methods Hono marks `@deprecated` that leave no trace in the other facts. */
  private scanDeprecated(n: Node, instances: ReadonlySet<string>): void {
    if (
      ts.isPropertyAccessExpression(n) &&
      (n.name.text === "routePath" || n.name.text === "matchedRoutes")
    ) {
      const ch = memberChain(n);
      if (ch && ch.length === 3 && CONTEXT_NAMES.has(ch[0]) && ch[1] === "req") {
        this.deprecatedUses.push({
          api: n.name.text === "routePath" ? "c.req.routePath" : "c.req.matchedRoutes",
          line: this.lineOf(n),
        });
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "fire" &&
      n.arguments.length === 0
    ) {
      const root = rootIdentifier(n.expression.expression);
      if (root && instances.has(root))
        this.deprecatedUses.push({ api: "app.fire", line: this.lineOf(n) });
    }
  }

  private scanCall(call: ts.CallExpression): void {
    const callee = call.expression;
    const line = this.lineOf(call);
    // dynamic import("x")
    if (callee.kind === ts.SyntaxKind.ImportKeyword && call.arguments[0]) {
      const s = this.stringOf(call.arguments[0]);
      if (s !== null) this.addImport({ specifier: s, dynamic: true, line });
    }
    const text =
      ts.isPropertyAccessExpression(callee) || ts.isIdentifier(callee)
        ? callee.getText(this.sf)
        : "";
    const nodeServe =
      (text === "serve" || text === "createAdaptorServer") &&
      (this.importedFrom.get(text)?.canonical ?? "").startsWith("@hono/node-server");
    if (text === "Deno.serve" || text === "Bun.serve" || nodeServe) {
      const kind: ServeFact["kind"] =
        text === "Deno.serve" ? "deno-serve" : text === "Bun.serve" ? "bun-serve" : "node-server";
      let ref: string | null = null;
      for (const a of call.arguments) {
        ref = fetchOwner(skipWrappers(a)) ?? ref;
        const x = skipWrappers(a);
        if (!ref && ts.isIdentifier(x) && kind === "node-server") ref = x.text;
      }
      this.serves.push({ kind, appRef: ref, line });
    }
    // hc<typeof app>(url)
    if (ts.isIdentifier(callee) && (callee.text === "hc" || callee.text === "hcWithType")) {
      const arg = call.arguments[0];
      this.hcCalls.push({
        line,
        typeArg: call.typeArguments?.[0] ? this.textOf(call.typeArguments[0]) : null,
        baseUrl: arg ? this.stringOf(arg) : null,
      });
    }
    this.scanEnvValidation(call, text, line);
  }

  private scanEnvValidation(call: ts.CallExpression, calleeText: string, line: number): void {
    const argHasEnv = call.arguments.some((a) => containsEnvRef(a));
    if (!argHasEnv) return;
    const name = calleeLastName(call) ?? "";
    let via: EnvValidationFact["via"] | null = null;
    let keys: string[] | "all" = "all";
    const schemaOf = (e: Expr): Expr | null => {
      const x = skipWrappers(e);
      return ts.isIdentifier(x) ? (this.schemaDecls.get(x.text) ?? null) : x;
    };
    if (
      ["parse", "safeParse", "parseAsync", "safeParseAsync", "decode", "assert"].includes(name) &&
      ts.isPropertyAccessExpression(call.expression)
    ) {
      const schema = schemaOf(call.expression.expression);
      via = schemaLibrary(schema ? this.textOf(schema, 400) : calleeText);
      keys = schema ? objectKeys(schema) : "all";
      if (via === "custom" && /^v\./.test(calleeText)) via = "valibot";
      if (
        calleeText.startsWith("v.") ||
        (name === "parse" &&
          ts.isIdentifier(call.expression.expression) &&
          call.expression.expression.text === "v")
      ) {
        via = "valibot";
        const first = call.arguments[0];
        const sch = first ? schemaOf(first) : null;
        keys = sch ? objectKeys(sch) : "all";
      }
    } else if ((name === "parse" || name === "safeParse") && ts.isIdentifier(call.expression)) {
      // valibot: parse(schema, process.env)
      via = "valibot";
      const first = call.arguments[0];
      const sch = first ? schemaOf(first) : null;
      keys = sch ? objectKeys(sch) : "all";
    } else if (name === "createEnv") {
      via = "t3-env";
    } else if (name === "cleanEnv" || name === "envsafe") {
      via = "envalid";
      const spec = call.arguments[1] ? skipWrappers(call.arguments[1]) : null;
      keys = spec ? objectKeys(spec) : "all";
    } else if (/^(validate|parse|load|check|assert|verify)Env/i.test(name)) {
      via = "custom";
    }
    if (!via) return;
    this.envValidations.push({ line, via, keys });
    this.validatedRanges.push([call.getStart(this.sf), call.getEnd()]);
  }

  private pushEnv(read: Omit<EnvRead, "file" | "validated"> & { pos: number }): number {
    const { pos, ...rest } = read;
    this.envReads.push({ ...rest, file: this.path, validated: false });
    this.envPos.push(pos);
    return this.envReads.length - 1;
  }
  private readonly envPos: number[] = [];

  private scopeOf(n: Node): Node {
    let p: Node | undefined = n.parent;
    while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
    return p ?? this.sf;
  }

  /**
   * `const secret = <read>` (also through `?? ""`, `|| ""`, `as string`, `?.trim()`, or `x = <read>`):
   * remember the local name so a later `if (!secret) throw` can be tied back.
   */
  private bindRead(read: Node, index: number): void {
    const value = envValueOf(read);
    const holder = value.parent;
    if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
      this.envBindings.push({ name: holder.name.text, scope: this.scopeOf(holder), read: index });
    } else if (
      ts.isBinaryExpression(holder) &&
      holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      holder.right === value &&
      ts.isIdentifier(holder.left)
    ) {
      this.envBindings.push({ name: holder.left.text, scope: this.scopeOf(holder), read: index });
    }
  }

  /** `inner` is `outer` or sits lexically inside it. */
  private within(inner: Node, outer: Node): boolean {
    for (let p: Node | undefined = inner; p; p = p.parent) if (p === outer) return true;
    return false;
  }

  /**
   * The function-like `scope` redeclares `name` for the code at `at`: a parameter, or a local or
   * nested function whose own block (the whole function for `var`) holds `at`.
   */
  private declares(scope: Node, name: string, at: Node): boolean {
    const named = (b: ts.BindingName): boolean =>
      ts.isIdentifier(b)
        ? b.text === name
        : b.elements.some((e) => !ts.isOmittedExpression(e) && named(e.name));
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => named(p.name))) return true;
    const reach = (d: Node): Node | undefined => {
      const hoisted =
        ts.isVariableDeclaration(d) && !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.BlockScoped);
      for (let p: Node | undefined = d.parent; p; p = p.parent) {
        if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return p;
        const block =
          ts.isBlock(p) ||
          ts.isCaseBlock(p) ||
          ts.isCatchClause(p) ||
          ts.isForStatement(p) ||
          ts.isForInStatement(p) ||
          ts.isForOfStatement(p);
        if (block && !hoisted) return p;
      }
      return undefined;
    };
    let found = false;
    const walk = (n: Node): void => {
      if (found) return;
      const declared =
        (ts.isVariableDeclaration(n) && named(n.name)) ||
        (ts.isFunctionDeclaration(n) && n.name?.text === name);
      if (declared) {
        const owner = reach(n);
        if (owner && this.within(at, owner)) found = true;
      }
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, walk);
    };
    ts.forEachChild(scope, walk);
    return found;
  }

  /**
   * The binding is the one the guard `at` names: its scope is the guard's function or encloses it
   * (a module-level read guarded in a function), and no function in between redeclares the name.
   * ponytail: a redeclaration in the binding's own function, inside a nested block holding the
   * guard, is not detected; it errs toward quiet. Track the declaration node to close it.
   */
  private sees(at: Node, b: { name: string; scope: Node }): boolean {
    for (let p: Node | undefined = this.scopeOf(at); p; p = p.parent) {
      if (p === b.scope) return true;
      if (ts.isFunctionLike(p) && this.declares(p, b.name, at)) return false;
    }
    return false;
  }

  /**
   * A hand-written guard (`const k = Deno.env.get("K"); if (!k) throw …`, or `return` a 500) checks
   * the read as surely as a schema does. Reads named in the condition of an `if` that throws,
   * returns or exits are marked validated, and each function's guards become one `custom`
   * validation with its keys.
   */
  private markGuardedEnvReads(): void {
    const guards = new Map<Node, { line: number; keys: string[] }>();
    const visit = (n: Node): void => {
      const exit = ts.isIfStatement(n) ? exitOf(n.thenStatement) : null;
      // a throw is a guard whatever the condition; a plain return only when the value is missing
      if (
        ts.isIfStatement(n) &&
        (exit === "throw" || (exit === "return" && isMissingCheck(n.expression)))
      ) {
        const scope = this.scopeOf(n);
        const names = new Set<string>();
        const collect = (c: Node): void => {
          if (
            ts.isIdentifier(c) &&
            !(ts.isPropertyAccessExpression(c.parent) && c.parent.name === c)
          )
            names.add(c.text);
          ts.forEachChild(c, collect);
        };
        collect(n.expression);
        const from = n.expression.getStart(this.sf);
        const to = n.expression.getEnd();
        const hit = new Set<number>();
        for (const b of this.envBindings) if (names.has(b.name) && this.sees(n, b)) hit.add(b.read);
        this.envPos.forEach((pos, i) => {
          if (pos >= from && pos < to) hit.add(i);
        });
        for (const i of hit) {
          this.envReads[i].validated = true;
          const key = this.envReads[i].key;
          if (!key) continue;
          const g = guards.get(scope) ?? { line: this.lineOf(n), keys: [] };
          if (!g.keys.includes(key)) g.keys.push(key);
          guards.set(scope, g);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    for (const g of guards.values())
      this.envValidations.push({ line: g.line, via: "custom", keys: g.keys });
  }

  private markValidatedEnvReads(): void {
    this.envReads.forEach((r, i) => {
      const pos = this.envPos[i];
      if (this.validatedRanges.some(([s, e]) => pos >= s && pos < e)) r.validated = true;
    });
  }

  private scanEnv(n: Node): void {
    const line = this.lineOf(n);
    const pos = n.getStart(this.sf);
    // process.env / Bun.env / import.meta.env / c.env  (bare object or a keyed access)
    const api = envApiOf(n);
    if (api) {
      const parent = outerParent(n);
      if (ts.isPropertyAccessExpression(parent) && skipWrappers(parent.expression) === n) {
        this.bindRead(parent, this.pushEnv({ key: parent.name.text, api, line, pos }));
      } else if (ts.isElementAccessExpression(parent) && skipWrappers(parent.expression) === n) {
        this.bindRead(
          parent,
          this.pushEnv({ key: this.stringOf(parent.argumentExpression), api, line, pos }),
        );
      } else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          const i = this.pushEnv({
            key: ts.isIdentifier(el.propertyName ?? el.name)
              ? (el.propertyName ?? (el.name as ts.Identifier)).getText(this.sf)
              : null,
            api,
            line,
            pos,
          });
          if (ts.isIdentifier(el.name))
            this.envBindings.push({ name: el.name.text, scope: this.scopeOf(parent), read: i });
        }
      } else {
        this.pushEnv({ key: null, api, line, pos });
      }
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // Deno.env.get("X")
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "get" &&
        callee.expression.getText(this.sf) === "Deno.env"
      ) {
        this.bindRead(
          n,
          this.pushEnv({
            key: n.arguments[0] ? this.stringOf(n.arguments[0]) : null,
            api: "Deno.env.get",
            line,
            pos,
          }),
        );
      }
      // env(c) from hono/adapter
      if (
        ts.isIdentifier(callee) &&
        callee.text === "env" &&
        n.arguments.length >= 1 &&
        this.importedFrom.get("env")?.canonical === "hono/adapter"
      ) {
        const parent = outerParent(n);
        if (ts.isPropertyAccessExpression(parent) && skipWrappers(parent.expression) === n) {
          this.bindRead(parent, this.pushEnv({ key: parent.name.text, api: "env(c)", line, pos }));
        } else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
          for (const el of parent.name.elements) {
            const i = this.pushEnv({
              key: (el.propertyName ?? el.name).getText(this.sf),
              api: "env(c)",
              line,
              pos,
            });
            if (ts.isIdentifier(el.name))
              this.envBindings.push({ name: el.name.text, scope: this.scopeOf(parent), read: i });
          }
        } else {
          this.pushEnv({ key: null, api: "env(c)", line, pos });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// free helpers
// ---------------------------------------------------------------------------

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  return out;
}

function callName(call: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";
}

function calleeLastName(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

function regVia(name: string): RegVia | null {
  if ((HTTP_METHODS as readonly string[]).includes(name)) return name as RegVia;
  if (name === "all" || name === "on" || name === "use" || name === "mount" || name === "openapi")
    return name;
  return null;
}

function isInstanceMethod(name: string): boolean {
  return (
    regVia(name) !== null ||
    name === "route" ||
    name === "basePath" ||
    name === "onError" ||
    name === "notFound" ||
    name === "doc" ||
    name === "doc31"
  );
}

function isStringArg(ex: Extractor, a: Expr): boolean {
  const x = skipWrappers(a);
  return (
    ts.isStringLiteral(x) ||
    ts.isNoSubstitutionTemplateLiteral(x) ||
    ts.isTemplateExpression(x) ||
    (ts.isIdentifier(x) && x.text in ex.constants) ||
    (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

function stringsOf(e: Expr): string[] | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isArrayLiteralExpression(e)) {
    const out: string[] = [];
    for (const x of e.elements) {
      if (!(ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x))) return null;
      out.push(x.text);
    }
    return out;
  }
  return null;
}

function pathsOf(ex: Extractor, e: Expr): PathValue[] {
  if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => ex.pathOf(x));
  return [ex.pathOf(e)];
}

function rootIdentifier(e: Node): string | null {
  let cur: Node = e;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
      cur = cur.expression;
    else if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (
      ts.isNonNullExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isAwaitExpression(cur)
    )
      cur = cur.expression;
    else if (ts.isAsExpression(cur)) cur = cur.expression;
    else return null;
  }
}

function firstEntityName(n: ts.EntityName): string | null {
  return ts.isIdentifier(n) ? n.text : firstEntityName(n.left);
}

/** `a.b.c` → ["a","b","c"]; null when the chain contains anything but identifiers. */
function memberChain(e: Expr): string[] | null {
  const parts: string[] = [];
  let cur: Expr = e;
  for (;;) {
    cur = skipWrappers(cur);
    if (ts.isIdentifier(cur)) {
      parts.unshift(cur.text);
      return parts;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = cur.expression;
    } else return null;
  }
}

/** `{ fetch: app.fetch }` / `Deno.serve({ port }, app.fetch)` → "app". */
function fetchOwner(e: Expr): string | null {
  if (ts.isPropertyAccessExpression(e) && e.name.text === "fetch")
    return rootIdentifier(e.expression);
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p)) {
        const found = fetchOwner(skipWrappers(p.initializer));
        if (found) return found;
        // `fetch: (req) => app.fetch(req)`
        let inner: string | null = null;
        const walk = (n: Node): void => {
          if (!inner && ts.isPropertyAccessExpression(n) && n.name.text === "fetch")
            inner = rootIdentifier(n.expression);
          if (!inner) ts.forEachChild(n, walk);
        };
        walk(p.initializer);
        if (inner) return inner;
      }
    }
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    let inner: string | null = null;
    const walk = (n: Node): void => {
      if (!inner && ts.isPropertyAccessExpression(n) && n.name.text === "fetch")
        inner = rootIdentifier(n.expression);
      if (!inner) ts.forEachChild(n, walk);
    };
    walk(e);
    return inner;
  }
  return null;
}

function bodyTarget(init: Expr): string | null {
  const text = init.getText();
  if (/multipart\/form-data|x-www-form-urlencoded/.test(text)) return "form";
  return "json";
}

function mentionsHttpException(cond: Expr, err: string): boolean {
  let found = false;
  const walk = (n: Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(n.left) &&
      n.left.text === err
    )
      found = true;
    if (!found) ts.forEachChild(n, walk);
  };
  walk(cond);
  return found;
}

/**
 * The read climbed through what keeps "set or missing" intact, so a guard on the result checks
 * the read: `!`, parentheses, `as T`, `.method()` calls, `?? d` / `|| d` with the read on the left
 * and the read on the right (`override ?? read`). A fallback that is a non-empty constant
 * (`?? "dev-secret"`) is not climbed: the guard could never fire.
 * ponytail: a fallback that is a name or a call is climbed, as its value is not known here;
 * resolve a module-level `const` to its literal if hardcoded fallbacks through one need catching.
 */
function envValueOf(read: Node): Node {
  let cur = read;
  for (;;) {
    const p = cur.parent;
    if (!p) return cur;
    const same =
      ts.isNonNullExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p);
    const defaulted =
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      (p.right === cur || (p.left === cur && !isNonEmptyConstant(p.right)));
    const method =
      ts.isPropertyAccessExpression(p) &&
      p.expression === cur &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p;
    if (!same && !defaulted && !method) return cur;
    cur = method ? p.parent : p;
  }
}

/** A literal that is never missing or empty: `"dev-secret"`, `42`. */
function isNonEmptyConstant(e: Expr): boolean {
  const v = skipWrappers(e);
  return (ts.isStringLiteralLike(v) && v.text !== "") || ts.isNumericLiteral(v);
}

function outerParent(n: Node): Node {
  let p = n.parent;
  while (p && (ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
  return p;
}

/**
 * How a branch ends the function: it throws or stops the process ("throw"), or answers and
 * returns ("return"); nested functions do not count. `null` when it falls through.
 */
function exitOf(stmt: Node): "throw" | "return" | null {
  let found: "throw" | "return" | null = null;
  const walk = (n: Node): void => {
    if (found === "throw" || ts.isFunctionLike(n)) return;
    if (ts.isThrowStatement(n)) found = "throw";
    else if (ts.isCallExpression(n) && /^(?:Deno|process)\.exit$/.test(n.expression.getText()))
      found = "throw";
    else if (ts.isReturnStatement(n)) found = "return";
    ts.forEachChild(n, walk);
  };
  walk(stmt);
  return found;
}

/** `!x`, `x === undefined`, `x == null`, `x === ""`, or an `||` containing one of those. */
function isMissingCheck(e: Expr): boolean {
  const x = skipWrappers(e);
  if (ts.isPrefixUnaryExpression(x)) return x.operator === ts.SyntaxKind.ExclamationToken;
  if (!ts.isBinaryExpression(x)) return false;
  const op = x.operatorToken.kind;
  if (op === ts.SyntaxKind.BarBarToken) return isMissingCheck(x.left) || isMissingCheck(x.right);
  if (op !== ts.SyntaxKind.EqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return false;
  const nothing = (side: Expr): boolean => {
    const y = skipWrappers(side);
    return (
      y.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(y) && y.text === "undefined") ||
      (ts.isStringLiteral(y) && (y.text === "" || y.text === "undefined"))
    );
  };
  return nothing(x.left) || nothing(x.right);
}

function envApiOf(n: Node): EnvRead["api"] | null {
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) && n.name.text === "env") {
    const base = skipWrappers(n.expression);
    if (ts.isIdentifier(base)) {
      if (base.text === "process") return "process.env";
      if (base.text === "Bun") return "Bun.env";
      if (CONTEXT_NAMES.has(base.text)) return "c.env";
    }
    if (ts.isMetaProperty(base) && base.keywordToken === ts.SyntaxKind.ImportKeyword)
      return "import.meta.env";
  }
  return null;
}

function containsEnvRef(e: Node): boolean {
  let found = false;
  const walk = (n: Node): void => {
    if (found) return;
    if (envApiOf(n)) found = true;
    else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "env" &&
      n.arguments.length >= 1
    )
      found = true;
    else if (ts.isCallExpression(n) && n.expression.getText() === "Deno.env.toObject") found = true;
    else ts.forEachChild(n, walk);
  };
  walk(e);
  return found;
}

function schemaLibrary(text: string): EnvValidationFact["via"] {
  if (/\bz\.|from ["']zod|\bzod\b/.test(text)) return "zod";
  if (/\bv\.|valibot|\bobject\(/.test(text)) return "valibot";
  return "custom";
}

/** Property names of the first object literal found in a schema expression (`z.object({...})`). */
function objectKeys(e: Node): string[] | "all" {
  let keys: string[] | "all" = "all";
  const walk = (n: Node): void => {
    if (keys !== "all") return;
    if (ts.isObjectLiteralExpression(n)) {
      const names = n.properties.flatMap((p) =>
        p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : [],
      );
      if (names.length > 0) keys = names;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(e);
  return keys;
}

export interface ParseStat {
  size: number;
  mtime: number;
}

export function parseModule(path: string, text: string, stat: ParseStat): ModuleFacts {
  const ex = new Extractor(path, text);
  ex.run();
  return {
    path,
    isTest: TEST_FILE_PATTERN.test(path),
    imports: ex.imports,
    envReads: ex.envReads,
    parseErrors: ex.parseErrors(),
    size: stat.size,
    mtime: stat.mtime,
    exports: ex.exports,
    ops: ex.ops,
    aliases: ex.aliases,
    functions: ex.functions,
    topLevelValues: ex.topLevelValues,
    constants: ex.constants,
    serves: ex.serves,
    rpcTypes: ex.rpcTypes,
    hcCalls: ex.hcCalls,
    envValidations: ex.envValidations,
    instanceDeclsInFunctions: ex.instanceDeclsInFunctions,
    deprecatedUses: ex.deprecatedUses,
  };
}
