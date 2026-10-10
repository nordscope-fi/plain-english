/**
 * Every node under `root` in document order, leaving out the children of a
 * node the visitor answers "skip" for.
 *
 * `unist-util-visit` did this before, and it looks up each node's index in
 * its parent with `indexOf`. That is quadratic in a parent with many
 * children: a paragraph of thousands of inline tags, or of thousands of
 * sentences, took seconds (#138). Nothing here uses the index.
 */
export function walk<T extends { children?: T[] }>(root: T, visitor: (node: T) => "skip" | void): void {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visitor(node) === "skip") continue;
    const kids = node.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}
