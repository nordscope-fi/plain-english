import { describe, expect, it } from "vitest";
import { humanise, renderWritingStyle, renderPrompts, renderOutputStyle, renderAll } from "../src/render.ts";
import { compile, loadDefault } from "../src/rules.ts";
import { lintText } from "../src/lint.ts";
import type { Rule } from "../src/rules.ts";
import { resolve } from "node:path";

const rule = (match: string): Rule => ({ id: "x", severity: "error", match });

describe("humanise", () => {
  it("keeps an optional group optional", () => {
    // Collapsing this to "seamlessly" tells the reader the bare word is fine.
    expect(humanise(rule("\\bseamless(ly)?\\b"))).toBe("seamless[ly]");
    expect(humanise(rule("\\bholistic(ally)?\\b"))).toBe("holistic[ally]");
    expect(humanise(rule("\\bsilent(ly)?\\b"))).toBe("silent[ly]");
  });

  it("renders a required group as a choice", () => {
    expect(humanise(rule("\\bdelv(e|es|ed|ing)\\b"))).toBe("delv(e/es/ed/ing)");
  });

  it("collapses a character class used as a separator", () => {
    expect(humanise(rule("\\bcutting[- ]edge\\b"))).toBe("cutting-edge");
  });

  it("splits top-level alternation but not nested alternation", () => {
    expect(humanise(rule("\\bas an AI\\b|\\bas a large language model\\b"))).toBe(
      "as an AI, as a large language model",
    );
    expect(humanise(rule("\\bgame[- ]chang(er|ing)\\b"))).toBe("game-chang(er/ing)");
  });

  it("renders an optional literal as the straight form", () => {
    expect(humanise(rule("\\bit'?s worth noting\\b"))).toBe("it's worth noting");
    expect(humanise(rule("\\blet'?s dive in\\b"))).toBe("let's dive in");
  });

  it("leaves no regex punctuation in the reader-facing form", () => {
    const set = compile(loadDefault());
    for (const r of set.rules) {
      if (r.severity === "off") continue;
      const text = humanise(r);
      expect(text, `${r.id} -> ${text}`).not.toMatch(/[\\?+^$]|\\b/);
    }
  });

  it("names the dashes in words", () => {
    expect(humanise(rule("—"))).toBe("em dash (—)");
    expect(humanise(rule("\\s–\\s"))).toBe("en dash used as a sentence break");
  });
});

describe("generated artifacts", () => {
  const set = compile(loadDefault());

  it("documents every rule that is not off", () => {
    const doc = renderWritingStyle(set);
    for (const r of set.rules) {
      if (r.severity === "off") continue;
      expect(doc, `rule ${r.id} missing from the generated doc`).toContain(humanise(r));
    }
  });

  it("carries the do-not-edit banner", () => {
    expect(renderWritingStyle(set)).toContain("GENERATED");
    for (const p of Object.values(renderPrompts(set))) expect(p).toContain("GENERATED");
  });

  it("lists every blocking term in each prompt", () => {
    const prompts = renderPrompts(set);
    const blocking = set.rules.filter((r) => r.severity === "error");
    for (const [name, prompt] of Object.entries(prompts)) {
      for (const r of blocking) {
        expect(prompt, `${name} prompt is missing ${r.id}`).toContain(humanise(r));
      }
    }
  });

  it("names every sentence shape in each prompt", () => {
    const prompts = renderPrompts(set);
    for (const [name, prompt] of Object.entries(prompts)) {
      for (const s of set.structures) {
        expect(prompt, `${name} prompt is missing ${s.id}`).toContain(s.name);
      }
    }
  });

  it("the generated style guide lints clean against itself", () => {
    // It quotes every banned term as reference material, so without its own
    // disable directive it reports ~30 findings against itself. An adopter
    // should not have to discover that and hand-write an exclude entry.
    const doc = renderWritingStyle(set);
    expect(doc).toContain("plain-english-disable-file");
    expect(lintText(doc, set).errorCount).toBe(0);
  });

  it("commits no absolute path, only the placeholder", () => {
    const prompts = renderPrompts(set);
    expect(prompts["docs"]).toContain("{{PROJECT_DIR}}");
    for (const p of Object.values(prompts)) {
      expect(p).not.toMatch(/\/(Users|home)\//);
    }
  });
});

describe("output style", () => {
  const set = compile(loadDefault());

  it("carries keep-coding-instructions, which is not optional", () => {
    // The default is false, which drops Claude Code's built-in
    // software-engineering instructions and changes far more than tone.
    expect(renderOutputStyle(set)).toContain("keep-coding-instructions: true");
  });

  it("has valid frontmatter with a name and description", () => {
    const style = renderOutputStyle(set);
    const lines = style.split("\n");
    expect(lines[0]).toBe("---");
    const close = lines.indexOf("---", 1);
    expect(close).toBeGreaterThan(1);
    const front = lines.slice(1, close).join("\n");
    expect(front).toMatch(/^name: .+$/m);
    expect(front).toMatch(/^description: .+$/m);
  });

  it("takes the sentence threshold from the ruleset, not a hardcoded number", () => {
    const max = set.readability.find((r) => r.kind === "long-sentence")?.maxWords;
    expect(max).toBeDefined();
    expect(renderOutputStyle(set)).toContain(String(max));

    const tweaked = { ...set, readability: set.readability.map((r) =>
      r.kind === "long-sentence" ? { ...r, maxWords: 99 } : r) };
    expect(renderOutputStyle(tweaked)).toContain("99");
  });

  it("does not restate the banned word list", () => {
    // The deterministic linter owns terms. Duplicating them here is the drift
    // problem this repo exists to remove.
    const style = renderOutputStyle(set);
    for (const term of ["delve", "seamless", "paradigm shift", "synergy"]) {
      expect(style.toLowerCase()).not.toContain(term);
    }
  });

  it("is emitted by renderAll so the CI drift check covers it", () => {
    const root = resolve("/tmp/root");
    const paths = renderAll(set, root).map((t) => t.path);
    // Built with resolve, not a literal suffix: renderAll returns native paths,
    // so a hardcoded "output-styles/plain-english.md" never matches on Windows.
    // Same fault as the exec-bit assertion fixed in a0e5bcf.
    expect(paths).toContain(
      resolve(root, "integrations", "claude-code", "output-styles", "plain-english.md"),
    );
  });

  it("lints clean under our own rules", () => {
    expect(lintText(renderOutputStyle(set), set).errorCount).toBe(0);
  });
});
