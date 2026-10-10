import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";

const FRONTMATTER = ["yaml", { type: "toml", marker: "+" }] as const;

export type MarkdownTree = ReturnType<typeof fromMarkdown>;

let last: { text: string; tree: MarkdownTree } | undefined;

/**
 * The document's Markdown tree, with GitHub's extensions and frontmatter.
 *
 * One check asked for the same document's tree up to nine times: the mask
 * twice or three times, and the sentence layer once for every readability
 * rule that counts sentences or terms. A 256 KiB page cost about 100ms a
 * parse, and far more for a long paragraph of inline markup (#156). The last
 * tree is kept, so a check parses its document once. Callers only read it.
 */
export function parseMarkdown(text: string): MarkdownTree {
  if (last?.text === text) return last.tree;
  const tree = fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...FRONTMATTER])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER])],
  });
  last = { text, tree };
  return tree;
}
