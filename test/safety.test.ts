import { describe, expect, it } from "vitest";
import { findUnsafe, isSafe, matchAllWithDeadline } from "../src/safe-regex.ts";
import { compile, loadDefault, RuleError, type RuleSet } from "../src/rules.ts";
import { lintText } from "../src/lint.ts";

/** Build a minimal ruleset around one pattern. */
function setWith(match: string, extra: Partial<RuleSet> = {}): RuleSet {
  return {
    version: 1,
    meta: { title: "", intro: "" },
    rules: [{ id: "probe", severity: "error", match, unless: [] }],
    structures: [],
    allow: [],
    exclude: [],
    ...extra,
  };
}

describe("catastrophic backtracking is refused at config load", () => {
  // Measured before the guard existed: this pattern against 30 characters ran
  // for 142 seconds. A config is user-supplied and runs inside a blocking hook.
  it.each([
    ["(a+)+$", "nested-quantifier"],
    ["(a*)*b", "nested-quantifier"],
    ["(\\d+)+x", "nested-quantifier"],
    ["(?:x{1,9})+y", "nested-quantifier"],
    ["(a|a)+$", "overlapping-alternation"],
    ["(a|ab)*c", "overlapping-alternation"],
  ])("rejects %s", (pattern, kind) => {
    const unsafe = findUnsafe(pattern);
    expect(unsafe, `${pattern} was accepted`).not.toBeNull();
    expect(unsafe!.kind).toBe(kind);
  });

  it("names the offending rule in the error", () => {
    expect(() => compile(setWith("(a+)+$"))).toThrow(RuleError);
    try {
      compile(setWith("(a+)+$"));
    } catch (e) {
      expect((e as Error).message).toContain("probe");
      expect((e as Error).message).toContain("backtrack");
    }
  });

  it("would otherwise hang: the guard makes this test terminate", () => {
    const started = Date.now();
    expect(() => compile(setWith("(a+)+$"))).toThrow();
    // Without the guard this line is reached ~142s later, via lintText.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("checks unless clauses and the allow list too", () => {
    expect(() =>
      compile(setWith("safe", { rules: [{ id: "p", severity: "error", match: "x", unless: ["(a+)+$"] }] })),
    ).toThrow(RuleError);
    expect(() => compile(setWith("x", { allow: ["(a+)+$"] }))).toThrow(RuleError);
  });

  it("accepts every pattern in the shipped ruleset", () => {
    for (const rule of loadDefault().rules) {
      if (!rule.match) continue;
      expect(isSafe(rule.match), `${rule.id}: ${rule.match}`).toBe(true);
      for (const u of rule.unless ?? []) {
        expect(isSafe(u), `${rule.id} unless: ${u}`).toBe(true);
      }
    }
  });

  it("does not reject ordinary patterns", () => {
    for (const ok of [
      "\\bseamless(ly)?\\b",
      "\\bdelv(e|es|ed|ing)\\b",
      "\\bcutting[- ]edge\\b",
      "\\bas an AI\\b|\\bas a large language model\\b",
      "hs_[a-z_]+",
      "\\b(financial|operating)\\s+leverage\\b",
    ]) {
      expect(isSafe(ok), ok).toBe(true);
    }
  });
});

describe("match deadline is the backstop", () => {
  it("returns results normally within budget", () => {
    const out = matchAllWithDeadline(/a/g, "banana", 1000);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);
  });

  it("returns null instead of hanging when the budget is exhausted", () => {
    const out = matchAllWithDeadline(/a/g, "a".repeat(200_000), 0);
    expect(out).toBeNull();
  });

  it("does not spin on a zero-length match", () => {
    const out = matchAllWithDeadline(/(?:)/g, "abc", 1000);
    expect(out).not.toBeNull();
  });
});

describe("allow suppresses a real finding on the line", () => {
  const base = compile(loadDefault());

  it("a bare rule fires without an allow entry", () => {
    expect(lintText("We leverage the cache.", base).errorCount).toBe(1);
  });

  // This is the bug: `allow` used to be tested against the matched term only,
  // so a phrase entry could never match and the shipped example was inert.
  it("a phrase allow entry suppresses it", () => {
    const set = compile({ ...loadDefault(), allow: ["leverage the cache"] });
    expect(lintText("We leverage the cache.", set).errorCount).toBe(0);
  });

  it("a vocabulary allow entry suppresses findings on the same line", () => {
    const set = compile({ ...loadDefault(), allow: ["\\bMRR\\b"] });
    expect(lintText("MRR grew after we leverage the new plan.", set).errorCount).toBe(0);
    // A line without the vocabulary term is still checked.
    expect(lintText("We leverage the new plan.", set).errorCount).toBe(1);
  });

  it("an allow entry matching the term itself still works", () => {
    const set = compile({ ...loadDefault(), allow: ["\\bleverage\\b"] });
    expect(lintText("We leverage the cache.", set).errorCount).toBe(0);
  });
});

describe("unknown config keys are rejected", () => {
  it("suggests the intended key", async () => {
    const { loadConfig } = await import("../src/rules.ts");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const dir = mkdtempSync(resolve(tmpdir(), "pe-cfg-"));
    const path = resolve(dir, "c.yml");
    writeFileSync(path, "version: 1\nextends: default\nallowlist: [typo]\n");
    expect(() => loadConfig(path)).toThrow(/unknown key 'allowlist'.*Did you mean 'allow'/s);
  });
});
