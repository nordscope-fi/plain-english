import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { visit } from "unist-util-visit";

const ROOT = resolve(import.meta.dirname, "..");
const COMMUNITY_FILES = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "AGENTS.md",
];
const PUBLIC_TREES = ["docs", "integrations", ".vibe"];

function markdownFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return extname(path) === ".md" ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    markdownFiles(resolve(path, entry.name)),
  );
}

function publicMarkdown(): string[] {
  return [
    ...COMMUNITY_FILES.map((path) => resolve(ROOT, path)),
    ...PUBLIC_TREES.flatMap((path) => markdownFiles(resolve(ROOT, path))),
  ];
}

/** GitHub's heading ids for the ASCII headings used by these documents. */
function headingId(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as { value?: unknown; children?: unknown[] };
  if (typeof record.value === "string") return record.value;
  return (record.children ?? []).map(nodeText).join("");
}

function anchors(path: string): Set<string> {
  const tree = fromMarkdown(readFileSync(path, "utf8"), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const found = new Set<string>();
  const seen = new Map<string, number>();
  visit(tree, "heading", (node) => {
    const base = headingId(nodeText(node));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  });
  return found;
}

describe("public documentation links", () => {
  it("points every local link at a file and heading that exist", () => {
    const failures: string[] = [];
    for (const file of publicMarkdown()) {
      const tree = fromMarkdown(readFileSync(file, "utf8"), {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      });
      visit(tree, "link", (node) => {
        const url = node.url;
        if (/^[a-z][a-z+.-]*:/i.test(url) || url.startsWith("//")) return;

        const [rawPath = "", rawFragment] = url.split("#", 2);
        if (!rawPath && !rawFragment) return;
        const target = rawPath ? resolve(dirname(file), decodeURIComponent(rawPath)) : file;
        const shown = file.slice(ROOT.length + 1);
        if (!existsSync(target)) {
          failures.push(`${shown}: missing ${url}`);
          return;
        }
        if (rawFragment && statSync(target).isFile()) {
          const fragment = decodeURIComponent(rawFragment).toLowerCase();
          if (!anchors(target).has(fragment)) failures.push(`${shown}: missing heading ${url}`);
        }
      });
    }

    expect(failures).toEqual([]);
  });
});
