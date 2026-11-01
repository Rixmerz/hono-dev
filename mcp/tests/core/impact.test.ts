import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeImpact, gitChangedFiles } from "../../core/impact.ts";
import { cleanupTemps, copyFixture, loadFixture } from "../_helpers.ts";

afterAll(cleanupTemps);

describe("computeImpact", () => {
  it("a service change reaches the routes through the handler's importers", async () => {
    const idx = await loadFixture("hono-mounted");
    const r = computeImpact(idx, ["src/services/contact.service.ts"], 6);
    const paths = r.routes.map((x) => `${x.method} ${x.fullPath}`);
    expect(paths).toContain("GET /v1/contacts/:id");
    expect(paths).toContain("POST /v1/contacts/import");
    expect(paths).not.toContain("GET /rpc/hello");
    expect(r.tests).toEqual(["src/routes/v1/contacts.test.ts"]);
    expect(r.suggestedChecks).toContain("npx tsc --noEmit");
    expect(
      r.suggestedChecks.some((c) => c.startsWith("npx vitest run src/routes/v1/contacts.test.ts")),
    ).toBe(true);
  });

  it("a middleware change names the middleware and every route behind it", async () => {
    const idx = await loadFixture("hono-mounted");
    const r = computeImpact(idx, ["src/middleware/auth.ts"]);
    expect(r.middlewares.map((m) => m.fullPath)).toEqual(
      expect.arrayContaining(["/v1/contacts/*", "/v1/integrations/*", "/v1/admin/*"]),
    );
    const cb = r.routes.find((x) => x.fullPath === "/v1/integrations/google-calendar/callback");
    // unreached auth still matters: someone may reorder the mounts
    expect(cb?.why.join(" ")).toMatch(/authMiddleware/);
    expect(r.routes.some((x) => x.fullPath === "/rpc/echo")).toBe(false);
  });

  it("an rpc source change names the app type", async () => {
    const idx = await loadFixture("hono-mounted");
    expect(computeImpact(idx, ["src/rpc/api.ts"]).rpcTypes).toEqual(["AppType"]);
  });

  it("honours depth and accepts absolute paths inside the workspace", async () => {
    const idx = await loadFixture("hono-mounted");
    const shallow = computeImpact(idx, [join(idx.workspace, "src/services/contact.service.ts")], 1);
    expect(shallow.files).toEqual(["src/services/contact.service.ts"]);
    const shallowPaths = shallow.routes.map((x) => `${x.method} ${x.fullPath}`);
    expect(shallowPaths).toContain("GET /v1/contacts/:id");
    expect(shallowPaths).not.toContain("GET /v1/admin/stats");
    expect(shallow.tests).toEqual([]);
  });
});

describe("gitChangedFiles", () => {
  it("lists files changed since a ref, relative to the workspace", async () => {
    const dir = await copyFixture("hono-node");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
    await writeFile(join(dir, "src/app.ts"), "export const changed = 1;\n");
    expect(await gitChangedFiles(dir, "HEAD")).toEqual(["src/app.ts"]);
  });

  it("refuses refs that git would read as options", async () => {
    const dir = await copyFixture("hono-node");
    await expect(gitChangedFiles(dir, "--output=/tmp/pwned")).rejects.toThrow(/refusing git ref/);
    await expect(gitChangedFiles(dir, "main", "--stat")).rejects.toThrow(/refusing git ref/);
  });

  it("wraps git failures with the range", async () => {
    const dir = await copyFixture("hono-node");
    await expect(gitChangedFiles(dir, "no-such-ref")).rejects.toThrow(
      /git diff no-such-ref failed/,
    );
  });
});
