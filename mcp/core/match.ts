/**
 * Route and middleware matching through hono's own router, never a reimplementation: the same
 * `SmartRouter([RegExpRouter, TrieRouter])` that `new Hono()` builds by default (docs/adr/0004).
 * The payload stored per entry is its position in the table, so results map straight back.
 */
import { RegExpRouter } from "hono/router/reg-exp-router";
import { SmartRouter } from "hono/router/smart-router";
import { TrieRouter } from "hono/router/trie-router";

export interface TableEntryKey {
  /** "ALL" for `use()` and `all()`. */
  method: string;
  path: string;
}

export interface MatchHit {
  index: number;
  params: Record<string, string>;
}

type ParamIndexMap = Record<string, number>;
type RouterResult = [[number, ParamIndexMap | Record<string, string>][], string[]?];

export class TableMatcher {
  private readonly router: SmartRouter<number>;
  /** Set when hono's router rejected the table (for example a malformed pattern). */
  error: string | null = null;

  /** `null` slots keep positions stable for entries that cannot be matched (non-literal paths). */
  constructor(entries: readonly (TableEntryKey | null)[]) {
    this.router = new SmartRouter<number>({
      routers: [new RegExpRouter<number>(), new TrieRouter<number>()],
    });
    entries.forEach((e, i) => {
      if (e) this.router.add(e.method, e.path, i);
    });
  }

  /** Entries matching a request, in table order. HEAD dispatches as GET, like hono-base. */
  match(method: string, path: string): MatchHit[] {
    if (this.error) return [];
    const m = method === "HEAD" ? "GET" : method;
    let res: RouterResult;
    try {
      res = this.router.match(m, path) as unknown as RouterResult;
    } catch (e) {
      this.error = (e as Error).message;
      return [];
    }
    const [handlers, stash] = res;
    return handlers.map(([index, params]) => {
      const out: Record<string, string> = {};
      for (const [name, v] of Object.entries(params ?? {})) {
        // RegExpRouter returns name → index into the shared stash; TrieRouter returns values.
        const value = stash && typeof v === "number" ? stash[v] : v;
        if (typeof value === "string") out[name] = value;
      }
      return { index, params: out };
    });
  }
}

/**
 * One concrete string for a simple regex body (`[a-z]+\\.png` → `a.png`): classes give their first
 * character, escapes their literal, quantifiers are dropped. The caller validates the result.
 */
function sampleFromRegex(body: string): string | null {
  if (body.includes("|")) return null;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const n = body[++i];
      out += n === "d" ? "1" : n === "w" || n === "s" ? "a" : (n ?? "");
    } else if (c === "[") {
      const end = body.indexOf("]", i + 1);
      if (end < 0) return null;
      const first = body[i + 1] === "^" ? "a" : body[i + 1];
      out += first === "\\" ? (body[i + 2] ?? "a") : first;
      i = end;
    } else if (c === ".") out += "a";
    else if ("+*?(){}^$".includes(c)) {
      if (c === "{") i = body.indexOf("}", i) < 0 ? body.length : body.indexOf("}", i);
    } else out += c;
  }
  return out || null;
}

const REGEX_CANDIDATES = ["1", "a", "a1", "abc", "12345", "x-y", "2024-01-01", "x/y", "A", "0"];

/**
 * Concrete request paths that a route pattern should serve, used to ask the router which other
 * entries cover that route. `:id` becomes a segment value; a `{regex}` constraint gets a value
 * that satisfies it; the caller checks that the route's own entry is among the matches.
 */
export function samplePaths(pattern: string): string[] {
  const variants = new Set<string>();
  for (let k = 0; k < 4; k++) {
    const segs = pattern.split("/").map((seg) => {
      if (seg.startsWith(":")) {
        const constraint = seg.match(/\{(.+)\}\??$/);
        if (!constraint) return "x1";
        const re = safeRegExp(constraint[1]);
        const generated = sampleFromRegex(constraint[1]);
        const pool = generated ? [generated, ...REGEX_CANDIDATES] : REGEX_CANDIDATES;
        const fits = re ? pool.filter((c) => re.test(c)) : [];
        return fits.length > 0 ? fits[Math.min(k, fits.length - 1)] : "x1";
      }
      return seg.includes("*") ? seg.replace(/\*/g, "x") : seg;
    });
    variants.add(segs.join("/") || "/");
  }
  return [...variants];
}

function safeRegExp(body: string): RegExp | null {
  try {
    return new RegExp(`^(?:${body})$`);
  } catch {
    return null; // a constraint JS cannot compile: fall back to the default sample
  }
}
