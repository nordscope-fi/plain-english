import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { lintText } from "../src/lint.ts";
import {
  RuleError,
  compile,
  loadConfig,
  loadDefault,
  merge,
  type RuleSet,
} from "../src/rules.ts";

/**
 * Suppression directives, and the reason each one has to carry.
 *
 * The reason syntax is a colon tail. Before it was parsed, a colon in a
 * directive made the whole comment fail to match, so a writer who explained a
 * waiver found the waiver had stopped waiving anything and nothing said so.
 * That failure is what the first block here holds down.
 */

function ruleSet(): RuleSet {
  return compile(loadDefault());
}

function ids(text: string): string[] {
  return lintText(text, ruleSet()).findings.map((f) => f.ruleId);
}

describe("a directive still suppresses when it carries a reason", () => {
  it("disable-next-line", () => {
    const text = [
      "A first line.",
      "<!-- plain-english-disable-next-line leverage: finance sense, leveraged buyout -->",
      "We leverage the ratio here.",
    ].join("\n");

    expect(ids(text)).not.toContain("leverage");
  });

  it("a disable range", () => {
    const text = [
      "<!-- plain-english-disable leverage: quoting the vendor verbatim -->",
      "We leverage it.",
      "<!-- plain-english-enable -->",
    ].join("\n");

    expect(ids(text)).not.toContain("leverage");
  });

  it("disable-file", () => {
    const text = [
      "<!-- plain-english-disable-file: generated reference material -->",
      "We leverage it and utilize it.",
    ].join("\n");

    expect(ids(text)).not.toContain("leverage");
    expect(ids(text)).not.toContain("utilize");
  });
});

describe("a waiver with no reason is reported", () => {
  it("fires on disable-next-line", () => {
    const text = [
      "A first line.",
      "<!-- plain-english-disable-next-line leverage -->",
      "We leverage it.",
    ].join("\n");
    const findings = lintText(text, ruleSet()).findings;

    expect(findings.map((f) => f.ruleId)).toEqual(["unexplained-suppression"]);
    expect(findings[0]!.severity).toBe("warn");
    expect(findings[0]!.line).toBe(2);
  });

  it("fires on a range", () => {
    const text = [
      "<!-- plain-english-disable leverage -->",
      "We leverage it.",
      "<!-- plain-english-enable -->",
    ].join("\n");

    expect(ids(text)).toEqual(["unexplained-suppression"]);
  });

  it("says nothing when the reason is there", () => {
    const text = [
      "A first line.",
      "<!-- plain-english-disable-next-line leverage: finance sense -->",
      "We leverage it.",
    ].join("\n");

    expect(ids(text)).toEqual([]);
  });

  it("treats an empty reason as no reason", () => {
    const text = ["<!-- plain-english-disable-file: -->", "We leverage it."].join("\n");

    expect(ids(text)).toEqual(["unexplained-suppression"]);
  });
});

/**
 * The trap this rule walks into if it respects suppression like every other
 * rule: `disable-file` silences the whole document, so a reasonless
 * `disable-file` would be the one waiver that could never be reported. The
 * same shape once made the generated style guide disable itself and lose every
 * finding without a word.
 */
describe("the rule cannot be silenced by the waiver it is judging", () => {
  it("reports a reasonless disable-file, and nothing else in the file", () => {
    const text = [
      "<!-- plain-english-disable-file -->",
      "We leverage it and utilize it.",
    ].join("\n");
    const findings = lintText(text, ruleSet()).findings;

    expect(findings.map((f) => f.ruleId)).toEqual(["unexplained-suppression"]);
  });

  it("is not silenced by a range covering its own line", () => {
    const text = [
      "<!-- plain-english-disable unexplained-suppression -->",
      "We leverage it.",
      "<!-- plain-english-enable -->",
    ].join("\n");

    expect(ids(text)).toContain("unexplained-suppression");
  });

  it("is silenced by turning it off in config", () => {
    const set = loadDefault();
    for (const r of set.readability) {
      if (r.id === "unexplained-suppression") r.severity = "off";
    }
    const text = ["<!-- plain-english-disable-file -->", "We leverage it."].join("\n");

    expect(lintText(text, compile(set)).findings).toEqual([]);
  });
});

describe("a directive quoted as documentation is not a waiver", () => {
  it("ignores one inside a fenced block", () => {
    const text = [
      "How to waive a rule:",
      "",
      "```markdown",
      "<!-- plain-english-disable-file -->",
      "```",
      "",
      "That is the whole syntax.",
    ].join("\n");

    expect(ids(text)).toEqual([]);
  });
});

/**
 * A config override is a waiver too. Turning a rule off in `.plain-english.yml`
 * silences it everywhere, which is broader than any comment, and until now it
 * recorded even less about why.
 */
describe("a config override can carry its reason", () => {
  function config(body: string): ReturnType<typeof loadConfig> {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-reason-"));
    const path = resolve(dir, ".plain-english.yml");
    writeFileSync(path, body);
    return loadConfig(path);
  }

  it("keeps the reason on a rule override", () => {
    const set = config(
      [
        "version: 1",
        "extends: default",
        "rules:",
        "  - id: leverage",
        "    severity: off",
        "    reason: finance shop, the word is literal here",
      ].join("\n"),
    );

    const rule = set.rules.find((r) => r.id === "leverage");
    expect(rule?.severity).toBe("off");
    expect(rule?.reason).toBe("finance shop, the word is literal here");
  });

  it("keeps the reason on a readability override", () => {
    const set = config(
      [
        "version: 1",
        "extends: default",
        "readability:",
        "  - id: long-sentence",
        "    severity: off",
        "    reason: the spec quotes statute text verbatim",
      ].join("\n"),
    );

    expect(set.readability.find((r) => r.id === "long-sentence")?.reason).toBe(
      "the spec quotes statute text verbatim",
    );
  });

  it("leaves the reason undefined when none is given", () => {
    const set = config(
      ["version: 1", "extends: default", "rules:", "  - id: leverage", "    severity: off"].join(
        "\n",
      ),
    );

    expect(set.rules.find((r) => r.id === "leverage")?.reason).toBeUndefined();
  });
});


/**
 * Scoped vocabulary.
 *
 * `allow` used to be one blunt instrument: it silenced every rule on any line
 * it matched, and nothing reported the cost. Measured on one repository,
 * eleven entries were added to stop the linter asking for a gloss. Nine of
 * them suppressed no gloss at all, and one was hiding 247 other findings.
 */
describe("an allow entry can name the rules it covers", () => {
  function withAllow(body: string): RuleSet {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-allow-"));
    const path = resolve(dir, ".plain-english.yml");
    writeFileSync(path, body);
    return compile(merge(loadDefault(), loadConfig(path)));
  }

  const LINE = "The Deal record is how we leverage the CRM.";

  it("a bare string still silences every rule on the line, as it always did", () => {
    const set = withAllow(
      ["version: 1", "extends: default", "allow:", "  - '\\bDeal\\b'"].join("\n"),
    );

    // The word rules are matched against the line, so an entry naming one word
    // on it silences all of them. That reach is the whole complaint.
    expect(lintText(LINE, set).findings.map((f) => f.ruleId)).not.toContain("leverage");
  });

  it("a scoped entry leaves the other rules alone", () => {
    const set = withAllow(
      [
        "version: 1",
        "extends: default",
        "allow:",
        "  - pattern: '\\bCRM\\b'",
        "    rules: [unglossed-term]",
      ].join("\n"),
    );

    const found = lintText(LINE, set).findings.map((f) => f.ruleId);
    expect(found).toContain("leverage");
    expect(found).not.toContain("unglossed-term");
  });

  it("records what it silenced, and which entry did it", () => {
    const set = withAllow(
      [
        "version: 1",
        "extends: default",
        "allow:",
        "  - pattern: '\\bCRM\\b'",
        "    rules: [unglossed-term]",
      ].join("\n"),
    );

    expect(lintText(LINE, set).suppressed).toEqual([
      { pattern: "\\bCRM\\b", ruleId: "unglossed-term", line: 1 },
    ]);
  });

  it("reports nothing suppressed when a project declares no vocabulary", () => {
    expect(lintText(LINE, compile(loadDefault())).suppressed).toEqual([]);
  });

  it("refuses a rule id nothing answers to", () => {
    expect(() =>
      withAllow(
        [
          "version: 1",
          "extends: default",
          "allow:",
          "  - pattern: '\\bCRM\\b'",
          "    rules: [unglosed-term]",
        ].join("\n"),
      ),
    ).toThrow(/no rule called 'unglosed-term'/);
  });

  it("refuses a key nobody defined", () => {
    expect(() =>
      withAllow(
        [
          "version: 1",
          "extends: default",
          "allow:",
          "  - pattern: '\\bCRM\\b'",
          "    rule: [unglossed-term]",
        ].join("\n"),
      ),
    ).toThrow(RuleError);
  });
});
