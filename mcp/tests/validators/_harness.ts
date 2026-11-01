import { expect, it } from "vitest";
import { loadProject } from "../_helpers.ts";
import { type ValidateOptions, validate } from "../../validators/index.ts";
import type { Finding, ValidationResult } from "../../core/types.ts";

export type Files = Record<string, string>;

/**
 * Polarity of every positive assertion below. Flip it to see each rule test go red once, then
 * flip it back (the check that a test can fail at all, run on the test and never on the code).
 */
export const EXPECT_FINDING = true;

export const PKG = `{"dependencies":{"hono":"4.13.16"}}`;
export const HONO = `import { Hono } from "hono";`;

/** A project with a package.json that declares Hono, plus the given files. */
export function project(files: Files): Files {
  return { "package.json": PKG, ...files };
}

/** Lines joined with newlines and a trailing one: keeps line numbers visible in the test. */
export function src(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/** 1-based line of the first line of `text` that contains `needle`. */
export function lineOf(text: string, needle: string): number {
  const at = text.split("\n").findIndex((l) => l.includes(needle));
  if (at < 0) throw new Error(`no line contains ${JSON.stringify(needle)}`);
  return at + 1;
}

export async function run(files: Files, opts?: ValidateOptions): Promise<ValidationResult> {
  return validate(await loadProject(files), opts);
}

export function only(result: ValidationResult, id: string): Finding[] {
  return result.findings.filter((f) => f.id === id);
}

/** The rule fires on the project: returns its findings for further assertions. */
export async function fires(
  id: string,
  files: Files,
  opts?: ValidateOptions,
): Promise<{ hits: Finding[]; result: ValidationResult }> {
  const result = await run(files, opts);
  const hits = only(result, id);
  expect(
    hits.length > 0,
    `${id} on the violating project: ${JSON.stringify(result.findings.map((f) => f.id))}`,
  ).toBe(EXPECT_FINDING);
  return { hits, result };
}

/** The rule stays quiet on the project (the fixed version of a violating one). */
export async function quiet(
  id: string,
  files: Files,
  opts?: ValidateOptions,
): Promise<ValidationResult> {
  const result = await run(files, opts);
  expect(
    only(result, id).map((f) => `${f.file}:${f.line} ${f.message}`),
    `${id} on the fixed project`,
  ).toEqual(EXPECT_FINDING ? [] : ["(inverted)"]);
  return result;
}

/** The two tests every rule owes: it fires on the violation, and goes quiet once fixed. */
export function ruleCase(
  id: string,
  spec: {
    violating: Files;
    fixed: Files;
    /** Where the finding must point. */
    at: { file: string; line?: number };
    message?: RegExp;
    opts?: ValidateOptions;
  },
): void {
  it(`${id} fires on the violating project`, async () => {
    const { hits } = await fires(id, spec.violating, spec.opts);
    expect(hits[0].file).toBe(spec.at.file);
    if (spec.at.line !== undefined) expect(hits[0].line).toBe(spec.at.line);
    if (spec.message) expect(hits[0].message).toMatch(spec.message);
  });
  it(`${id} is quiet once the project is fixed`, async () => {
    await quiet(id, spec.fixed, spec.opts);
  });
}
