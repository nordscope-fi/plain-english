import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { lintText } from "../src/lint.ts";
import { compile, loadConfig, loadDefault } from "../src/rules.ts";

describe("pattern families", () => {
  it("summarises a cluster while keeping its findings", () => {
    const result = lintText(
      "Furthermore, this is seamless. Moreover, it is cutting-edge. In conclusion, it is holistic.",
      compile(loadDefault()),
    );
    const family = result.findings.find((finding) => finding.ruleId === "family-empty-framing");
    expect(family).toMatchObject({ severity: "warn", family: "empty-framing", hitCount: 3 });
    expect(family?.relatedRuleIds).toEqual(["furthermore", "in-conclusion", "moreover"]);
    expect(result.findings.map((finding) => finding.ruleId)).toContain("seamless");
  });

  it("does not summarise isolated or single-rule repetition", () => {
    const set = compile(loadDefault());
    expect(lintText("Furthermore, test it. Moreover, ship it.", set).findings.some((finding) => finding.ruleId.startsWith("family-"))).toBe(false);
    expect(lintText("Furthermore, test it. Furthermore, ship it. Furthermore, report it.", set).findings.some((finding) => finding.ruleId.startsWith("family-"))).toBe(false);
  });

  it("summarises repeated scripted transitions", () => {
    const result = lintText(
      "Here's the thing: one job failed. The real question is why it failed. Here's what that means in practice: inspect the log.",
      compile(loadDefault()),
    );
    const family = result.findings.find((finding) => finding.ruleId === "family-mechanical-transition");
    expect(family).toMatchObject({ severity: "warn", family: "mechanical-transition", hitCount: 3 });
    expect(family?.relatedRuleIds).toEqual(["heres-the-thing", "real-question-hook", "what-that-means-hook"]);
  });

  it("can suppress only the summary", () => {
    const text = "<!-- plain-english-disable-next-line family-empty-framing: quoted example -->\nFurthermore, this starts. Moreover, this continues. In conclusion, this ends.";
    const result = lintText(text, compile(loadDefault()));
    expect(result.findings.some((finding) => finding.ruleId === "family-empty-framing")).toBe(false);
    expect(result.findings.some((finding) => finding.ruleId === "furthermore")).toBe(true);
  });

  it("lets a project change the threshold or turn off the summary", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plain-english-family-"));
    try {
      const path = resolve(root, ".plain-english.yml");
      writeFileSync(path, "version: 1\nextends: default\nfamilies:\n  - id: empty-framing\n    severity: off\n    minFindings: 4\n");
      const family = compile(loadConfig(path)).families?.find((row) => row.id === "empty-framing");
      expect(family).toMatchObject({ severity: "off", minFindings: 4 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
