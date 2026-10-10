import { describe, expect, it } from "vitest";
import { walk } from "../src/tree-walk.ts";

interface Node {
  type: string;
  children?: Node[];
}

describe("walk", () => {
  it("visits in document order and leaves out what a visitor skips", () => {
    const tree: Node = {
      type: "root",
      children: [
        { type: "a", children: [{ type: "a1" }, { type: "a2" }] },
        { type: "skip", children: [{ type: "hidden" }] },
        { type: "b" },
      ],
    };
    const seen: string[] = [];
    walk(tree, (node) => {
      seen.push(node.type);
      if (node.type === "skip") return "skip";
    });
    expect(seen).toEqual(["root", "a", "a1", "a2", "skip", "b"]);
  });

  // `unist-util-visit` looked up each child's index with `indexOf`, about 20
  // billion comparisons for this parent (#138). A walk is one step per node.
  it("walks a parent of 200,000 children in bounded time", () => {
    const tree: Node = { type: "paragraph", children: Array.from({ length: 200_000 }, () => ({ type: "text" })) };
    let count = 0;
    const started = performance.now();
    walk(tree, () => {
      count++;
    });
    const ms = performance.now() - started;
    expect(count).toBe(200_001);
    expect(ms, `took ${ms.toFixed(0)}ms`).toBeLessThan(500);
  });
});
