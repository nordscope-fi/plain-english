import { describe, expect, it } from "vitest";
import {
  humanise,
  renderWritingStyle,
  renderPrompts,
  renderOutputStyle,
  renderAll,
  outputStylePath,
  vocabularyTerms,
} from "../src/render.ts";
import { chatRules, compile, inLevel, loadDefault, merge } from "../src/rules.ts";
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

  it("renders a wildcard word as an ellipsis", () => {
    // A rule that matches a shape rather than a phrase still has to arrive in
    // the docs as something a reader can follow.
    expect(humanise(rule("\\bin (a|an) [a-z]+ (manner|fashion)\\b"))).toBe(
      "in (a/an) ... (manner/fashion)",
    );
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
      // The brace quantifier and the class range are here because they once
      // reached the published table: `not un[a-z]{3,}` passed a check that
      // looked only for backslashes and the quantifier characters.
      expect(text, `${r.id} -> ${text}`).not.toMatch(/[\\?+^${}]|\\b|[a-z]-[a-z]\]/);
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

  /**
   * The prompts that hunt for a fault have to know every fault.
   *
   * `chat` is not one of them. It is asked a single question, whether a length
   * the linter already measured was earned, and it never looks for a banned
   * term: the deterministic pass owns those and has already run. Holding it to
   * this list would put four hundred lines of word rules in front of a model
   * that must not use them.
   */
  const FAULT_FINDING = ["docs", "github", "issue"];

  it("lists every blocking term in each fault-finding prompt", () => {
    const prompts = renderPrompts(set);
    const blocking = set.rules.filter((r) => r.severity === "error");
    for (const name of FAULT_FINDING) {
      for (const r of blocking) {
        expect(prompts[name], `${name} prompt is missing ${r.id}`).toContain(humanise(r));
      }
    }
  });

  it("names every sentence shape in each fault-finding prompt", () => {
    const prompts = renderPrompts(set);
    for (const name of FAULT_FINDING) {
      for (const s of set.structures) {
        expect(prompts[name], `${name} prompt is missing ${s.id}`).toContain(s.name);
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

  /**
   * What the judge reads for.
   *
   * A pattern finds an acronym and a camel-cased name. It cannot find "the
   * JSON merge" or "by-name behaviour", which is what the reader stops on:
   * measured 2026-08-19, `unglossed-term` fired zero times on all five replies
   * that drew a complaint. The model is the only thing in the package that can
   * see that class, so the ruleset states it and `render` puts it in the
   * prompt rather than the prompt carrying wording nothing governs.
   */
  it("asks the chat judge about terms nobody explained", () => {
    const prompts = renderPrompts(set);
    expect(prompts["chat"]).toContain("by-name behaviour");
    expect(prompts["chat"].replace(/\s+/g, " ")).toContain(
      "nothing in the reply says what it is",
    );
  });

  it("asks the chat judge whether the reply ever lets up", () => {
    expect(renderPrompts(set)["chat"].replace(/\s+/g, " ")).toContain(
      "breaking two or three of them in half would cost nothing",
    );
  });

  it("keeps the judge's checks in the ruleset, not in render", () => {
    // The failure this prevents: wording in a generated prompt that no config
    // governs, so a project cannot change it and `render --check` cannot see
    // it drift.
    const ids = (set.chat.judge ?? []).map((j) => j.id);
    expect(ids).toContain("unexplained-terms");
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
  const levels = set.chat.levels.map((l) => l.id);

  it("ships one style per level, brief first", () => {
    expect(levels).toEqual(["brief", "standard", "full"]);
    expect(set.chat.level).toBe("standard");
  });

  for (const level of ["brief", "standard", "full"]) {
    it(`${level}: carries keep-coding-instructions, which is not optional`, () => {
      // The default is false, which drops Claude Code's built-in
      // software-engineering instructions and changes far more than tone.
      expect(renderOutputStyle(set, level)).toContain("keep-coding-instructions: true");
    });

    it(`${level}: has valid frontmatter with a name and description`, () => {
      const style = renderOutputStyle(set, level);
      const lines = style.split("\n");
      expect(lines[0]).toBe("---");
      const close = lines.indexOf("---", 1);
      expect(close).toBeGreaterThan(1);
      const front = lines.slice(1, close).join("\n");
      expect(front).toMatch(/^name: .+$/m);
      expect(front).toMatch(/^description: .+$/m);
    });

    it(`${level}: does not restate the banned word list`, () => {
      // The deterministic linter owns document terms. Duplicating them here is
      // the drift problem this repo exists to remove. Chat tells are a
      // different set, which is the whole argument for a separate section.
      const style = renderOutputStyle(set, level).toLowerCase();
      for (const term of ["delve", "seamless", "paradigm shift", "synergy"]) {
        expect(style).not.toContain(term);
      }
    });

    it(`${level}: lints clean under our own rules`, () => {
      expect(lintText(renderOutputStyle(set, level), set).errorCount).toBe(0);
    });

    it(`${level}: names the channel it applies to`, () => {
      // Without this line the style reads as advice about everything, and the
      // rules that make chat readable would make a commit message useless.
      //
      // Compared with whitespace collapsed, because the renderer wraps to 78
      // columns and the ruleset holds the scope as one folded line.
      const flat = (s: string) => s.replace(/\s+/g, " ").trim();
      expect(flat(renderOutputStyle(set, level))).toContain(flat(set.chat.scope));
    });
  }

  // Was asserted by heading text until `brief` stopped rendering one heading
  // per rule. Ids are the stronger check anyway: they test the ruleset, which
  // is where nesting is decided, rather than one rendering of it.
  it("the levels are strictly nested, so switching up never loses a rule", () => {
    const at = (level: string) =>
      set.chat.guidance.filter((g) => inLevel(g, level)).map((g) => g.id);

    const [brief, standard, full] = [at("brief"), at("standard"), at("full")];
    expect(brief.length).toBeGreaterThan(0);
    for (const id of brief) expect(standard, `brief rule missing from standard: ${id}`).toContain(id);
    for (const id of standard) expect(full, `standard rule missing from full: ${id}`).toContain(id);
    // And strictly, not merely equal: three identical files would pass the
    // subset checks above and defeat the point of having three.
    expect(brief.length).toBeLessThan(standard.length);
    expect(standard.length).toBeLessThan(full.length);
  });

  it("brief is a checklist, not an abridged essay", () => {
    // 594 words on 2026-08-20, when every rule still rendered as its own
    // heading and paragraph. The bullets form takes the same rules to 375.
    //
    // 420 rather than a rounder number, and it is a ceiling on the FORM, not a
    // budget for the content. Every word left at 375 is a rule, a threshold or
    // an override, so the only way back over this line is a level that has
    // started rendering paragraphs again. Adding a rule to brief should raise
    // this number; adding a paragraph to each rule should not be possible.
    const words = renderOutputStyle(set, "brief")
      .replace(/^---[\s\S]*?^---/m, "")
      .split(/\s+/)
      .filter(Boolean).length;
    expect(words).toBeLessThan(420);
    // And it still says something. A renderer that dropped every section would
    // pass the ceiling above and fail the whole point of the level.
    expect(words).toBeGreaterThan(200);
  });

  it("a bullets level renders one checklist, not one heading per rule", () => {
    // The property the word count is a proxy for, asserted directly. Read off
    // the ruleset rather than naming levels, so moving a level between forms
    // changes one line of YAML and no test.
    for (const level of levels) {
      const form = set.chat.levels.find((l) => l.id === level)?.form ?? "sections";
      const headings = renderOutputStyle(set, level)
        .split("\n")
        .filter((l) => l.startsWith("## "));
      if (form === "bullets") {
        expect(headings.length, `${level} still renders a heading per rule`).toBeLessThan(9);
        expect(renderOutputStyle(set, level)).toContain("## The rules");
      } else {
        expect(renderOutputStyle(set, level)).toContain("## Open with what this is");
      }
    }
  });

  it("a checklist bullet does not restate its own label", () => {
    // The inline-header tell: a bold label followed by a line that says the
    // label again. The reader pays for the words twice and learns nothing the
    // second time, and it is the failure mode a one-line summary falls into by
    // default, because the name is the easiest sentence to write.
    //
    // Three of the sixteen shipped shorts did this on 2026-08-20.
    const overlap = (label: string, line: string): number => {
      const stop = new Set(["the", "a", "an", "and", "or", "it", "is", "to", "of", "in", "not"]);
      const words = (t: string) =>
        t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w && !stop.has(w));
      const first = words(label);
      const rest = new Set(words(line));
      if (!first.length) return 0;
      return first.filter((w) => rest.has(w)).length / first.length;
    };

    for (const level of levels) {
      const form = set.chat.levels.find((l) => l.id === level)?.form ?? "sections";
      if (form !== "bullets") continue;
      for (const line of renderOutputStyle(set, level).split("\n")) {
        const m = /^- \*\*(.+?)\.?\*\*\s*(.+)$/.exec(line);
        if (!m) continue;
        expect(overlap(m[1]!, m[2]!), `bullet restates its label: ${line}`).toBeLessThan(0.7);
      }
    }
  });

  it("standard carries more than it used to, in fewer words", () => {
    // 1093 words before any of this, with no skeleton and no worked example.
    // 1441 when those arrived and every rule still had its paragraph. Bullets
    // fit both new sections inside the saving, which is the only reason the
    // default level renders as a checklist at all.
    const words = renderOutputStyle(set, "standard")
      .replace(/^---[\s\S]*?^---/m, "")
      .split(/\s+/)
      .filter(Boolean).length;
    expect(words).toBeLessThan(1093);
    // Every rule `full` carries at standard is still here. Shorter has to mean
    // fewer words, never fewer rules.
    for (const g of set.chat.guidance) {
      if (!inLevel(g, "standard")) continue;
      expect(renderOutputStyle(set, "standard"), `standard drops ${g.id}`).toContain(
        g.name ?? g.id,
      );
    }
  });

  it("every rule reaching a bullets level has a short line to render", () => {
    // The description fallback exists so an overlay still renders, not as the
    // shipped answer: truncating "Depth is welcome" at its first full stop
    // dropped the sentence limit, which is the whole rule.
    const bullets = new Set(
      set.chat.levels.filter((l) => l.form === "bullets").map((l) => l.id),
    );
    for (const g of set.chat.guidance) {
      for (const level of bullets) {
        if (!inLevel(g, level)) continue;
        expect(g.short, `${g.id} reaches ${level} with no short line`).toBeDefined();
        expect(g.short!.split(/\s+/).length, `${g.id} short is not short`).toBeLessThan(22);
      }
    }
  });

  it("brief names every rule it carries", () => {
    // The short form drops the paragraph, not the rule. Anything `inLevel`
    // puts in brief has to be findable in the rendered file by name.
    const style = renderOutputStyle(set, "brief");
    for (const g of set.chat.guidance) {
      if (!inLevel(g, "brief")) continue;
      expect(style, `brief drops ${g.id}`).toContain(g.name ?? g.id);
    }
  });

  it("shows the shape of a reply, not only rules about one", () => {
    // Eighteen rules and no skeleton. A model copies a shape far more reliably
    // than it weighs a list, and nothing in the style was a shape.
    const style = renderOutputStyle(set, "standard");
    expect(set.chat.shape).toBeDefined();
    expect(style).toContain(set.chat.shape!.name);
    for (const line of set.chat.shape!.template.split("\n").filter(Boolean)) {
      expect(style, `template line missing: ${line}`).toContain(line.trim());
    }
  });

  it("carries a worked example for each level that asks for one", () => {
    expect(set.chat.examples.length).toBeGreaterThan(0);
    for (const level of levels) {
      const style = renderOutputStyle(set, level);
      for (const e of set.chat.examples) {
        const first = (e.good ?? "").split("\n").filter(Boolean)[0]?.trim() ?? "";
        expect(first.length).toBeGreaterThan(0);
        if (inLevel(e, level)) {
          expect(style, `${level} drops example ${e.id}`).toContain(first);
        } else {
          expect(style, `${level} carries example ${e.id}`).not.toContain(first);
        }
      }
    }
  });

  it("a bad example does not trip the ruleset it illustrates", () => {
    // The point of a worked example is showing the reply nobody should write,
    // and those open with the phrases `chat.tells` bans. They reach the model
    // through a node the masking pass skips, so the style still lints clean.
    const bad = set.chat.examples.map((e) => e.bad ?? "").join(" ");
    expect(bad).toContain("Great question");
    for (const level of levels) {
      expect(lintText(renderOutputStyle(set, level), set).errorCount).toBe(0);
    }
  });

  it("takes the sentence threshold from the ruleset, not a hardcoded number", () => {
    const max = set.readability.find((r) => r.kind === "long-sentence")?.maxWords;
    expect(max).toBeDefined();
    expect(renderOutputStyle(set)).toContain(String(max));

    const tweaked = { ...set, readability: set.readability.map((r) =>
      r.kind === "long-sentence" ? { ...r, maxWords: 99 } : r) };
    expect(renderOutputStyle(tweaked)).toContain("99");
  });

  it("leaves no unfilled placeholder in any level", () => {
    for (const level of levels) {
      expect(renderOutputStyle(set, level)).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("emits every level from renderAll so the CI drift check covers all of them", () => {
    const root = resolve("/tmp/root");
    const paths = renderAll(set, root).map((t) => t.path);
    // Built with resolve, not a literal suffix: renderAll returns native paths,
    // so a hardcoded "output-styles/plain-english.md" never matches on Windows.
    // Same fault as the exec-bit assertion fixed in a0e5bcf.
    const at = (file: string) =>
      resolve(root, "integrations", "claude-code", "output-styles", file);
    expect(paths).toContain(at("plain-english.md"));
    expect(paths).toContain(at("plain-english-brief.md"));
    expect(paths).toContain(at("plain-english-full.md"));
  });

  it("keeps the unsuffixed filename for the default level", () => {
    // An install that already selected "Plain English" in /config must survive
    // this change rather than finding its style renamed out from under it.
    expect(outputStylePath(set, set.chat.level)).toBe(
      "integrations/claude-code/output-styles/plain-english.md",
    );
    expect(outputStylePath(set, "brief")).toContain("plain-english-brief.md");
  });
});

describe("chat tells", () => {
  const set = compile(loadDefault());

  it("generates a pattern from the phrases, not the other way round", () => {
    const rules = chatRules(set);
    expect(rules.length).toBe(set.chat.tells.filter((t) => t.severity !== "off").length);
    for (const r of rules) expect(() => new RegExp(r.match, "i")).not.toThrow();
  });

  it("anchors a start-of-reply tell, and does not anchor the others", () => {
    const opener = chatRules(set).find((r) => r.id === "affirmation-opener")!;
    const closer = chatRules(set).find((r) => r.id === "closing-pleasantry")!;
    expect(opener.match.startsWith("^")).toBe(true);
    expect(closer.match.startsWith("^")).toBe(false);

    const re = new RegExp(opener.match, "i");
    expect(re.test("Great question. The answer is 4.")).toBe(true);
    // Mid-reply, the same words are somebody being quoted or discussed.
    expect(re.test("You asked whether that is a great question. It is not.")).toBe(false);
  });

  it("catches both apostrophes, because a model writes each of them", () => {
    const re = new RegExp(chatRules(set).find((r) => r.id === "affirmation-opener")!.match, "i");
    expect(re.test("You're absolutely right, the path is wrong.")).toBe(true);
    expect(re.test("You’re absolutely right, the path is wrong.")).toBe(true);
  });

  it("narrows with the level, so brief carries fewer than full", () => {
    expect(chatRules(set, "brief").length).toBeLessThan(chatRules(set, "full").length);
  });
});

describe("a project adjusts chat without forking the ruleset", () => {
  const base = compile(loadDefault());

  /** The overlay shape `loadConfig` builds from a `.plain-english.yml`. */
  const overlay = (chat: Partial<typeof base.chat>) =>
    merge(base, {
      ...base,
      meta: { title: "", intro: "" },
      rules: [],
      readability: [],
      structures: [],
      allow: [],
      exclude: [],
      chat: { scope: "", level: "", levels: [], guidance: [], tells: [], avoid: [], expand: [], ...chat },
    });

  it("moves one section to another level and keeps its wording", () => {
    const before = base.chat.guidance.find((g) => g.id === "time-estimates")!;
    expect(before.levels).toEqual(["full"]);

    const merged = overlay({ guidance: [{ id: "time-estimates", levels: ["brief", "standard", "full"] }] });
    const after = merged.chat.guidance.find((g) => g.id === "time-estimates")!;
    expect(after.levels).toEqual(["brief", "standard", "full"]);
    expect(after.description).toBe(before.description);
    expect(renderOutputStyle(merged, "brief")).toContain(before.name!);
  });

  it("turns a section off everywhere with an empty level list", () => {
    // `levels: []` has to differ from an absent `levels`, which means every
    // level. Testing for presence rather than length is what makes that work.
    const merged = overlay({ guidance: [{ id: "rank-and-cap-lists", levels: [] }] });
    for (const level of ["brief", "standard", "full"]) {
      expect(renderOutputStyle(merged, level)).not.toContain("Rank a list");
    }
  });

  it("adds a phrase to a shipped tell instead of replacing the list", () => {
    // Replacing would mean restating the upstream phrases to add one, which is
    // how a project's list stops tracking the ruleset it extends.
    const merged = overlay({
      tells: [{ id: "closing-pleasantry", at: "anywhere", severity: "warn", phrases: ["Anything else I can do"] }],
    });
    const tell = merged.chat.tells.find((t) => t.id === "closing-pleasantry")!;
    expect(tell.phrases).toContain("Hope this helps");
    expect(tell.phrases).toContain("Anything else I can do");
  });

  it("refuses a brand new tell that carries no phrases", () => {
    expect(() =>
      overlay({ tells: [{ id: "invented", at: "anywhere", severity: "warn", phrases: [] }] }),
    ).toThrow(/needs 'phrases'/);
  });
});


/**
 * Vocabulary reaching the semantic layer.
 *
 * The prompts read no config, so a project that told the deterministic rules
 * "everybody here knows what a Deal is" was still asked for a gloss by the
 * model. `semantic: true` is what closes that.
 */
/**
 * Whether a reply can be read is asked on its own.
 *
 * It used to be a clause inside the length prompt, and the two questions pull
 * against each other: one is looking for a reason to waive, the other for a
 * reason to refuse. Measured on 2026-08-20 over four replies, two runs each.
 * Asked alone the check separated them every time, the unreadable reply
 * scoring 3 and 6 against 1, 0 and 0 for the three that were fine. Asked
 * inside the length prompt the same model passed the unreadable reply twice
 * and failed a good one.
 */
describe("the readable check is its own prompt", () => {
  const set = compile(loadDefault());
  const prompts = renderPrompts(set);

  it("renders as a separate prompt", () => {
    expect(prompts["chat-readable"]).toBeDefined();
    expect(prompts["chat-readable"]).toContain("$ARGUMENTS");
  });

  it("states the threshold from the ruleset, not a number in the renderer", () => {
    expect(set.chat.readable).toBeDefined();
    expect(prompts["chat-readable"]).toContain(String(set.chat.readable!.maxUnexplained));
    const tweaked = {
      ...set,
      chat: { ...set.chat, readable: { ...set.chat.readable!, maxUnexplained: 9 } },
    };
    expect(renderPrompts(tweaked)["chat-readable"]).toContain("9");
  });

  it("asks it to list before it decides, which is what made it reliable", () => {
    // Asked "could a reader follow this?" the judge said yes twice on a reply
    // the reader could not follow, because the judge knows every term in it and
    // cannot simulate not knowing. Asked to LIST the unexplained terms, the
    // same model on the same reply returned five. Counting is a task it can do.
    expect(prompts["chat-readable"]).toMatch(/list every term/i);
  });

  it("keeps the length prompt about length", () => {
    // The two questions live in two prompts now, so neither has to hold both.
    expect(prompts["chat"]).not.toMatch(/list every term/i);
  });

  it("tells both judges they are not in the conversation", () => {
    // A judge handed a short reply answered the reader's question instead of
    // judging it. Observed 2026-08-20 on a reply reading "Did the tests pass?",
    // where the judge replied "Yes, 735 passed": a fine answer and a dead gate.
    for (const id of ["chat", "chat-readable"]) {
      expect(prompts[id], `${id} does not say it is not a participant`).toMatch(
        /not part of the conversation/i,
      );
    }
  });
});

describe("project vocabulary in the prompts", () => {
  const withVocabulary = (allow: unknown[]) =>
    renderPrompts(
      compile({ ...loadDefault(), allow: allow as never }),
    );

  it("says nothing when the project declared none", () => {
    for (const body of Object.values(renderPrompts(compile(loadDefault())))) {
      expect(body).not.toContain("PROJECT VOCABULARY");
    }
  });

  it("reaches every channel, in words rather than in regex", () => {
    const prompts = withVocabulary([
      { pattern: "\\b(Deal|Contact)\\b", rules: ["unglossed-term"], semantic: true },
    ]);
    for (const body of Object.values(prompts)) {
      expect(body).toContain("PROJECT VOCABULARY");
      expect(body).toContain("Deal, Contact");
      expect(body).not.toContain("\\b(Deal|Contact)\\b");
    }
  });

  it("leaves an entry that did not ask for it out", () => {
    const prompts = withVocabulary([{ pattern: "\\bMRR\\b" }]);
    expect(prompts["docs"]).not.toContain("PROJECT VOCABULARY");
  });

  it("quotes a pattern that is not a list of words", () => {
    const prompts = withVocabulary([{ pattern: "hs_[a-z_]+", semantic: true }]);
    expect(prompts["docs"]).toContain("anything matching /hs_[a-z_]+/");
  });

  it("reads the words out of the shapes a config actually uses", () => {
    expect(vocabularyTerms("\\bMRR\\b")).toEqual(["MRR"]);
    expect(vocabularyTerms("\\b(Deal|Contact)\\b")).toEqual(["Deal", "Contact"]);
    expect(vocabularyTerms("\\bSegments?\\b")).toEqual(["Segment"]);
    expect(vocabularyTerms("hs_[a-z_]+")).toEqual([]);
  });
});
