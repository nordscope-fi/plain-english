/**
 * The engine. Masked text plus a ruleset in, findings out.
 *
 * Everything else in this package is an adapter around this function: the CLI,
 * the Claude Code hook, the pre-commit hook and the GitHub Action all call it
 * with the same rules, so they can never disagree about what is allowed.
 */

import { maskNonProse } from "./mask.ts";
import { compile, resolveRuleSet, type RuleSet, type Severity } from "./rules.ts";

export interface Finding {
  ruleId: string;
  severity: Exclude<Severity, "off">;
  /** The exact substring that matched, quoted back so a human can find it. */
  match: string;
  line: number;
  column: number;
  /** The full source line, for context in the report. */
  lineText: string;
  message?: string;
}

export interface LintResult {
  findings: Finding[];
  errorCount: number;
  warnCount: number;
}

export interface LintOptions {
  /** Suppress a rule for the next line with an inline comment. */
  allowInlineSuppression?: boolean;
}

/** `<!-- plain-english-disable-next-line rule-id, other-rule -->` */
const SUPPRESS_NEXT =
  /<!--\s*plain-english-disable-next-line(?:\s+([a-z0-9,\s-]+?))?\s*-->/i;
/** `<!-- plain-english-disable-file -->` anywhere in the document. */
const SUPPRESS_FILE = /<!--\s*plain-english-disable-file\s*-->/i;

function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function locate(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

/**
 * Which rules are suppressed for a given line, from the comment on the line
 * above it. An empty id list suppresses every rule on that line.
 */
function suppressionsFor(sourceLines: string[]): Map<number, Set<string> | "all"> {
  const map = new Map<number, Set<string> | "all">();
  sourceLines.forEach((line, i) => {
    const m = SUPPRESS_NEXT.exec(line);
    if (!m) return;
    const ids = (m[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    map.set(i + 2, ids.length ? new Set(ids) : "all"); // 1-based, next line
  });
  return map;
}

/**
 * Run the ruleset over a block of text.
 *
 * `text` is raw source. Masking happens here, so no caller has to remember to
 * do it, which is how the original guard ended up scanning code blocks.
 */
export function lintText(
  text: string,
  ruleSet: RuleSet,
  options: LintOptions = {},
): LintResult {
  const { allowInlineSuppression = true } = options;
  const findings: Finding[] = [];

  // Two views of the same text.
  //
  // `directiveView` keeps HTML comments, so suppression directives are
  // readable, but blanks code fences, so a directive shown as an EXAMPLE inside
  // a fence is not live. Reading directives from raw source made the generated
  // style guide disable itself: it documents the disable-file comment in a
  // fenced block, and every finding in the file vanished without a word.
  //
  // `masked` blanks comments as well, so the rule name inside a directive
  // (`disable-next-line leverage`) is not itself reported as a finding.
  const directiveView = maskNonProse(text);
  const masked = maskNonProse(text, { maskComments: true });
  const starts = lineIndex(text);
  const sourceLines = text.split("\n");
  const maskedLines = masked.split("\n");

  if (allowInlineSuppression && SUPPRESS_FILE.test(directiveView)) {
    return { findings, errorCount: 0, warnCount: 0 };
  }

  const suppressed = allowInlineSuppression
    ? suppressionsFor(directiveView.split("\n"))
    : new Map<number, Set<string> | "all">();

  for (const rule of ruleSet.rules) {
    if (rule.severity === "off" || !rule.re) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const { line, column } = locate(starts, m.index);
      const maskedLine = maskedLines[line - 1] ?? "";
      const sourceLine = sourceLines[line - 1] ?? "";

      // `unless` and `allow` are both checked against the masked line, so an
      // exception can never be satisfied by text hiding inside a code span.
      //
      // `allow` used to be tested against the matched term alone, which made it
      // useless: an entry only fired if it matched a banned word, so a project
      // vocabulary list like "pipeline stages" suppressed nothing at all. The
      // whole shipped example config was inert. Matching the line is what the
      // documentation always described.
      if (rule.unlessRe?.some((re) => re.test(maskedLine))) continue;
      if (ruleSet.allowRe?.some((re) => re.test(maskedLine))) continue;

      const sup = suppressed.get(line);
      if (sup === "all" || (sup instanceof Set && sup.has(rule.id))) continue;

      const finding: Finding = {
        ruleId: rule.id,
        severity: rule.severity,
        match: text.slice(m.index, m.index + m[0].length),
        line,
        column,
        lineText: sourceLine,
      };
      if (rule.message) finding.message = rule.message;
      findings.push(finding);
    }
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));

  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warnCount: findings.filter((f) => f.severity === "warn").length,
  };
}

/** Convenience: resolve the ruleset for `cwd` and lint. */
export function lint(text: string, cwd: string = process.cwd()): LintResult {
  return lintText(text, resolveRuleSet(cwd));
}

export { compile, resolveRuleSet };
export type { RuleSet, Severity };
export { maskNonProse } from "./mask.ts";
export { loadDefault, loadConfig, merge, RuleError } from "./rules.ts";
