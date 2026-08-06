/**
 * Blank out everything in a document that is not prose a reader reads.
 *
 * This used to be a stack of regexes over raw text. That approach produced four
 * separate bugs in a single adversarial pass: HTML `<pre>` and `<code>` blocks
 * were scanned, TOML frontmatter was not masked, footnote definitions were
 * swallowed by the link-reference-definition pattern, and four-space-indented
 * list continuation prose was mistaken for a code block. Vale hit the same
 * class of bug taking the same route (errata-ai/vale#387).
 *
 * Parsing removes the class rather than the instances. A markdown parser
 * already knows what a code span is, so `code`, `inlineCode`, `html`, table
 * cells and link destinations are simply never visited. Only text nodes and the
 * few other literal nodes a reader actually reads are kept.
 *
 * The output is the same length as the input, with non-prose replaced by
 * spaces and newlines preserved, so byte offsets stay aligned and a finding can
 * still report a correct line and column against the original source.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
import { visit } from "unist-util-visit";

/**
 * Node types whose text a reader reads.
 *
 * `text` covers ordinary prose. `heading`, `emphasis`, `strong`, `listItem` and
 * the rest are containers whose `text` children are visited anyway, so they do
 * not need listing. Link TEXT is prose and is visited; a link DESTINATION is a
 * URL and lives on `node.url`, which is never a child node, so it is excluded
 * for free.
 */
const PROSE_NODES = new Set(["text"]);

/**
 * Frontmatter formats to recognise. YAML uses `---`, TOML uses `+++` and is
 * what Hugo and Zola emit. Missing TOML meant a title line was linted as prose.
 */
const FRONTMATTER = ["yaml", { type: "toml", marker: "+" }] as const;

export interface MaskOptions {
  /**
   * Blank HTML comments too.
   *
   * Off for the pass that reads suppression directives, which live in comments.
   * On for the pass that matches rules, so the rule name inside a directive
   * (`disable-next-line leverage`) is not itself reported as a finding.
   */
  maskComments?: boolean;
}

interface Span {
  start: number;
  end: number;
}

/** Spans of prose within the source, from the parsed document. */
function proseSpans(text: string): Span[] {
  const tree = fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...FRONTMATTER])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER])],
  });

  const spans: Span[] = [];
  visit(tree, (node) => {
    // A table's cells hold identifiers and values far more often than prose,
    // and the ecosystem convention (mdast-util-to-nlcst) is to skip them.
    if (node.type === "table") return "skip";
    // Everything under an html node is raw markup, including <pre> and <code>.
    if (node.type === "html") return "skip";
    // A definition is a link target. Footnote definitions are a different node
    // type and fall through, so their prose is still checked.
    if (node.type === "definition") return "skip";
    // A quote is someone else's words. Blocking a customer email that happens
    // to contain a banned term helps nobody.
    if (node.type === "blockquote") return "skip";

    // Link TEXT is prose and is visited. A link DESTINATION lives on node.url
    // and is never a child, so it is excluded already. The exception is an
    // autolink or a bare URL, where the visible text IS the destination.
    if (node.type === "link") {
      const url = (node as { url?: string }).url ?? "";
      const kids = (node as { children?: { type: string; value?: string }[] }).children ?? [];
      const onlyText = kids.length === 1 && kids[0]?.type === "text" ? kids[0].value ?? "" : null;
      if (onlyText !== null && (url === onlyText || url === `mailto:${onlyText}`)) return "skip";
    }

    if (!PROSE_NODES.has(node.type)) return;
    const pos = node.position;
    if (pos?.start?.offset == null || pos?.end?.offset == null) return;
    spans.push({ start: pos.start.offset, end: pos.end.offset });
  });
  return spans;
}

/**
 * Content between paired inline HTML code tags.
 *
 * The parser reports an inline `<code>` as an `html` node for the opening tag,
 * a `text` node for the content, and another `html` node for the closing tag.
 * Skipping `html` therefore drops the tags and keeps the code between them, so
 * `Use <code>leverage()</code> here.` still produced a finding. These tag pairs
 * carry code by definition, so the span between them is not prose.
 */
const INLINE_CODE_TAGS = /<(code|pre|kbd|samp|var|tt)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

function inlineHtmlCodeSpans(text: string): Span[] {
  const spans: Span[] = [];
  INLINE_CODE_TAGS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_TAGS.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** HTML comments, for the matching pass. */
function commentSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Returns a copy of `text` in which everything except prose is replaced by
 * spaces. Length and newline positions are preserved.
 */
export function maskNonProse(text: string, opts: MaskOptions = {}): string {
  let spans: Span[];
  try {
    spans = proseSpans(text);
  } catch {
    // A parser failure must never turn into a linter crash. Falling back to
    // "nothing is prose" is the safe direction: it under-reports rather than
    // blocking a write on garbage.
    return text.replace(/[^\n\r]/g, " ");
  }

  // Start with everything blanked, then restore the prose spans.
  const out = new Array<string>(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    out[i] = ch === "\n" || ch === "\r" ? ch : " ";
  }
  for (const { start, end } of spans) {
    for (let i = start; i < end && i < text.length; i++) out[i] = text[i]!;
  }

  // Re-blank the inside of inline HTML code tags, which the prose pass keeps.
  for (const { start, end } of inlineHtmlCodeSpans(text)) {
    for (let i = start; i < end && i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== "\n" && ch !== "\r") out[i] = " ";
    }
  }

  if (opts.maskComments) {
    for (const { start, end } of commentSpans(text)) {
      for (let i = start; i < end && i < text.length; i++) {
        const ch = text[i]!;
        if (ch !== "\n" && ch !== "\r") out[i] = " ";
      }
    }
  } else {
    // Directives live in HTML comments, which the parser reports as `html`
    // nodes and which the prose pass therefore drops. Restore the comments so
    // the directive reader can see them. A comment inside a fenced code block
    // is part of the `code` node, not an `html` node, so it stays blanked and
    // an example directive in the docs is not treated as a live directive.
    for (const { start, end } of commentSpans(text)) {
      if (isInsideCode(text, start)) continue;
      for (let i = start; i < end && i < text.length; i++) out[i] = text[i]!;
    }
  }

  return out.join("");
}

/** True when an offset falls inside a fenced or indented code block. */
function isInsideCode(text: string, offset: number): boolean {
  try {
    const tree = fromMarkdown(text, {
      extensions: [gfm(), frontmatter([...FRONTMATTER])],
      mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER])],
    });
    let inside = false;
    visit(tree, "code", (node) => {
      const s = node.position?.start?.offset;
      const e = node.position?.end?.offset;
      if (s != null && e != null && offset >= s && offset < e) inside = true;
    });
    return inside;
  } catch {
    return false;
  }
}

/** Convenience for callers that want the prose only. */
export function proseOnly(text: string): string {
  return maskNonProse(text)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

export const __testing = { proseSpans, commentSpans, isInsideCode };
