import { describe, expect, it } from "vitest";
import { lintText } from "../src/lint.ts";
import { compile, loadDefault, type RuleSet } from "../src/rules.ts";

const EM = "—";

/** The shipped ruleset with the density rule swapped in for the ban. */
function densityRuleSet(): RuleSet {
  const set = loadDefault();
  for (const r of set.rules) {
    if (r.id === "em-dash") r.severity = "off";
    if (r.id === "em-dash-density") r.severity = "warn";
  }
  return compile(set);
}

/**
 * `n` words of filler, broken into sentences of varying length.
 *
 * One unbroken run of a thousand words is a single sentence, which the
 * readability rules correctly report as too long. That made these density
 * assertions fail for a reason that had nothing to do with density.
 *
 * The lengths cycle rather than repeat, for the same class of reason. Every
 * sentence being exactly ten words is what `sentence-spread` exists to report,
 * so uniform filler failed these assertions on a second count that again had
 * nothing to do with density. The cycle averages ten, so the word budget each
 * test depends on is unchanged.
 */
// Mean ten, spread 0.54, which clears `sentence-spread`'s 0.45 with room.
const CHUNKS = [3, 18, 6, 14, 9];

function words(n: number): string {
  const all = Array.from({ length: n }, (_, i) => `word${i}`);
  const out: string[] = [];
  for (let i = 0, c = 0; i < all.length; c++) {
    const size = CHUNKS[c % CHUNKS.length]!;
    const chunk = all.slice(i, i + size);
    i += size;
    // Capitalise the first word. A full stop followed by a lowercase word
    // reads as an abbreviation to the sentence parser, which is the same
    // heuristic that stops it splitting "e.g. Vale" in two, so lowercase
    // filler produced one sentence of a thousand words.
    chunk[0] = `W${chunk[0]!.slice(1)}`;
    out.push(chunk.join(" ") + ".");
  }
  return out.join(" ");
}

describe("density rules fire on rate, not presence", () => {
  const set = densityRuleSet();

  it("ships off by default so the ban stays the default", () => {
    const shipped = loadDefault();
    expect(shipped.rules.find((r) => r.id === "em-dash")?.severity).toBe("error");
    expect(shipped.rules.find((r) => r.id === "em-dash-density")?.severity).toBe("off");
  });

  it("one em dash in 1000 words is below the human baseline and passes", () => {
    const text = `${words(999)} a ${EM} b`;
    expect(lintText(text, set).findings.map((f) => f.ruleId)).toEqual([]);
  });

  it("three em dashes in 1000 words matches the human baseline and passes", () => {
    const text = `${words(997)} a ${EM} b ${EM} c ${EM} d`;
    expect(lintText(text, set).findings.map((f) => f.ruleId)).toEqual([]);
  });

  it("ten em dashes in 1000 words is model-shaped and fires", () => {
    const text = `${words(990)} ${Array.from({ length: 10 }, () => `x ${EM} y`).join(" ")}`;
    const ids = lintText(text, set).findings.map((f) => f.ruleId);
    expect(ids).toContain("em-dash-density");
  });

  it("reports once, not once per occurrence", () => {
    const text = `${words(990)} ${Array.from({ length: 10 }, () => `x ${EM} y`).join(" ")}`;
    const hits = lintText(text, set).findings.filter((f) => f.ruleId === "em-dash-density");
    expect(hits).toHaveLength(1);
  });

  it("states the measured rate and the threshold", () => {
    const text = `${words(90)} ${Array.from({ length: 5 }, () => `x ${EM} y`).join(" ")}`;
    const hit = lintText(text, set).findings.find((f) => f.ruleId === "em-dash-density");
    expect(hit?.message).toMatch(/per 1,000/);
    expect(hit?.message).toMatch(/threshold/);
  });

  it("carries the explanation link", () => {
    const text = `${words(90)} ${Array.from({ length: 5 }, () => `x ${EM} y`).join(" ")}`;
    const hit = lintText(text, set).findings.find((f) => f.ruleId === "em-dash-density");
    expect(hit?.link).toContain("limitations.md");
  });

  it("does not count em dashes inside code", () => {
    const text = ["```", Array.from({ length: 20 }, () => `a ${EM} b`).join("\n"), "```"].join("\n");
    expect(lintText(text, set).findings.map((f) => f.ruleId)).toEqual([]);
  });

  it("an empty document produces nothing", () => {
    expect(lintText("", set).findings).toEqual([]);
  });
});

describe("the shipped default still bans outright", () => {
  const set = compile(loadDefault());

  it("one em dash blocks", () => {
    expect(lintText(`a ${EM} b`, set).errorCount).toBe(1);
  });

  it("the ban carries the link to the evidence", () => {
    const hit = lintText(`a ${EM} b`, set).findings.find((f) => f.ruleId === "em-dash");
    expect(hit?.link).toContain("limitations.md");
  });
});
