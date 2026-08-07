/**
 * Sentence and word structure, with offsets back into the original source.
 *
 * Readability rules need to know where a sentence starts and ends. Splitting on
 * `[.!?]` is the obvious approach and it is wrong in the ways that matter here:
 * it breaks on "e.g.", on "v0.1.3", on "Node.js", and it happily counts words
 * inside a fenced code block as a sentence.
 *
 * `mdast-util-to-nlcst` walks the markdown tree we already parse and produces a
 * natural-language tree instead, so code, tables and link destinations never
 * reach the sentence layer at all. Every node carries a source offset, so a
 * finding still points at the right line.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
import { toNlcst } from "mdast-util-to-nlcst";
import { ParseEnglish } from "parse-english";
import { toString as nlcstToString } from "nlcst-to-string";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

const FRONTMATTER = ["yaml", { type: "toml", marker: "+" }] as const;

export interface Sentence {
  /** The sentence as a reader sees it. */
  text: string;
  /** Word count, punctuation and symbols excluded. */
  words: number;
  /** Offset of the first character in the original source. */
  start: number;
  /** Offset one past the last character. */
  end: number;
}

export interface Term {
  text: string;
  start: number;
  end: number;
  /** Index of the sentence this term sits in. */
  sentence: number;
}

interface NlcstNode {
  type: string;
  value?: string;
  children?: NlcstNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function parse(text: string): NlcstNode | null {
  try {
    const mdast = fromMarkdown(text, {
      extensions: [gfm(), frontmatter([...FRONTMATTER])],
      mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER])],
    });
    // A real VFile is required. A duck-typed object with `value` and
    // `toString` is rejected with "mdast-util-to-nlcst expected file".
    //
    // `ignore` keeps blockquotes out of the sentence layer, matching the
    // masker: a quote is someone else's words, so its sentence length and its
    // unexplained terms are not ours to fix.
    return toNlcst(mdast, new VFile(text), ParseEnglish as never, {
      ignore: ["blockquote"],
    }) as unknown as NlcstNode;
  } catch {
    // A parse failure must never crash the linter. No sentences means no
    // readability findings, which under-reports instead of blocking a write.
    return null;
  }
}

/** Sentences in reading order, with word counts and source offsets. */
export function sentences(text: string): Sentence[] {
  const tree = parse(text);
  if (!tree) return [];

  const out: Sentence[] = [];
  visit(tree as never, "SentenceNode", (node: NlcstNode) => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) return;

    let words = 0;
    visit(node as never, "WordNode", () => {
      words++;
    });
    if (words === 0) return;

    out.push({ text: nlcstToString(node as never), words, start, end });
  });
  return out;
}

/**
 * Capitalised terms that read as jargon: acronyms of three or more letters, and
 * camel-cased names. Returned in reading order with the sentence they sit in,
 * so a caller can tell whether a term appeared before or after its explanation.
 */
const JARGON = /^(?:[A-Z][A-Z0-9]{2,}|[A-Z][a-z]+(?:[A-Z]\w*)+)$/;

export function jargonTerms(text: string): Term[] {
  const tree = parse(text);
  if (!tree) return [];

  const out: Term[] = [];
  let index = -1;
  visit(tree as never, "SentenceNode", (sentence: NlcstNode) => {
    index++;
    visit(sentence as never, "WordNode", (word: NlcstNode) => {
      const value = nlcstToString(word as never);
      if (!JARGON.test(value)) return;
      const start = word.position?.start?.offset;
      const end = word.position?.end?.offset;
      if (start == null || end == null) return;
      out.push({ text: value, start, end, sentence: index });
    });
  });
  return out;
}

export const __testing = { JARGON, parse };
