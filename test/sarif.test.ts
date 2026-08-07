import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { toSarif } from "../src/format/sarif.ts";
import { lintText } from "../src/lint.ts";
import { compile, loadDefault } from "../src/rules.ts";

/**
 * SARIF earns its place for a reason that is not CI.
 *
 * GitHub code scanning ingests it and annotates a pull request, which is the
 * obvious half. The other half is that a SARIF file renders into VS Code's
 * Problems list, and several coding agents read that list and act on what they
 * find. So this one serializer reaches agents this package has no adapter for.
 *
 * What is asserted here is GitHub's documented ingest subset. A field with no
 * consumer is not emitted, so a missing one here is a real gap rather than an
 * incomplete implementation of a large spec.
 */
const ruleSet = compile(loadDefault());
const ROOT = resolve("/repo");

function sarifFor(file: string, text: string) {
  const res = lintText(text, ruleSet);
  return toSarif([{ file, findings: res.findings }], ruleSet, {
    root: ROOT,
    version: "9.9.9",
  }) as any;
}

describe("the log envelope", () => {
  const log = sarifFor(resolve(ROOT, "docs/x.md"), "We leverage this.");

  it("declares the schema and version GitHub checks for", () => {
    expect(log.$schema).toContain("sarif-2.1.0");
    expect(log.version).toBe("2.1.0");
  });

  it("names the tool and its version", () => {
    const driver = log.runs[0].tool.driver;
    expect(driver.name).toBe("plain-english");
    expect(driver.version).toBe("9.9.9");
    expect(driver.semanticVersion).toBe("9.9.9");
    expect(driver.informationUri).toContain("plain-english");
  });

  it("has exactly one run", () => {
    expect(log.runs).toHaveLength(1);
  });
});

describe("results", () => {
  const log = sarifFor(resolve(ROOT, "docs/x.md"), "We leverage this.");
  const result = log.runs[0].results[0];

  it("carries the rule id and a message", () => {
    expect(result.ruleId).toBe("leverage");
    expect(result.message.text).toBeTruthy();
  });

  it("points at a line and column in the file", () => {
    const region = result.locations[0].physicalLocation.region;
    expect(region.startLine).toBe(1);
    expect(region.startColumn).toBe(4);
    // endColumn is exclusive in SARIF: the character after the match.
    expect(region.endColumn).toBe(4 + "leverage".length);
    expect(region.snippet.text).toBe("We leverage this.");
  });

  it("gives a path relative to the scanned root, with forward slashes", () => {
    const uri = result.locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe("docs/x.md");
    // A Windows path with backslashes is accepted by nothing that reads SARIF.
    expect(uri).not.toContain("\\");
  });

  it("uses an absolute file URI for a file outside the scanned root", () => {
    // GitHub code scanning rejects a path that climbs out of the repository,
    // and `lint /some/other/place` is a legitimate thing to run.
    const log = sarifFor(resolve("/elsewhere/x.md"), "We leverage this.");
    const uri = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri.startsWith("file://")).toBe(true);
    expect(uri).not.toContain("..");
  });
});

describe("severity maps onto SARIF's two levels", () => {
  it("a blocking rule is an error", () => {
    const log = sarifFor(resolve(ROOT, "x.md"), "We leverage this.");
    expect(log.runs[0].results[0].level).toBe("error");
  });

  it("a warning rule is a warning", () => {
    // unglossed-term ships as a warning, and SARIF calls that `warning`.
    const log = sarifFor(resolve(ROOT, "x.md"), "The OIDC check runs first.");
    const levels = log.runs[0].results.map((r: any) => r.level);
    expect(levels).toContain("warning");
    expect(levels).not.toContain("error");
  });
});

describe("rule metadata", () => {
  it("describes only the rules that fired", () => {
    const log = sarifFor(resolve(ROOT, "x.md"), "We leverage this.");
    const ids = log.runs[0].tool.driver.rules.map((r: any) => r.id);
    expect(ids).toEqual(["leverage"]);
    // The full ruleset is 41 entries and a typical run touches one or two.
    expect(ids.length).toBeLessThan(ruleSet.rules.length);
  });

  it("carries the rule's own link as helpUri when it has one", () => {
    const log = sarifFor(resolve(ROOT, "x.md"), "The OIDC check runs first.");
    const rule = log.runs[0].tool.driver.rules.find((r: any) => r.id === "unglossed-term");
    expect(rule.helpUri).toContain("writing-style.md");
  });

  it("omits `name`, which SARIF forbids duplicating `id`", () => {
    // SARIF1001 from the official validator. A rule id here is already the
    // readable name, so there is nothing for a second field to say.
    const log = sarifFor(resolve(ROOT, "x.md"), "We leverage this.");
    for (const rule of log.runs[0].tool.driver.rules) {
      expect(rule.name).toBeUndefined();
    }
  });

  it("every result's ruleId has a descriptor", () => {
    const log = sarifFor(resolve(ROOT, "x.md"), "We leverage this to showcase the OIDC flow.");
    const described = new Set(log.runs[0].tool.driver.rules.map((r: any) => r.id));
    for (const r of log.runs[0].results) {
      expect(described.has(r.ruleId), `${r.ruleId} has no rule descriptor`).toBe(true);
    }
  });
});

describe("a clean run", () => {
  const log = sarifFor(resolve(ROOT, "x.md"), "The cache holds parsed results.") as any;

  it("is still a valid log with no results", () => {
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].tool.driver.rules).toEqual([]);
    expect(log.version).toBe("2.1.0");
  });
});
