import { describe, expect, it } from "vitest";
import { __testing, maskNonProse } from "../src/mask.ts";

/**
 * The two passes over raw HTML in the mask, code tags and comments, used to be
 * lazy regexes that rescan to the end of the document at every unclosed
 * opener (#138). A Markdown write full of them took quadratic time before any
 * rule ran, and a check that outlasts its hook budget lets the write through.
 */
describe("the mask's HTML passes", () => {
  /** The mask with each run of spaces cut to one, so a snapshot shows which words survive. */
  function survivors(text: string): string {
    return maskNonProse(text, { maskComments: true }).replace(/ +/g, " ").trim();
  }

  // Recorded from the regexes this replaced, so the rewrite keeps what they matched.
  it("blanks the same code tags and comments as before", () => {
    expect([
      "Use <code>leverage()</code> here.",
      "Use <CODE>leverage()</code> and <kbd x='1'>Ctrl</kbd >.",
      "<code>a <code>b</code> c</code> after",
      "<code>never closed, then <kbd>k</kbd> and </code>",
      "<pre\nclass=x>multi\nline</pre> prose <tt>t</tt>",
      "<codex>not a code tag</codex> and <var>v</var>",
      "<code no close bracket and later </code>",
      "<samp>open <pre>other</pre> still open",
      "Before <!-- a comment --> after.",
      "<!-- one --> middle <!-- two\nlines --> end <!-- never closed",
      "<!-- <!-- nested --> tail -->",
    ].map(survivors)).toMatchInlineSnapshot(`
      [
        "Use here.",
        "Use and .",
        "c after",
        "",
        "",
        "not a code tag and",
        "<code no close bracket and later",
        "open still open",
        "Before after.",
        "end <!-- never closed",
        "",
      ]
    `);
  });

  // The directive reader sees live comments, never one inside a code block.
  it("restores comments for the directive reader except inside code blocks", () => {
    const text = [
      "<!-- plain-english-disable -->",
      "```",
      "<!-- an example, not a directive -->",
      "```",
      "    <!-- indented code -->",
      "",
      "Prose <!-- inline, live --> here.",
      "> <!-- quoted -->",
    ].join("\n");
    const view = maskNonProse(text);
    expect(view).toContain("<!-- plain-english-disable -->");
    expect(view).toContain("<!-- inline, live -->");
    expect(view).toContain("<!-- quoted -->");
    expect(view).not.toContain("an example");
    expect(view).not.toContain("indented code");
  });

  // 256 KiB is the largest write the hooks read. At that size the regexes
  // these passes replaced took from 0.4 to 4.0 seconds on unclosed openers.
  // The passes read raw text, so this times them without the Markdown parse,
  // whose own cost is steady at about 100ms here (and #156 where it is not).
  it.each(["<code>a ", "<pre x='1'>a ", "<kbd>", "<code ", "<!--", "<!-- x "])(
    "scans a document of unclosed %s openers in bounded time",
    (unit) => {
      const text = unit.repeat(Math.floor((256 * 1024) / unit.length));
      const started = performance.now();
      __testing.inlineHtmlCodeSpans(text);
      __testing.commentSpans(text);
      const ms = performance.now() - started;
      expect(ms, `${text.length} characters took ${ms.toFixed(0)}ms`).toBeLessThan(500);
    },
  );

  // Each comment used to parse the whole document again to ask whether it sat
  // in a code block: three reads of this input took 605 seconds. Now it is
  // one parse, so the ceiling only has to tell seconds from minutes.
  it("reads a document of closed comments in bounded time", () => {
    const paragraph = "<!-- x -->".repeat(64) + "\n\n";
    const text = paragraph.repeat(Math.floor((256 * 1024) / paragraph.length));
    const started = performance.now();
    maskNonProse(text);
    const ms = performance.now() - started;
    expect(ms, `${text.length} characters took ${ms.toFixed(0)}ms`).toBeLessThan(2000);
  });
});
