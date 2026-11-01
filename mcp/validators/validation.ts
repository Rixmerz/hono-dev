/** V001-V005: what a route reads from the request against the validators in front of it. */
import type { Finding, RouteEntry } from "../core/types.ts";
import {
  finding,
  hasSpreadArgs,
  inScope,
  liveRoutes,
  type Rule,
  type RuleContext,
  routeLabel,
} from "./rule.ts";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** Body reads a json/form validator replaces; `text()`/`arrayBuffer()`/`blob()` are raw by design. */
const VALIDATABLE_READS = new Set(["json", "parseBody", "formData"]);

/** Validators of a target; an `unknown` target (a computed one) is given the benefit of the doubt. */
function validates(r: RouteEntry, ...targets: string[]): boolean {
  return r.validators.some((v) => v.target === "unknown" || targets.includes(v.target));
}

/** A route whose validators or schema cannot be read from source: spread arguments, unresolved OpenAPI. */
function opaque(ctx: RuleContext, r: RouteEntry): boolean {
  return (r.openapi && r.validators.length === 0) || hasSpreadArgs(ctx.index, r);
}

const V001: Rule = {
  id: "V001",
  category: "validation",
  severity: "warning",
  title: "POST/PUT/PATCH reads the body with no json/form validator",
  run(ctx) {
    const out: Finding[] = [];
    for (const r of liveRoutes(ctx.index)) {
      if (!BODY_METHODS.has(r.method) || !r.handler) continue;
      const reads = r.handler.bodyReads.filter((b) => VALIDATABLE_READS.has(b.api));
      if (reads.length === 0 || validates(r, "json", "form") || opaque(ctx, r)) continue;
      if (!inScope(ctx, r.handler.file)) continue;
      out.push(
        finding(
          V001,
          r.handler.file,
          `${routeLabel(r)} reads the body with c.req.${reads[0].api}() and no json or form validator guards it`,
          {
            line: reads[0].line,
            route: routeLabel(r),
            hint: "put zValidator('json', schema) (or the project's validator) before the handler and read c.req.valid('json')",
          },
        ),
      );
    }
    return out;
  },
};

const V002: Rule = {
  id: "V002",
  category: "validation",
  severity: "info",
  title: "body route whose body use cannot be analysed and has no validator",
  run(ctx) {
    const out: Finding[] = [];
    for (const r of liveRoutes(ctx.index)) {
      if (!BODY_METHODS.has(r.method) || validates(r, "json", "form")) continue;
      if (r.openapi && r.validators.length === 0) continue;
      const h = r.handler;
      const analysed =
        h !== null &&
        h.requestEscapes === false &&
        (h.kind === "inline" || (h.kind === "identifier" && !!h.resolved?.includes("#")));
      if (analysed && !hasSpreadArgs(ctx.index, r)) continue;
      if (h?.bodyReads.some((b) => VALIDATABLE_READS.has(b.api)) && !hasSpreadArgs(ctx.index, r))
        continue; // V001 already speaks for it
      if (!inScope(ctx, r.file)) continue;
      out.push(
        finding(
          V002,
          r.file,
          `${routeLabel(r)} accepts a body, has no validator, and what its handler does with the request cannot be read from source (${h === null ? "no handler found" : h.requestEscapes ? "it hands the request to other code" : `the handler is ${h.kind === "factory" ? "built by a factory" : "not resolvable"}`})`,
          {
            line: r.line,
            route: routeLabel(r),
            confidence: "inferred",
            hint: "acknowledge it if the callee validates; otherwise validate before delegating",
          },
        ),
      );
    }
    return out;
  },
};

const V003: Rule = {
  id: "V003",
  category: "validation",
  severity: "error",
  title: "c.req.valid(target) with no validator for that target",
  run(ctx) {
    const out: Finding[] = [];
    for (const r of liveRoutes(ctx.index)) {
      if (!r.handler || opaque(ctx, r)) continue;
      for (const read of r.handler.validReads) {
        if (validates(r, read.target) || !inScope(ctx, r.handler.file)) continue;
        out.push(
          finding(
            V003,
            r.handler.file,
            `c.req.valid('${read.target}') on ${routeLabel(r)} has no '${read.target}' validator in its chain: it returns undefined at runtime`,
            {
              line: read.line,
              route: routeLabel(r),
              hint: `add a '${read.target}' validator before the handler`,
            },
          ),
        );
      }
    }
    return out;
  },
};

const V004: Rule = {
  id: "V004",
  category: "validation",
  severity: "warning",
  title: "json/form validator on a GET/HEAD route",
  run(ctx) {
    const out: Finding[] = [];
    for (const r of liveRoutes(ctx.index)) {
      if (r.method !== "GET" && r.method !== "HEAD") continue;
      for (const v of r.validators) {
        if (v.scope !== "route" || (v.target !== "json" && v.target !== "form")) continue;
        if (!inScope(ctx, v.file)) continue;
        out.push(
          finding(
            V004,
            v.file,
            `${v.via}('${v.target}') guards ${routeLabel(r)}: a ${r.method} request carries no body, so the validator can only fail, and the RPC client cannot send one`,
            {
              line: v.line,
              route: routeLabel(r),
              hint: "validate 'query' for a GET, or make the route a POST",
            },
          ),
        );
      }
    }
    return out;
  },
};

const V005: Rule = {
  id: "V005",
  category: "validation",
  severity: "info",
  title: "route params read with no param validator",
  run(ctx) {
    const out: Finding[] = [];
    for (const r of liveRoutes(ctx.index)) {
      const reads = r.handler?.paramReads ?? [];
      if (!r.handler || reads.length === 0 || validates(r, "param") || opaque(ctx, r)) continue;
      if (!inScope(ctx, r.handler.file)) continue;
      const names = [...new Set(reads.map((p) => p.name ?? "(all)"))];
      out.push(
        finding(
          V005,
          r.handler.file,
          `${routeLabel(r)} reads route param${names.length > 1 ? "s" : ""} ${names.join(", ")} as raw strings with no param validator`,
          {
            line: reads[0].line,
            route: routeLabel(r),
            hint: "validate ids (uuid, number) with a 'param' validator",
          },
        ),
      );
    }
    return out;
  },
};

export const validationRules: Rule[] = [V001, V002, V003, V004, V005];
