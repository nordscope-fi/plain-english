import { describe, expect, it } from "vitest";
import { loadDefault } from "../src/rules.ts";
import { projectGuidance } from "../src/guidance.ts";

describe("project guidance for the native plugin", () => {
  it("adds only declared vocabulary and loaded profile guidance", () => {
    const base = loadDefault();
    expect(projectGuidance(base)).toBe("");
    const set = {
      ...base,
      allow: [{ pattern: "BuildKit", rules: ["unglossed-term"], semantic: true }],
      profileGuidance: ["Use the repository's established spelling."],
      readability: base.readability.map((rule) => rule.kind === "unglossed-term"
        ? { ...rule, known: [...(rule.known ?? []), "RPO"] } : rule),
    };
    const text = projectGuidance(set);
    expect(text).toContain("BuildKit");
    expect(text).toContain("RPO");
    expect(text).toContain("established spelling");
    expect(text).not.toContain("The shape of a reply");
  });
  it("does not interpret ordinary exceptions as vocabulary knowledge", () => {
    const base = loadDefault();
    expect(projectGuidance({ ...base, allow: [{ pattern: "BuildKit", rules: ["leverage"], semantic: false }] })).toBe("");
  });
});
