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
import { walk } from "./tree-walk.ts";

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

interface TreeNode {
  type: string;
  children?: TreeNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function parse(text: string): TreeNode {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...FRONTMATTER])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER])],
  });
}

/** Fenced and indented code blocks, in document order. */
function codeBlockSpans(tree: TreeNode): Span[] {
  const spans: Span[] = [];
  walk(tree, (node) => {
    if (node.type !== "code") return;
    const s = node.position?.start?.offset;
    const e = node.position?.end?.offset;
    if (s != null && e != null) spans.push({ start: s, end: e });
  });
  return spans;
}

/** Spans of prose within the source, from the parsed document. */
function proseSpans(tree: TreeNode): Span[] {
  const spans: Span[] = [];
  walk(tree, (node) => {
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
const CODE_TAG_OPEN = /<(code|pre|kbd|samp|var|tt)\b/gi;

/**
 * What `<(code|...)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi` matched, read in one
 * pass. That regex rescanned to the end of the document at every opener whose
 * tag never closed, so a write full of them took quadratic time and could
 * outlast a hook's budget (#138). Here the next `>` and each name's next
 * closing tag are found once and reused until the scan passes them.
 */
function inlineHtmlCodeSpans(text: string): Span[] {
  const spans: Span[] = [];
  const closers = new Map<string, { re: RegExp; at: number; end: number }>();
  let gt = -1;
  CODE_TAG_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_TAG_OPEN.exec(text)) !== null) {
    const nameEnd = m.index + m[0].length;
    if (gt < nameEnd) gt = text.indexOf(">", nameEnd);
    if (gt === -1) break; // No opener from here on can finish its tag.
    const name = m[1]!.toLowerCase();
    let close = closers.get(name);
    if (close === undefined) {
      close = { re: new RegExp(`</${name}\\s*>`, "gi"), at: -2, end: -2 };
      closers.set(name, close);
    }
    // A closing tag found for an earlier opener is still the first one after
    // this opener when it lies past this opener's `>`. Not found then means
    // not found now.
    if (close.at !== -1 && close.at <= gt) {
      close.re.lastIndex = gt + 1;
      const c = close.re.exec(text);
      close.at = c ? c.index : -1;
      close.end = c ? c.index + c[0].length : -1;
    }
    if (close.at === -1) continue;
    spans.push({ start: m.index, end: close.end });
    CODE_TAG_OPEN.lastIndex = close.end;
  }
  return spans;
}

/**
 * HTML comments, for the matching pass. Found with `indexOf` rather than a
 * lazy regex, which rescanned to the end at every unclosed `<!--` (#138).
 */
function commentSpans(text: string): Span[] {
  const spans: Span[] = [];
  let at = text.indexOf("<!--");
  while (at !== -1) {
    const close = text.indexOf("-->", at + 4);
    if (close === -1) break;
    spans.push({ start: at, end: close + 3 });
    at = text.indexOf("<!--", close + 3);
  }
  return spans;
}

/**
 * Returns a copy of `text` in which everything except prose is replaced by
 * spaces. Length and newline positions are preserved.
 */
export function maskNonProse(text: string, opts: MaskOptions = {}): string {
  let tree: TreeNode;
  let spans: Span[];
  try {
    tree = parse(text);
    spans = proseSpans(tree);
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
    // Comments and code blocks both come in document order, so one pointer
    // walks the blocks. This used to parse the whole document again for each
    // comment, quadratic in a write full of them (#138).
    const code = codeBlockSpans(tree);
    let c = 0;
    for (const { start, end } of commentSpans(text)) {
      while (c < code.length && code[c]!.end <= start) c++;
      if (c < code.length && code[c]!.start <= start) continue;
      for (let i = start; i < end && i < text.length; i++) out[i] = text[i]!;
    }
  }

  return out.join("");
}

/** Convenience for callers that want the prose only. */
export function proseOnly(text: string): string {
  return maskNonProse(text)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

export const __testing = { proseSpans, commentSpans, codeBlockSpans, inlineHtmlCodeSpans };
