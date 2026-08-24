import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintText } from "../src/lint.ts";
import { compile, loadDefault } from "../src/rules.ts";

/**
 * Sentence spread.
 *
 * Every other readability rule here judges one sentence. This one judges the
 * set: how widely the lengths vary. Hand-edited prose swings; generated prose
 * clusters, and it goes on clustering after the giveaway words are edited out,
 * which is the reason the rule exists.
 *
 * Measured 2026-08-24. One cover letter written by a model and then revised by
 * hand to remove the word-level tells still scored 0.414 across 43 sentences.
 * Every document in this repository with 20 or more sentences scored 0.492 or
 * above, across a per-file range of 0.492 to 0.745.
 */
const set = compile(loadDefault());
const fired = (text: string) =>
  lintText(text, set).findings.some((f) => f.ruleId === "sentence-spread");

/** Thirty sentences, all exactly twelve words. Nothing varies. */
const uniform = Array.from(
  { length: 30 },
  (_, i) => `Step ${i} covers ` + Array.from({ length: 9 }, () => "work").join(" ") + ".",
).join(" ");

/** Thirty sentences alternating four words and twenty-four. */
const varied = Array.from({ length: 30 }, (_, i) =>
  i % 2 === 0
    ? `Step ${i} is done.`
    : `Step ${i} covers ` + Array.from({ length: 21 }, () => "work").join(" ") + ".",
).join(" ");

describe("sentence-spread", () => {
  it("fires on prose whose sentences are all one length", () => {
    expect(fired(uniform)).toBe(true);
  });

  it("leaves prose that varies alone", () => {
    expect(fired(varied)).toBe(false);
  });

  it("says nothing below the sentence floor, where spread means nothing", () => {
    const short = Array.from({ length: 6 }, (_, i) => `Step ${i} covers the same ground here.`)
      .join(" ");
    expect(fired(short)).toBe(false);
  });

  it("names the number, so the finding can be checked", () => {
    const f = lintText(uniform, set).findings.find((x) => x.ruleId === "sentence-spread");
    expect(f?.message).toMatch(/spread/i);
  });

  /**
   * The near miss that set the threshold.
   *
   * At 0.50 this rule fired on a 292-sentence hand-written page scoring 0.495.
   * The aggregate figure for `docs/` was 0.567 and hid it. This case exists so
   * a later change to the threshold cannot lose that.
   */
  it("leaves the repository's own densest document alone", () => {
    const root = resolve(import.meta.dirname, "..");
    const text = readFileSync(resolve(root, "docs/agents.md"), "utf8");
    expect(fired(text)).toBe(false);
  });
});
