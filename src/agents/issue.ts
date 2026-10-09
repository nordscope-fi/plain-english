/** Shared write-tool selection and visible Jira/Confluence text extraction. */
export { ISSUE_TOOL_PATTERN, ISSUE_TOOLS } from "./issue-tools.ts";

const LIMIT = 256 * 1024;
const BLOCKS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "br", "hr"]);
const OMIT = new Set(["pre", "code", "script", "style", "blockquote", "ac:plain-text-body", "ac:parameter"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The named entities issue and page HTML uses. Jira and Confluence write the
 * rest of Unicode as numbers or as itself. The reader is the project's own,
 * rather than an HTML library's, so the Claude Code plugin carries no encoded
 * table of every HTML entity (ADR-008).
 */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  deg: "°", times: "×", divide: "÷", plusmn: "±", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", shy: "­", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
};

/** Decodes named and numeric entities; anything else, or an invalid number, stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (written, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return ENTITIES[name] ?? written;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return written;
    return String.fromCodePoint(code);
  });
}

/** The longest tag the reader parses; a longer one is read as text. */
const MAX_TAG = 4096;
const TAG = /^<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/<>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s<>]+))?)*)\s*(\/?)>$/;
const CODE_MACRO = /\sac:name\s*=\s*(["']?)code\1(?=[\s/>]|$)/i;

/**
 * The text a person sees in an HTML fragment: tags, attributes, comments and
 * code, quotes, scripts and styles dropped, a line break around each block.
 * An omitted element leaves one space, so words on either side stay apart.
 *
 * Linear in the input: a tag is parsed only up to the next `>` within
 * MAX_TAG characters, and that `>` is found once per stretch of text, not
 * once per `<`. A crafted body of unclosed tags once made this rescan to the
 * end at every `<`, long enough to outlast a hook's budget.
 */
function htmlText(value: string): string {
  const input = value.slice(0, LIMIT);
  const skipping: string[] = [];
  let text = "";
  let at = 0;
  let close = -1;
  while (at < input.length && text.length < LIMIT) {
    if (input.startsWith("<!--", at)) {
      const end = input.indexOf("-->", at + 4);
      at = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", at) || input.startsWith("<?", at)) {
      // A doctype, a CDATA section or a processing instruction: not visible text.
      const end = input.indexOf(">", at + 2);
      at = end === -1 ? input.length : end + 1;
      continue;
    }
    if (input[at] === "<") {
      if (close !== -2 && close < at) close = input.indexOf(">", at);
      if (close === -1) close = -2;
      const tag = close >= 0 && close - at < MAX_TAG ? TAG.exec(input.slice(at, close + 1)) : null;
      if (tag === null) {
        if (skipping.length === 0) text += "<";
        at += 1;
        continue;
      }
      at = close + 1;
      const closing = tag[1] === "/";
      const name = tag[2]!.toLowerCase();
      const selfClosing = tag[4] === "/" || VOID.has(name);
      if (skipping.length) {
        if (name === skipping.at(-1)) {
          if (closing) skipping.pop();
          else if (!selfClosing) skipping.push(name);
        }
        continue;
      }
      const omitted = OMIT.has(name) || (name === "ac:structured-macro" && CODE_MACRO.test(tag[3] ?? ""));
      if (omitted && !closing) {
        text += " ";
        if (!selfClosing) skipping.push(name);
        continue;
      }
      if (BLOCKS.has(name)) text += selfClosing ? "\n\n" : "\n";
      continue;
    }
    const next = input.indexOf("<", at);
    const end = next === -1 ? input.length : next;
    if (skipping.length === 0) text += decodeEntities(input.slice(at, end));
    at = end;
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
  if (typeof value === "string" && (format === "storage" || format === "html" || (format === undefined && /<\/?[a-z][^<>]{0,4096}>/i.test(value)))) return htmlText(value);
  return issueText(value);
}
