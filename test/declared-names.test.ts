import { describe, expect, it } from "vitest";
import { lintText } from "../src/lint.ts";
import { chatRuleSet, compile, loadDefault, loadConfig, merge } from "../src/rules.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const defaults = loadDefault();
const rules = (names?: string[], maxTerms = 2) => compile({ ...defaults, rules: [], readability: [{ id: "reader-load", kind: "reader-load", severity: "error", maxTerms, ...(names ? { names } : {}) }] });
const finding = (text: string, names?: string[], max = 2) => lintText(text, rules(names, max)).findings.find(f => f.ruleId === "reader-load");

describe("declared reader names", () => {
  it("counts ordinary-looking tool names only when declared", () => {
    const text = "Cursor, Codex and Vibe check the project.";
    expect(finding(text)).toBeUndefined();
    expect(finding(text, ["Cursor", "Codex", "Vibe"])?.message).toContain("3 separate names");
  });

  it("preserves casing and avoids matching names inside words", () => {
    expect(finding("The cursor moves. The vibe changes. Recursor runs.", ["Cursor", "Vibe"], 1)).toBeUndefined();
    expect(finding("Cursor and Vibe run.", ["Cursor", "Vibe"], 1)).toBeDefined();
    expect(finding("αCursor and αVibe run.", ["Cursor", "Vibe"], 1)).toBeUndefined();
  });

  it("counts repeated names once and combines them with identifiers", () => {
    expect(finding("Cursor and `Cursor` run. Cursor runs again.", ["Cursor"], 1)).toBeUndefined();
    expect(finding("Cursor runs the reader-load check.", ["Cursor"], 1)?.message).toContain("2 separate names");
  });

  it("treats regular-expression characters as literal name characters", () => {
    expect(finding("AxxxB runs. Cccc runs.", ["A.*B", "C++"], 1)).toBeUndefined();
    expect(finding("A.*B and C++ run.", ["A.*B", "C++"], 1)?.message).toContain("2 separate names");
  });

  it("allows projects to replace and clear inherited names", () => {
    const first = { ...defaults, chat: { ...defaults.chat, limits: defaults.chat.limits.map(row => row.id === "reader-load" ? { ...row, names: ["Cursor"] } : row) } };
    const overlay = { ...defaults, chat: { ...defaults.chat, limits: [{ id: "reader-load", severity: "error" as const, names: ["Vibe"] }] } };
    expect(merge(first, overlay).chat.limits.find(row => row.id === "reader-load")?.names).toEqual(["Vibe"]);
    overlay.chat.limits[0]!.names = [];
    expect(merge(first, overlay).chat.limits.find(row => row.id === "reader-load")?.names).toEqual([]);
    expect(first.chat.limits.find(row => row.id === "reader-load")?.names).toEqual(["Cursor"]);
  });

  it("loads names through a real project configuration and reaches chat checks", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-declared-names-"));
    try {
      writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nchat:\n  limits:\n    - id: reader-load\n      maxTerms: 2\n      severity: error\n      names: [Cursor, Codex, Vibe]\n");
      const configuration = merge(defaults, loadConfig(resolve(dir, ".plain-english.yml"))!);
      const result = lintText("Cursor, Codex and Vibe run.", chatRuleSet(configuration));
      expect(result.findings.find(f => f.ruleId === "reader-load")?.message).toContain("3 separate names");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["names: Cursor", "names: [123]", "names: ['']", `names: ['${"x".repeat(81)}']`])("rejects invalid declarations: %s", value => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-declared-invalid-"));
    try {
      writeFileSync(resolve(dir, "invalid.yml"), `version: 1\nchat:\n  limits:\n    - id: reader-load\n      ${value}\n`);
      expect(() => loadConfig(resolve(dir, "invalid.yml"))).toThrow(/names/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
