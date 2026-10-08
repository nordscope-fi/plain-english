/** Opt-in JavaScript/TypeScript prose extraction. Source is parsed, never run. */
import { parse } from "@babel/parser";
import { decodeHTMLStrict } from "entities";
import { lintText, DEFAULT_BUDGET_MS, type LintOptions, type LintResult } from "./lint.ts";
import type { RuleSet } from "./rules.ts";

export const SOURCE_PROSE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const TEXT_ATTRIBUTES = new Set(["title", "alt", "placeholder", "aria-label", "aria-description", "label", "description", "helpText"]);

export interface SourceProseOptions extends LintOptions {
  /** Determines TypeScript and JSX syntax. Defaults to an in-memory TSX file. */
  filename?: string;
}

export interface SourcePassage {
  text: string;
  /** Each decoded UTF-16 character's original source offset, plus the end. */
  offsets: number[];
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };
export class SourceProseError extends Error {
  constructor(filename: string, error: unknown) {
    super(`Cannot read prose in ${filename}: ${error instanceof Error ? error.message : String(error)}`);
    this.name = "SourceProseError";
  }
}
function node(value: unknown): Node | undefined {
  return value !== null && typeof value === "object" && typeof (value as Node).type === "string" ? value as Node : undefined;
}

/** Decode escapes with a source map, without evaluating a string as code. */
function decode(raw: string, start: number, jsx: boolean): SourcePassage {
  let text = "";
  const offsets: number[] = [];
  const add = (value: string, index: number) => {
    text += value;
    for (let k = 0; k < value.length; k++) offsets.push(start + index);
  };
  for (let i = 0; i < raw.length;) {
    const at = i;
    if (jsx && raw[i] === "&") {
      const entity = /^&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/i.exec(raw.slice(i));
      if (entity) {
        const value = decodeHTMLStrict(entity[0]);
        if (value !== entity[0]) { add(value, at); i += entity[0].length; continue; }
      }
    }
    if (!jsx && raw[i] === "\\") {
      i++;
      const escaped = raw[i++] ?? "";
      if (escaped === "\n") continue;
      if (escaped === "\r") { if (raw[i] === "\n") i++; continue; }
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
      if (simple[escaped] !== undefined) { add(simple[escaped]!, at); continue; }
      if (escaped === "u" || escaped === "x") {
        const hex = escaped === "u" && raw[i] === "{" ? /^\{([0-9a-f]+)\}/i.exec(raw.slice(i)) : new RegExp(`^([0-9a-f]{${escaped === "u" ? 4 : 2}})`, "i").exec(raw.slice(i));
        if (hex) { add(String.fromCodePoint(parseInt(hex[1]!, 16)), at); i += hex[0].length; continue; }
      }
      if (/[0-7]/.test(escaped)) {
        const octal = new RegExp(`^[0-7]{0,${escaped <= "3" ? 2 : 1}}`).exec(raw.slice(i))![0];
        add(String.fromCharCode(parseInt(escaped + octal, 8)), at); i += octal.length; continue;
      }
      add(escaped, at);
      continue;
    }
    // Templates normalize CRLF to LF. JSX and ordinary source retain offsets.
    if (!jsx && raw[i] === "\r" && raw[i + 1] === "\n") { add("\n", at); i += 2; continue; }
    add(raw[i++]!, at);
  }
  offsets.push(start + raw.length);
  return { text, offsets };
}

/** Match JSX's rendered whitespace while keeping positions in the source. */
function jsxWhitespace(passage: SourcePassage): SourcePassage {
  const ranges: { value: string; index: number }[] = [];
  let cursor = 0;
  for (const newline of passage.text.matchAll(/\r\n|\r|\n/g)) {
    ranges.push({ value: passage.text.slice(cursor, newline.index), index: cursor });
    cursor = newline.index! + newline[0].length;
  }
  ranges.push({ value: passage.text.slice(cursor), index: cursor });
  let lastContent = 0;
  for (let i = 0; i < ranges.length; i++) if (/[^ \t]/.test(ranges[i]!.value)) lastContent = i;
  let text = "";
  const offsets: number[] = [];
  let end = passage.offsets[0]!;
  for (let i = 0; i < ranges.length; i++) {
    const row = ranges[i]!;
    const value = row.value.replace(/\t/g, " ");
    const left = i === 0 ? 0 : /^ */.exec(value)![0].length;
    const right = i === ranges.length - 1 ? value.length : value.length - / *$/.exec(value)![0].length;
    for (let k = left; k < right; k++) { text += value[k]!; offsets.push(passage.offsets[row.index + k]!); }
    if (right > left) end = passage.offsets[row.index + right]!;
    if (right > left && i !== lastContent) { text += " "; offsets.push(end); }
  }
  offsets.push(end);
  return { text, offsets };
}

/** Literals, template fragments and JSX prose, excluding syntax-only strings. */
export function extractSourceProse(source: string, options: SourceProseOptions = {}): SourcePassage[] {
  const filename = options.filename ?? "copy.tsx";
  const typescript = /\.[cm]?tsx?$/.test(filename.toLowerCase());
  const jsx = /\.[jt]sx$/.test(filename.toLowerCase());
  let ast;
  try {
    ast = parse(source, { sourceType: "unambiguous", attachComment: false, plugins: ["decorators-legacy", ...(typescript ? ["typescript" as const] : []), ...(jsx ? ["jsx" as const] : [])] });
  } catch (error) { throw new SourceProseError(filename, error); }
  const passages: SourcePassage[] = [];
  const pending: { value: unknown; parent?: Node; key?: string }[] = [{ value: ast }];
  while (pending.length) {
    const { value, parent, key } = pending.pop()!;
    const current = node(value);
    if (!current) continue;
    // Type declarations, import/export paths, keys and comments are not prose.
    if (current.type.startsWith("TS") && !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression", "TSModuleDeclaration", "TSModuleBlock", "TSEnumDeclaration", "TSEnumMember", "TSExportAssignment", "TSParameterProperty"].includes(current.type)) continue;
    if (/^(?:Comment|Directive)/.test(current.type)) continue;
    if (current.type === "JSXAttribute" && !TEXT_ATTRIBUTES.has(String(node(current["name"])?.["name"]))) continue;
    if (current.type === "JSXElement") {
      const opening = node(current["openingElement"]);
      const name = node(opening?.["name"]);
      if (["code", "pre", "script", "style", "blockquote"].includes(String(name?.["name"]))) continue;
    }
    if (current.type === "StringLiteral" || current.type === "JSXText" || current.type === "TemplateElement") {
      const parentType = parent?.type ?? "";
      const syntaxOnly = key === "source" || key === "key" || (key === "property" && /MemberExpression$/.test(parentType));
      const callee = node(parent?.["callee"]);
      const modulePath = parentType === "ImportExpression" || (parentType === "CallExpression" && (callee?.type === "Import" || (callee?.type === "Identifier" && callee["name"] === "require")));
      const attribute = parentType === "JSXAttribute";
      const attributeName = node(parent?.["name"]);
      if (!syntaxOnly && !modulePath && (!attribute || TEXT_ATTRIBUTES.has(String(attributeName?.["name"])))) {
        const quoted = current.type === "StringLiteral";
        const start = current.start + (quoted ? 1 : 0);
        const end = current.end - (quoted ? 1 : 0);
        const decoded = decode(source.slice(start, end), start, current.type === "JSXText" || attribute);
        const passage = current.type === "JSXText" ? jsxWhitespace(decoded) : decoded;
        if (passage.text.trim()) passages.push(passage);
      }
      continue;
    }
    if (current.type === "TaggedTemplateExpression") continue;
    for (const [childKey, child] of Object.entries(current)) {
      if (["loc", "extra", "comments", "leadingComments", "trailingComments", "innerComments"].includes(childKey)) continue;
      if (Array.isArray(child)) for (let i = child.length - 1; i >= 0; i--) pending.push({ value: child[i], parent: current, key: childKey });
      else if (node(child)) pending.push({ value: child, parent: current, key: childKey });
    }
  }
  return passages.sort((a, b) => a.offsets[0]! - b.offsets[0]!);
}

/** Apply existing rules and map every finding back to its source file. */
export function lintSourceText(source: string, ruleSet: RuleSet, options: SourceProseOptions = {}): LintResult {
  const findings: LintResult["findings"] = [];
  const suppressed: LintResult["suppressed"] = [];
  const timedOut = new Set<string>();
  const sourceLines = source.split("\n");
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const locate = (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: offset - starts[lo]! + 1 };
  };
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  for (const passage of extractSourceProse(source, options)) {
    const result = lintText(passage.text, ruleSet, { ...options, budgetMs: Math.max(0, deadline - Date.now()) });
    const lines = passage.text.split("\n");
    const offsetFor = (line: number, column: number) => {
      let offset = column - 1;
      for (let i = 0; i < line - 1; i++) offset += lines[i]!.length + 1;
      return offset;
    };
    for (const finding of result.findings) {
      const offset = offsetFor(finding.line, finding.column);
      const start = passage.offsets[offset]!;
      const end = passage.offsets[Math.min(passage.text.length, offset + finding.match.length)]!;
      const location = locate(start);
      const endLocation = locate(end);
      findings.push({ ...finding, ...location, endLine: endLocation.line, endColumn: endLocation.column, match: source.slice(start, end), lineText: sourceLines[location.line - 1] ?? "" });
    }
    for (const row of result.suppressed) suppressed.push({ ...row, line: locate(passage.offsets[offsetFor(row.line, 1)]!).line });
    for (const id of result.timedOut) timedOut.add(id);
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return { findings, suppressed, timedOut: [...timedOut], errorCount: findings.filter(f => f.severity === "error").length, warnCount: findings.filter(f => f.severity === "warn").length };
}
