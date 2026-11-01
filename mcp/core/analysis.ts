/** Project-level facts derived from the parsed modules: RPC types and clients, env validation. */
import type { Composition } from "./compose.ts";
import type { EnvRead, EnvValidation, HonoDevConfig, ModuleFacts, RpcInfo } from "./types.ts";

export function buildRpc(facts: Map<string, ModuleFacts>, comp: Composition): RpcInfo {
  const appTypes: RpcInfo["appTypes"] = [];
  for (const mod of facts.values()) {
    if (mod.isTest) continue;
    for (const t of mod.rpcTypes) {
      const exported = t.exported || mod.exports.some((e) => e.isType && e.local === t.name);
      if (!exported || !t.target) continue;
      const hit = comp.rpcTarget(mod.path, t.target);
      appTypes.push({
        name: t.name,
        file: mod.path,
        line: t.line,
        target: hit?.id ?? null,
        chained: (hit?.chainedOps ?? 0) > 0,
        routeCount: hit?.chainedOps ?? 0,
      });
    }
  }
  const clients: RpcInfo["clients"] = [];
  for (const mod of facts.values()) {
    for (const c of mod.hcCalls) {
      let appType: string | null = null;
      const arg = c.typeArg?.trim() ?? null;
      if (arg) {
        const typeofRef = arg.match(/^typeof\s+([\w$.]+)$/)?.[1];
        if (typeofRef)
          appType = comp.resolveApp(mod.path, typeofRef) ? `typeof ${typeofRef}` : null;
        else if (/^[\w$]+$/.test(arg)) appType = appTypes.some((a) => a.name === arg) ? arg : null;
      }
      clients.push({ file: mod.path, line: c.line, typeArg: arg, appType, baseUrl: c.baseUrl });
    }
  }
  return { appTypes, clients };
}

export function buildEnvValidation(
  facts: Map<string, ModuleFacts>,
  config: HonoDevConfig,
): EnvValidation[] {
  const out: EnvValidation[] = [];
  for (const mod of facts.values()) {
    if (mod.isTest) continue;
    for (const v of mod.envValidations)
      out.push({ file: mod.path, line: v.line, via: v.via, keys: v.keys });
  }
  for (const file of config.envValidationModules) {
    if (!out.some((v) => v.file === file)) out.push({ file, line: 1, via: "custom", keys: "all" });
  }
  return out;
}

/** Every env read of non-test code, with `validated` extended by `config.envValidationModules`. */
export function collectEnvReads(facts: Map<string, ModuleFacts>, config: HonoDevConfig): EnvRead[] {
  const out: EnvRead[] = [];
  for (const mod of facts.values()) {
    if (mod.isTest) continue;
    for (const r of mod.envReads) {
      out.push({ ...r, validated: r.validated || config.envValidationModules.includes(r.file) });
    }
  }
  return out;
}
