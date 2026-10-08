/** Shared write-tool selection and visible Jira/Confluence text extraction. */
import { parseDocument } from "htmlparser2";

export { ISSUE_TOOL_PATTERN, ISSUE_TOOLS } from "./issue-tools.ts";

const LIMIT = 256 * 1024;
const BLOCKS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "br", "hr"]);
const OMIT = new Set(["pre", "code", "script", "style", "blockquote", "ac:plain-text-body", "ac:parameter"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function htmlText(value: string): string {
  const document = parseDocument(value.slice(0, LIMIT), { decodeEntities: true });
  type Node = (typeof document.children)[number];
  const pending: (Node | string)[] = [];
  const addChildren = (children: Node[]) => {
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  };
  addChildren(document.children);
  let text = "";
  let budget = LIMIT;
  while (pending.length && budget-- > 0 && text.length < LIMIT) {
    const node = pending.pop()!;
    if (typeof node === "string") { text += node; continue; }
    if (node.type === "text") { text += node.data; continue; }
    const name = "name" in node ? node.name : "";
    if (OMIT.has(name)) { text += " "; continue; }
    if (name === "ac:structured-macro" && "attribs" in node && node.attribs["ac:name"] === "code") { text += " "; continue; }
    if (BLOCKS.has(name)) { text += "\n"; pending.push("\n"); }
    if ("children" in node) addChildren(node.children);
  }
  return text.slice(0, LIMIT).trim();
}

/** Read documented rich-text containers, never stringify metadata or old text. */
export function issueText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, LIMIT);
  const seen = new WeakSet<object>();
  let budget = LIMIT;
  const visit = (value: unknown, depth: number): string => {
    if (depth > 64 || budget-- <= 0) return "";
    if (typeof value === "string") return value.slice(0, LIMIT);
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    const node = record(value);
    const type = node["type"];
    if (type === "codeBlock" || type === "blockquote") return "\n";
    if (type === "text") {
      if (Array.isArray(node["marks"]) && node["marks"].some(mark => record(mark)["type"] === "code")) return " ";
      return typeof node["text"] === "string" ? node["text"].slice(0, LIMIT) : "";
    }
    if (type === "hardBreak") return "\n";
    if (typeof node["value"] === "string") {
      const format = node["representation"];
      if (format === "storage" || format === "view" || format === "html") return htmlText(node["value"]);
      if (format === "atlas_doc_format") {
        try { return visit(JSON.parse(node["value"].slice(0, LIMIT)), depth + 1); }
        catch { return ""; }
      }
      if (format === "markdown" || format === "plain") return node["value"].slice(0, LIMIT);
    }
    if (Array.isArray(node["content"])) {
      const children = node["content"].map(child => visit(child, depth + 1)).join("");
      return (children + (type === "paragraph" || type === "heading" || type === "listItem" ? "\n" : "")).slice(0, LIMIT);
    }
    for (const key of ["storage", "atlas_doc_format", "body", "content"]) {
      if (node[key] !== undefined) return visit(node[key], depth + 1);
    }
    return "";
  };
  return visit(value, 0).trim();
}

/** Confluence may send its storage HTML directly as `content`. */
export function contentText(value: unknown, format?: unknown): string {
  if (typeof value === "string" && (format === "adf" || format === "atlas_doc_format")) return issueText({ value, representation: "atlas_doc_format" });
  if (typeof value === "string" && (format === "storage" || format === "html" || (format === undefined && /<\/?[a-z][^>]*>/i.test(value)))) return htmlText(value);
  return issueText(value);
}
