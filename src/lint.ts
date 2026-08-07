/**
 * The engine. Masked text plus a ruleset in, findings out.
 *
 * Everything else in this package is an adapter around this function: the CLI,
 * the Claude Code hook, the pre-commit hook and the GitHub Action all call it
 * with the same rules, so they can never disagree about what is allowed.
 */

import { maskNonProse } from "./mask.ts";
import { normaliseForMatching, stripZeroWidth } from "./normalise.ts";
import { sentences, jargonTerms } from "./sentences.ts";
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
  /** URL explaining the rule, shown with the finding. */
  link?: string;
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
/** `<!-- plain-english-disable rule-a, rule-b -->` starts a suppressed range. */
const SUPPRESS_RANGE_OFF = /<!--\s*plain-english-disable(?:\s+([a-z0-9,\s-]+?))?\s*-->/i;
/** `<!-- plain-english-enable -->` ends it. */
const SUPPRESS_RANGE_ON = /<!--\s*plain-english-enable(?:\s+([a-z0-9,\s-]+?))?\s*-->/i;

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
function parseIds(raw: string | undefined): Set<string> | "all" {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : "all";
}

function merge(
  a: Set<string> | "all" | undefined,
  b: Set<string> | "all",
): Set<string> | "all" {
  if (a === undefined) return b;
  if (a === "all" || b === "all") return "all";
  return new Set([...a, ...b]);
}

/**
 * Which rules are suppressed on each line.
 *
 * Three forms, matching the convention the ecosystem settled on:
 *   <!-- plain-english-disable-next-line rule -->   one line
 *   <!-- plain-english-disable rule --> ... enable  a range
 *   <!-- plain-english-disable-file -->             the whole file
 *
 * A range directive with no rule ids suppresses everything until the matching
 * enable, or to the end of the document when the enable is missing.
 */
function suppressionsFor(sourceLines: string[]): Map<number, Set<string> | "all"> {
  const map = new Map<number, Set<string> | "all">();

  sourceLines.forEach((line, i) => {
    const m = SUPPRESS_NEXT.exec(line);
    if (!m) return;
    map.set(i + 2, merge(map.get(i + 2), parseIds(m[1]))); // 1-based, next line
  });

  let active: Set<string> | "all" | null = null;
  sourceLines.forEach((line, i) => {
    // disable-next-line and disable-file both contain "disable", so the range
    // form has to be matched only when neither of the others applies.
    const isNext = SUPPRESS_NEXT.test(line);
    const isFile = SUPPRESS_FILE.test(line);
    const on = !isNext && !isFile ? SUPPRESS_RANGE_ON.exec(line) : null;
    const off = !isNext && !isFile ? SUPPRESS_RANGE_OFF.exec(line) : null;

    if (on) {
      const ids = parseIds(on[1]);
      if (ids === "all" || active === "all" || active === null) active = null;
      else {
        for (const id of ids) active.delete(id);
        if (active.size === 0) active = null;
      }
      return;
    }
    if (off) {
      active = merge(active ?? undefined, parseIds(off[1]));
      return;
    }
    if (active !== null) map.set(i + 1, merge(map.get(i + 1), active));
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
  // Normalisation folds dash variants, dash entities and zero-width characters
  // to a canonical form at identical length, so offsets stay valid. Without it
  // the em dash rule was defeated by `&mdash;` and by the fullwidth dash.
  const normalised = normaliseForMatching(maskNonProse(text, { maskComments: true }));
  // Zero-width characters have to be deleted to be matched through, which
  // shifts offsets, so `toSource` maps a match position back to the original.
  const compacted = stripZeroWidth(normalised);
  const masked = compacted.text;
  const toSource = (i: number): number => compacted.map?.[i] ?? i;
  const starts = lineIndex(text);
  const sourceLines = text.split("\n");
  const maskedLines = normalised.split("\n");

  if (allowInlineSuppression && SUPPRESS_FILE.test(directiveView)) {
    return { findings, errorCount: 0, warnCount: 0 };
  }

  const suppressed = allowInlineSuppression
    ? suppressionsFor(directiveView.split("\n"))
    : new Map<number, Set<string> | "all">();

  // Word count for density rules. Counted once, from prose only.
  const wordCount = (masked.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;

  for (const rule of ruleSet.rules) {
    if (rule.severity === "off" || !rule.re) continue;

    // A density rule reports nothing until the rate crosses its threshold, so
    // the whole document has to be counted before any finding is emitted.
    if (rule.perThousandWords !== undefined) {
      rule.re.lastIndex = 0;
      const hits: RegExpExecArray[] = [];
      let d: RegExpExecArray | null;
      while ((d = rule.re.exec(masked)) !== null) {
        if (d[0].length === 0) rule.re.lastIndex++;
        else hits.push(d);
      }
      if (!hits.length || wordCount === 0) continue;
      const rate = (hits.length / wordCount) * 1000;
      if (rate <= rule.perThousandWords) continue;

      const first = hits[0]!;
      const startAt = toSource(first.index);
      const { line, column } = locate(starts, startAt);
      const finding: Finding = {
        ruleId: rule.id,
        severity: rule.severity,
        match: text.slice(startAt, toSource(first.index + first[0].length - 1) + 1),
        line,
        column,
        lineText: sourceLines[line - 1] ?? "",
        message:
          `${hits.length} in ${wordCount} words is ${rate.toFixed(1)} per 1,000, ` +
          `over the ${rule.perThousandWords} threshold` +
          (rule.message ? `. ${rule.message}` : ""),
      };
      if (rule.link) finding.link = rule.link;
      findings.push(finding);
      continue;
    }

    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const sourceStart = toSource(m.index);
      const sourceEnd = toSource(m.index + m[0].length - 1) + 1;
      const { line, column } = locate(starts, sourceStart);
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
        match: text.slice(sourceStart, sourceEnd),
        line,
        column,
        lineText: sourceLine,
      };
      if (rule.message) finding.message = rule.message;
      if (rule.link) finding.link = rule.link;
      findings.push(finding);
    }
  }

  findings.push(...readabilityFindings(text, ruleSet, starts, sourceLines, suppressed));

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));

  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warnCount: findings.filter((f) => f.severity === "warn").length,
  };
}

/**
 * True when a term is introduced together with its explanation.
 *
 * "The identity check is called OIDC" has already done the work the rule asks
 * for, so flagging it would tell the author to do what they just did.
 */
function isGlossed(text: string, start: number, end: number): boolean {
  // A wide window, so "OIDC stands for OpenID Connect" glosses OpenID too:
  // the expansion of an acronym is its definition, not fresh jargon.
  const before = text.slice(Math.max(0, start - 60), start);
  const after = text.slice(end, end + 40);
  return (
    /\b(called|named|known as|termed|dubbed|abbreviated|short for|stands for|an acronym for)\s+[("'`]?$/i.test(before) ||
    /^[)"'`]?\s*(stands for|means|is short for)\b/i.test(after) ||
    /^[)"'`]?\s*,\s*(which|meaning)\b/i.test(after) ||
    /^\s*\(/.test(after)
  );
}

/**
 * Rules measured over sentence structure rather than matched at a point.
 *
 * These run on the raw source, not the masked copy. The nlcst layer already
 * drops code, tables, link destinations and blockquotes, and it needs real
 * markdown to do that, so masking first would hide the structure it reads.
 */
function readabilityFindings(
  text: string,
  ruleSet: RuleSet,
  starts: number[],
  sourceLines: string[],
  suppressed: Map<number, Set<string> | "all">,
): Finding[] {
  const active = ruleSet.readability.filter((r) => r.severity !== "off");
  if (!active.length) return [];

  const out: Finding[] = [];
  const add = (
    rule: { id: string; severity: Severity; message?: string; link?: string },
    start: number,
    end: number,
    message?: string,
  ) => {
    const { line, column } = locate(starts, start);
    const sup = suppressed.get(line);
    if (sup === "all" || (sup instanceof Set && sup.has(rule.id))) return;
    const finding: Finding = {
      ruleId: rule.id,
      severity: rule.severity as Exclude<Severity, "off">,
      match: text.slice(start, end),
      line,
      column,
      lineText: sourceLines[line - 1] ?? "",
    };
    const msg = message ?? rule.message;
    if (msg) finding.message = msg;
    if (rule.link) finding.link = rule.link;
    out.push(finding);
  };

  for (const rule of active) {
    if (rule.kind === "long-sentence") {
      const max = rule.maxWords ?? 35;
      for (const sentence of sentences(text)) {
        if (sentence.words <= max) continue;
        add(
          rule,
          sentence.start,
          sentence.end,
          `${sentence.words} words, over ${max}.` + (rule.message ? ` ${rule.message}` : ""),
        );
      }
      continue;
    }

    if (rule.kind === "unglossed-term") {
      // A term counts as explained once it has appeared before, so only the
      // FIRST use is ever reported. Repeating an acronym is not the problem;
      // introducing one without saying what it does is.
      const seen = new Set<string>();
      const known = new Set((rule.known ?? []).map((k) => k.toLowerCase()));
      for (const term of jargonTerms(text)) {
        const key = term.text.toLowerCase();
        if (known.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        // A project's own vocabulary is declared through `allow`.
        if (ruleSet.allowRe?.some((re) => re.test(term.text))) continue;
        // The whole point of the rule is "explain it, then name it", so a term
        // that arrives already attached to its explanation has complied. This
        // catches the naming half of that sentence: "...is called OIDC",
        // "known as SLSA", "OIDC stands for...", "SLSA, which means...".
        if (isGlossed(text, term.start, term.end)) continue;
        add(rule, term.start, term.end, `"${term.text}" is not explained.` + (rule.message ? ` ${rule.message}` : ""));
      }
    }
  }

  return out;
}

/** Convenience: resolve the ruleset for `cwd` and lint. */
export function lint(text: string, cwd: string = process.cwd()): LintResult {
  return lintText(text, resolveRuleSet(cwd));
}

export { compile, resolveRuleSet };
export type { RuleSet, Severity };
export { maskNonProse } from "./mask.ts";
export { loadDefault, loadConfig, merge, RuleError } from "./rules.ts";
