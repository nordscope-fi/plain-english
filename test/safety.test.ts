import { describe, expect, it } from "vitest";
import { findUnsafe, isSafe, matchAllWithDeadline } from "../src/safe-regex.ts";
import { COMMAND_PATTERNS, MAX_COMMAND_BYTES, extractFromBash } from "../src/adapters/hook.ts";
import { compile, KNOWN_TOP_LEVEL, loadDefault, RuleError, type RuleSet } from "../src/rules.ts";
import { lintText } from "../src/lint.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

/** Build a minimal ruleset around one pattern. */
function setWith(match: string, extra: Partial<RuleSet> = {}): RuleSet {
  return {
    version: 1,
    meta: { title: "", intro: "" },
    rules: [{ id: "probe", severity: "error", match, unless: [] }],
    // Both added after this helper was written. Omitting them built a RuleSet
    // that compiled fine and crashed the moment lintText reached the
    // readability pass, which no test had done before the deadline cases.
    readability: [],
    failOn: "never",
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

describe("match deadline bounds a large match count", () => {
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

/**
 * `rules/schema.json` is not wired into the load path, so nothing caught it
 * drifting: it lost `failOn`, `readability`, `perThousandWords` and `link`
 * across three releases while claiming `additionalProperties: false`. An
 * editor pointed at it would have rejected this repo's own config.
 */
describe("the published schema mirrors the loader", () => {
  const schema = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "rules", "schema.json"), "utf8"),
  ) as { properties: Record<string, unknown>; additionalProperties: boolean };

  it("accepts exactly the keys the loader accepts", () => {
    expect(new Set(Object.keys(schema.properties))).toEqual(KNOWN_TOP_LEVEL);
  });

  it("is still closed, which is what makes the mirror matter", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it("covers every top-level key the shipped ruleset uses", () => {
    const raw = parse(
      readFileSync(resolve(import.meta.dirname, "..", "rules", "default.yml"), "utf8"),
    ) as Record<string, unknown>;
    for (const key of Object.keys(raw)) expect(schema.properties).toHaveProperty(key);
  });
});


/**
 * The match deadline, wired into the engine.
 *
 * `matchAllWithDeadline` shipped exported, tested and described as the runtime
 * backstop from 0.1.0, and `lintText` never called it.
 *
 * Wiring it in also established what it cannot do. A JavaScript regex match is
 * atomic: no userland check runs during a single `exec`, so a deadline between
 * matches bounds a pattern that returns a huge NUMBER of matches and does
 * nothing about one match that backtracks exponentially. Refusing that pattern
 * at load is the only defence, which is why the screen matters more than this.
 */
describe("the engine honours a match budget", () => {
  const many = compile(setWith("a"));

  it("reports every rule ran on an ordinary document", () => {
    expect(lintText("We leverage the cache.", compile(loadDefault())).timedOut).toEqual([]);
  });

  it("abandons a rule whose match count exhausts the budget", () => {
    const res = lintText("a".repeat(200_000), many, { budgetMs: 0 });
    expect(res.timedOut).toContain("probe");
  });

  it("a timed-out rule reports nothing rather than a partial count", () => {
    const res = lintText("a".repeat(200_000), many, { budgetMs: 0 });
    expect(res.findings.filter((f) => f.ruleId === "probe")).toEqual([]);
  });

  it("an exhausted budget never becomes a blocking finding", () => {
    // Fail-open: a linter that cannot finish must not refuse the write.
    expect(lintText("a".repeat(200_000), many, { budgetMs: 0 }).errorCount).toBe(0);
  });

  it("the budget is shared across rules, not granted to each", () => {
    const two = compile(
      setWith("a", {
        rules: [
          { id: "one", severity: "error", match: "a", unless: [] },
          { id: "two", severity: "error", match: "a", unless: [] },
        ],
      }),
    );
    const res = lintText("a".repeat(200_000), two, { budgetMs: 0 });
    expect(res.timedOut).toEqual(["one", "two"]);
  });
});

/**
 * The screen is the real defence, so a shape that slips past it is a hole.
 *
 * `^(?:[ab]|ab)+$` passed `findUnsafe` and hangs the linter: `skeleton` blanks
 * a character class down to `[]`, so the overlap check compared a `[` against
 * an `a` and saw two different first characters. A 49-character document took
 * 207ms; adding sixteen characters takes it past any timeout worth having.
 */
describe("overlapping alternations are seen through character classes", () => {
  it("rejects a class that overlaps a literal alternative", () => {
    expect(findUnsafe("^(?:[ab]|ab)+$")).not.toBeNull();
    expect(findUnsafe("^(?:[ab]|ab)+$")!.kind).toBe("overlapping-alternation");
  });

  it("rejects it in either order", () => {
    expect(findUnsafe("(?:a|[abc])*")).not.toBeNull();
    expect(findUnsafe("(?:[a-z]|ab)+")).not.toBeNull();
  });

  it("still accepts disjoint alternatives", () => {
    expect(findUnsafe("(?:cat|dog)+")).toBeNull();
    expect(findUnsafe("(?:[0-9]|[a-f])+")).toBeNull();
  });

  it("leaves an unquantified alternation alone", () => {
    // The shipped word rules are all this shape. Without a quantifier on the
    // group there is nothing to backtrack over.
    expect(findUnsafe("\\bleverag(e|es|ed|ing)\\b")).toBeNull();
  });

  it("refuses rather than guesses when it cannot model a class", () => {
    // A negated class is the complement of a set, so it may overlap anything.
    expect(findUnsafe("(?:[^x]|ab)+")).not.toBeNull();
  });

  it("admits every pattern the shipped ruleset uses", () => {
    // The compatibility check. A screen that rejects the default rules is a
    // screen nobody can ship.
    const set = loadDefault();
    const all = [...(set.punctuation ?? []), ...set.rules];
    for (const r of all) {
      if (r.match) expect(findUnsafe(r.match), `${r.id} match`).toBeNull();
      for (const u of r.unless ?? []) expect(findUnsafe(u), `${r.id} unless`).toBeNull();
    }
    for (const a of set.allow ?? []) expect(findUnsafe(a), "allow").toBeNull();
  });
});

/**
 * The extraction patterns get the same screen as a config pattern.
 *
 * `heredocBodies` had `\s*` in front of its back-reference, overlapping the
 * lazy `[\s\S]*?` before it. An unterminated heredoc whose body was blank
 * lines backtracked quadratically: 3.1s at 50KB, 12.5s at 100KB, 49.7s at
 * 200KB, 200s at 400KB. It ran inside a blocking pre-tool-call hook, reachable
 * from any `git commit` or `gh` command an agent writes.
 *
 * Nothing had ever looked at it. `findUnsafe` screens patterns that arrive
 * from a project's configuration, and `HOOK_BUDGET_MS` is handed to `lintText`
 * and covers no part of extraction. A regex is not safer for having been
 * written in TypeScript rather than in YAML, so these are screened too.
 */
describe("the adapter's own patterns are screened", () => {
  /**
   * `INLINE_FLAG` is the one exception, and it is the screen being cautious
   * rather than the pattern being unsafe.
   *
   * It contains `(?:[^"\\]|\\.)*`, the standard unrolled loop for a quoted
   * string. The two alternatives are disjoint: the class excludes backslash
   * and the escape requires one, so the engine fails fast. `firstSet` cannot
   * compute the first-set of a negated class, returns null, and `intersects`
   * reads null as "might overlap". Erring that way is right for a screen that
   * runs on somebody's config, so the pattern is measured instead. Widening
   * the screen to understand negated classes belongs in its own change.
   */
  const CONSERVATIVE = new Set(["INLINE_FLAG"]);

  it("passes findUnsafe, the same check a config pattern gets", () => {
    for (const [name, re] of Object.entries(COMMAND_PATTERNS)) {
      if (CONSERVATIVE.has(name)) continue;
      expect(findUnsafe(re.source), `${name} is unsafe`).toBeNull();
    }
  });

  it("matches the conservatively-rejected pattern in linear time", () => {
    // An unterminated quoted value, which is the input that would expose a
    // genuinely overlapping alternation here.
    for (const kb of [10, 160]) {
      const cmd = 'git commit -m "' + "a\\".repeat(kb * 256);
      const re = new RegExp(COMMAND_PATTERNS["INLINE_FLAG"]!.source, "g");
      const started = performance.now();
      re.exec(cmd);
      const ms = performance.now() - started;
      expect(ms, `${kb}KB took ${ms.toFixed(0)}ms`).toBeLessThan(500);
    }
  });

  it("extracts a heredoc in bounded time, however malformed", () => {
    // The shape that hung: a heredoc opened and never closed.
    for (const kb of [50, 200]) {
      const cmd = "git commit -F - <<EOF\n" + " \n".repeat(kb * 512);
      const started = performance.now();
      extractFromBash(cmd);
      const ms = performance.now() - started;
      // Two orders of magnitude of headroom over the fixed timings, so a slow
      // machine does not make this flaky, and 3,121ms still fails.
      expect(ms, `${kb}KB took ${ms.toFixed(0)}ms`).toBeLessThan(500);
    }
  });

  it("stops reading a command that is not a commit message", () => {
    const huge = "git commit -m \"" + "a".repeat(MAX_COMMAND_BYTES) + "\"";
    expect(extractFromBash(huge)).toEqual([]);
  });

  it("still reads the heredocs that matter", () => {
    expect(extractFromBash("git commit -F - <<EOF\nWe leverage this.\nEOF\n")).toEqual([
      "We leverage this.",
    ]);
    // `<<-` allows a tab-indented terminator, which is the only indentation
    // the narrowed pattern still accepts.
    expect(extractFromBash("git commit -F - <<-EOF\nWe leverage this.\n\tEOF\n")).toEqual([
      "We leverage this.",
    ]);
  });
});
