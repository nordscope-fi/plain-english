import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/markdown.ts";
import { lintText } from "../src/lint.ts";
import { compile, loadDefault } from "../src/rules.ts";
import { sentences } from "../src/sentences.ts";

/**
 * One check used to parse its document up to nine times (#156). The tree is
 * now kept for the last document, which is only safe while every caller reads
 * it and none changes it.
 */
describe("parseMarkdown", () => {
  it("returns the kept tree for the same text and a new one for other text", () => {
    const first = parseMarkdown("One paragraph.\n\nAnother one.");
    expect(parseMarkdown("One paragraph.\n\nAnother one.")).toBe(first);
    const other = parseMarkdown("A different document.");
    expect(other).not.toBe(first);
    expect(parseMarkdown("One paragraph.\n\nAnother one.")).not.toBe(other);
  });

  it("gives the same findings when one document is checked twice in a row", () => {
    const set = compile(loadDefault());
    const text = [
      "# Notes",
      "",
      "We will leverage the cache. Furthermore, it is worth noting the API is fast.",
      "",
      "Use <code>leverage()</code> here. <!-- a comment -->",
      "",
      "> A quoted line that would delve into details.",
    ].join("\n");
    const once = lintText(text, set).findings;
    expect(once.length).toBeGreaterThan(0);
    expect(lintText(text, set).findings).toEqual(once);
    expect(sentences(text)).toEqual(sentences(text));
  });
});
