/** P001-P002: the exported app type and the clients typed with it. */
import type { Finding } from "../core/types.ts";
import { finding, localName, type Rule } from "./rule.ts";

const P001: Rule = {
  id: "P001",
  category: "rpc",
  severity: "warning",
  title: "exported app type from a non-chained instance",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const t of index.rpc.appTypes) {
      if (t.target === null || t.chained || (files && !files.has(t.file))) continue;
      const hasRoutes = index.routes.some(
        (r) =>
          r.kind === "route" &&
          (r.app === t.target ||
            r.root === t.target ||
            r.mountChain.some((h) => h.app === t.target)),
      );
      if (!hasRoutes) continue;
      out.push(
        finding(
          P001,
          t.file,
          `${t.name} is typeof '${localName(t.target)}', but its routes are registered in separate statements: the type carries none of them, so hc<${t.name}>() has no routes`,
          {
            line: t.line,
            hint: "build the app as one chain (new Hono().get(...).route(...)) and take the type from its result",
          },
        ),
      );
    }
    return out;
  },
};

const SIMPLE_TYPE_ARG = /^(?:typeof\s+)?[\w$]+(?:\.[\w$]+)*$/;

const P002: Rule = {
  id: "P002",
  category: "rpc",
  severity: "warning",
  title: "hc<T>() where T is not an exported app type",
  run({ index, files }) {
    const out: Finding[] = [];
    for (const c of index.rpc.clients) {
      if (c.typeArg === null || c.appType !== null || (files && !files.has(c.file))) continue;
      if (!SIMPLE_TYPE_ARG.test(c.typeArg)) continue; // a computed type cannot be judged from source
      const mod = index.facts.get(c.file);
      const root = c.typeArg.replace(/^typeof\s+/, "").split(".")[0];
      // imported from another package or an unresolved module: the type may well be an app type
      const imp = mod?.imports.find(
        (i) => i.default === root || i.namespace === root || i.names.some((n) => n.local === root),
      );
      if (imp && (imp.canonical || !imp.resolved)) continue;
      out.push(
        finding(
          P002,
          c.file,
          `hc<${c.typeArg}>() is typed with something that is not an exported app type (no exported 'type X = typeof app' of a Hono instance)`,
          {
            line: c.line,
            hint: "export type AppType = typeof app from the module that builds the app, and import that type",
          },
        ),
      );
    }
    return out;
  },
};

export const rpcRules: Rule[] = [P001, P002];
