/**
 * The engine. Masked text plus a ruleset in, findings out.
 *
 * Everything else in this package is an adapter around this function: the CLI,
 * the Claude Code hook, the pre-commit hook and the GitHub Action all call it
 * with the same rules, so they can never disagree about what is allowed.
 */

import { maskNonProse } from "./mask.ts";
import { matchAllWithDeadline } from "./safe-regex.ts";
import { normaliseForMatching, stripZeroWidth } from "./normalise.ts";
import { sentences, jargonTerms, isShoutedWord } from "./sentences.ts";
import {
  compile,
  resolveRuleSet,
  type CompiledAllow,
  type RuleSet,
  type Severity,
} from "./rules.ts";

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

/**
 * One finding an `allow` entry stopped.
 *
 * Recorded rather than dropped because the cost of an `allow` entry used to be
 * invisible. One repository carried eleven of them; nine bought nothing, and
 * one was hiding 247 findings its author never meant to touch. Finding that
 * out took removing each entry in turn and re-running the linter.
 */
export interface Suppression {
  /** The `allow` pattern that matched. */
  pattern: string;
  ruleId: string;
  line: number;
}

export interface LintResult {
  findings: Finding[];
  errorCount: number;
  warnCount: number;
  /** What `allow` silenced. Empty unless the project declared vocabulary. */
  suppressed: Suppression[];
  /**
   * Rules abandoned because the document exhausted the match budget.
   *
   * Empty on every ordinary run. A non-empty list means those rules did not
   * report, so the result is a floor and not a verdict. Callers surface it
   * rather than dropping it: a rule that stops working without saying so is
   * the failure mode the unknown-key error exists to prevent.
   */
  timedOut: string[];
}

export interface LintOptions {
  /** Suppress a rule for the next line with an inline comment. */
  allowInlineSuppression?: boolean;
  /**
   * Total milliseconds all rules may spend matching one document.
   *
   * Shared across rules rather than granted per rule: thirty rules with a
   * one-second budget each is a thirty-second worst case, and the editor hook
   * is killed at thirty. Screening at load (`findUnsafe`) rejects the patterns
   * that are catastrophic by construction. This bounds what gets past it,
   * including a safe pattern meeting a pathological document.
   */
  budgetMs?: number;
}

/** Default document-wide match budget. */
export const DEFAULT_BUDGET_MS = 2000;

/**
 * Every directive may end in `: why this was waived`.
 *
 * Without this group a colon made the whole comment fail to match, so a writer
 * who explained a waiver silently lost the waiver. `[^>]` cannot run past the
 * terminator, so the reason stops where the comment does.
 */
const REASON = "(?:\\s*:\\s*([^>]*?))?";

/** `<!-- plain-english-disable-next-line rule-id, other-rule: why -->` */
const SUPPRESS_NEXT = new RegExp(
  `<!--\\s*plain-english-disable-next-line(?:\\s+([a-z0-9,\\s-]+?))?${REASON}\\s*-->`,
  "i",
);
/** `<!-- plain-english-disable-file: why -->` anywhere in the document. */
const SUPPRESS_FILE = new RegExp(
  `<!--\\s*plain-english-disable-file${REASON}\\s*-->`,
  "i",
);
/** `<!-- plain-english-disable rule-a, rule-b: why -->` starts a suppressed range. */
const SUPPRESS_RANGE_OFF = new RegExp(
  `<!--\\s*plain-english-disable(?:\\s+([a-z0-9,\\s-]+?))?${REASON}\\s*-->`,
  "i",
);
/** `<!-- plain-english-enable -->` ends it. It opens nothing, so it takes no reason. */
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
 * The `allow` entry that silences this rule here, if any.
 *
 * An entry with no `rules` list covers every rule, which is what a bare string
 * has always meant. An entry that names rules covers only those, so a project
 * can declare "Deal is a word we all know" to `unglossed-term` without also
 * hiding an em dash on the same line.
 */
function allowedBy(
  ruleSet: RuleSet,
  ruleId: string,
  text: string,
): CompiledAllow | undefined {
  return ruleSet.allowRe?.find(
    (a) => (!a.rules || a.rules.has(ruleId)) && a.re.test(text),
  );
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
  const { allowInlineSuppression = true, budgetMs = DEFAULT_BUDGET_MS } = options;
  const findings: Finding[] = [];
  const timedOut: string[] = [];
  // Named `silenced` and not `suppressed`: the inline-suppression map below
  // already owns that word, and the two are different mechanisms.
  const silenced: Suppression[] = [];
  const deadline = Date.now() + budgetMs;

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

  // Waivers are judged before anything is allowed to waive them. The early
  // return below runs no rule at all, so a reasonless `disable-file` is
  // reported here or nowhere.
  if (allowInlineSuppression) {
    findings.push(
      ...unexplainedSuppressions(text, directiveView, ruleSet, sourceLines, silenced),
    );
  }

  if (allowInlineSuppression && SUPPRESS_FILE.test(directiveView)) {
    return {
      findings,
      errorCount: findings.filter((f) => f.severity === "error").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
      suppressed: silenced,
      timedOut,
    };
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
      const all = matchAllWithDeadline(rule.re, masked, deadline - Date.now());
      if (all === null) {
        timedOut.push(rule.id);
        continue;
      }
      const hits = all.filter((d) => d[0].length > 0);
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

    const matches = matchAllWithDeadline(rule.re, masked, deadline - Date.now());
    if (matches === null) {
      timedOut.push(rule.id);
      continue;
    }
    for (const m of matches) {
      if (m[0].length === 0) continue;
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
      const allowed = allowedBy(ruleSet, rule.id, maskedLine);
      if (allowed) {
        silenced.push({ pattern: allowed.entry.pattern, ruleId: rule.id, line });
        continue;
      }

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

  findings.push(
    ...readabilityFindings(text, ruleSet, starts, sourceLines, suppressed, silenced),
  );

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));

  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warnCount: findings.filter((f) => f.severity === "warn").length,
    suppressed: silenced,
    timedOut,
  };
}

/** How much of the document one directive waives. */
export type WaiverScope = "line" | "range" | "file";

/** One suppression directive, as written. */
export interface Directive {
  scope: WaiverScope;
  /** The rules it silences. Empty means every rule. */
  ids: string[];
  /** The text after the colon, absent when the author wrote none. */
  reason?: string;
  /** 1-based, in the source. */
  line: number;
  column: number;
  /** The comment itself, quoted back. */
  text: string;
}

/**
 * The directive forms that open a waiver, with the group holding their reason.
 *
 * `plain-english-enable` is absent on purpose: it closes a range rather than
 * opening one, so there is nothing for it to justify. Order matters, because
 * the three patterns share a prefix and the most specific has to be tried
 * first.
 */
const OPENERS: Array<{ re: RegExp; scope: WaiverScope; idGroup: number; reason: number }> = [
  { re: SUPPRESS_NEXT, scope: "line", idGroup: 1, reason: 2 },
  { re: SUPPRESS_FILE, scope: "file", idGroup: 0, reason: 1 },
  { re: SUPPRESS_RANGE_OFF, scope: "range", idGroup: 1, reason: 2 },
];

/**
 * Every waiver in a document, read the same way the engine reads them.
 *
 * The policy report and the rule that judges reasons both call this, so a
 * waiver counted in one place cannot be missed in the other. Directives are
 * read from the fence-masked view, so the syntax quoted inside a code block by
 * any document explaining it is not itself a waiver.
 *
 * Pass `view` when the caller already has that mask. Building it parses the
 * markdown, and `lintText` needs it for its own reasons a few lines earlier.
 */
export function directivesIn(text: string, view = maskNonProse(text)): Directive[] {
  const out: Directive[] = [];

  view.split("\n").forEach((line, i) => {
    for (const opener of OPENERS) {
      const m = opener.re.exec(line);
      if (!m) continue;
      const reason = (m[opener.reason] ?? "").trim();
      const directive: Directive = {
        scope: opener.scope,
        ids: opener.idGroup
          ? (m[opener.idGroup] ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        line: i + 1,
        column: m.index + 1,
        text: m[0],
      };
      // An empty reason is no reason. `disable-file:` with nothing after it
      // reads as an author who started to explain and did not finish.
      if (reason) directive.reason = reason;
      out.push(directive);
      return;
    }
  });

  return out;
}

/**
 * Waivers that do not say why.
 *
 * This is the one rule that ignores the in-file suppression map, and it has to.
 * `disable-file` silences every rule in the document, so a reasonless
 * `disable-file` would be the single waiver nothing could ever report. The same
 * shape once made the generated style guide disable itself and lose every
 * finding without a word. Two things still silence it: `severity: off` in
 * config, and an `allow` pattern matching the line.
 */
function unexplainedSuppressions(
  text: string,
  directiveView: string,
  ruleSet: RuleSet,
  sourceLines: string[],
  silenced: Suppression[],
): Finding[] {
  const rule = (ruleSet.readability ?? []).find(
    (r) => r.kind === "unexplained-suppression",
  );
  if (!rule || rule.severity === "off") return [];
  const severity = rule.severity;

  const findings: Finding[] = [];
  for (const d of directivesIn(text, directiveView)) {
    if (d.reason) continue;
    const sourceLine = sourceLines[d.line - 1] ?? "";
    const allowed = allowedBy(ruleSet, rule.id, sourceLine);
    if (allowed) {
      silenced.push({ pattern: allowed.entry.pattern, ruleId: rule.id, line: d.line });
      continue;
    }

    const finding: Finding = {
      ruleId: rule.id,
      severity,
      match: d.text,
      line: d.line,
      column: d.column,
      lineText: sourceLine,
    };
    if (rule.message) finding.message = rule.message;
    if (rule.link) finding.link = rule.link;
    findings.push(finding);
  }
  return findings;
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
    /^\s*\(/.test(after) ||
    // The other order, "a signed record of where the code came from (SLSA)",
    // which is what "explain a thing before naming it" produces. The lowercase
    // letter is what says prose ran into the bracket, so a parenthetical that
    // opens a clause is still reported.
    /[a-z]\s*\(\s*$/.test(before)
  );
}

/**
 * Rules measured over sentence structure rather than matched at a point.
 *
 * These run on the raw source, not the masked copy. The nlcst layer already
 * drops code, tables, link destinations and blockquotes, and it needs real
 * markdown to do that, so masking first would hide the structure it reads.
 */
/**
 * Where to anchor a finding about the whole reply.
 *
 * A reply-wide fault has no one position, and pointing at character 0 with a
 * zero-width match gives an editor nothing to highlight. The first line is the
 * shortest honest answer to "where".
 */
function firstLineEnd(text: string): number {
  const nl = text.indexOf("\n");
  return nl === -1 ? Math.min(text.length, 80) : Math.min(nl, 80);
}

/**
 * The question a reply ends on, if it ends on one.
 *
 * The last sentence of the last paragraph, and only when it is a question put
 * to the reader. A reply that quotes a question and then answers it is not
 * asking anything, which is why this looks at the end rather than anywhere.
 */
function closingQuestion(masked: string): { text: string; start: number; end: number } | null {
  const end = masked.replace(/\s+$/, "").length;
  if (end === 0 || masked[end - 1] !== "?") return null;
  // Back up to the start of the sentence: the previous sentence-ending mark,
  // or the previous blank line, whichever is closer.
  let start = 0;
  for (let i = end - 2; i > 0; i--) {
    const c = masked[i]!;
    if (c === "." || c === "!" || c === "?" || c === "\n") {
      start = i + 1;
      break;
    }
  }
  const text = masked.slice(start, end).trim();
  if (!text) return null;
  return { text, start: start + (masked.slice(start, end).length - masked.slice(start, end).trimStart().length), end };
}

/**
 * Subordinating words in a question, not counting the one that opens it.
 *
 * "Which way do you want to go?" opens on its interrogative and carries no
 * clause. "Want me to look at whether X has the same Y that Z documents?"
 * carries two, and is the sentence this rule exists for.
 */
const SUBORDINATORS =
  /\b(whether|which|that|because|while|unless|although|so that|rather than|instead of|the same|as the|when the)\b/gi;

function subordinators(question: string): number {
  const body = question.replace(/^(which|what|who|whose|how)\b/i, "");
  return (body.match(SUBORDINATORS) ?? []).length;
}

/**
 * Text shaped like a name rather than like a word.
 *
 * One of: a flag (`--agent`), a word with an internal hyphen or underscore
 * (`reader-load`, `max_words`), a dotted filename (`rules/default.yml`), or a
 * path. Ordinary English matches none of these, which is the point: this runs
 * over the whole reply including tables and fenced output, so anything looser
 * would fire on every paragraph.
 */
const IDENTIFIER_NAME =
  /(?:^|[\s"'(\[|`])((?:--?[a-z][a-z0-9-]{1,}|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|[\w./~-]+\.[a-z]{2,4}|~?\/[\w./-]{3,}))(?=[\s"')\].,;:|`]|$)/gi;

function readabilityFindings(
  text: string,
  ruleSet: RuleSet,
  starts: number[],
  sourceLines: string[],
  suppressed: Map<number, Set<string> | "all">,
  silenced: Suppression[],
): Finding[] {
  // `lintText` is this package's public entry point, so a ruleset assembled by
  // a consumer rather than by `compile` reaches here. Missing readability is a
  // ruleset from before 0.2.0, not a reason to throw.
  const active = (ruleSet.readability ?? []).filter((r) => r.severity !== "off");
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
    /**
     * How much prose one reply asks the reader to get through.
     *
     * Counted by summing sentence words rather than splitting the raw source,
     * so fenced output, tables and link destinations do not count. That is
     * deliberate: `quote-the-decisive-line` says quoting real output outranks
     * brevity, and a rule that punished the quote would contradict it.
     */
    if (rule.kind === "reply-length") {
      const max = rule.maxWords ?? 250;
      let words = 0;
      for (const sentence of sentences(text)) words += sentence.words;
      if (words > max) {
        add(
          rule,
          0,
          Math.min(text.length, firstLineEnd(text)),
          `${words} words of prose, over ${max}.` + (rule.message ? ` ${rule.message}` : ""),
        );
      }
      continue;
    }

    /**
     * How many separate names the reader has to hold at once.
     *
     * The count is distinct backticked names, and it is absolute rather than a
     * rate. Measured over seven days of transcripts on 2026-08-18: in the
     * replies the reader complained about, jargon *density* was LOWER than in
     * long replies generally (2.4 per 100 words against 4.1). What separated
     * them was the total, a median of 18 against 12. Five terms in a sixty-word
     * answer is over quickly. Eighteen across five hundred words is a load
     * carried to the end.
     */
    if (rule.kind === "reader-load") {
      const max = rule.maxTerms ?? 15;
      const names = new Set<string>();
      for (const m of text.matchAll(/(?<!`)`([^`\n]{1,80})`(?!`)/g)) {
        const name = (m[1] ?? "").trim();
        if (name) names.add(name.toLowerCase());
      }
      // And every name the reply put anywhere else.
      //
      // Backticks alone counted only what the writer chose to mark up, so a
      // reply could set fifteen unfamiliar names in a table or a fenced block
      // and the counter saw none of them. On 2026-08-20 one did, and the
      // answer was "I have no idea of anything you just wrote".
      //
      // Identifier-shaped only, so prose is never counted: an internal hyphen
      // or underscore, a leading dash, a dotted filename, or a path. That is
      // what `reader-load` and `--agent` have in common and what "the" does
      // not. It is a floor rather than the whole load, and the ruleset says so:
      // a tool called by an ordinary word is invisible to any pattern, which is
      // why `chat.judge` carries `reads-as-an-internal-note` as well.
      for (const m of text.matchAll(IDENTIFIER_NAME)) {
        const name = (m[1] ?? "").trim().toLowerCase().replace(/[.,;:]+$/, "");
        if (name.length > 2) names.add(name);
      }
      if (names.size > max) {
        add(
          rule,
          0,
          Math.min(text.length, firstLineEnd(text)),
          `${names.size} separate names, over ${max}.` +
            (rule.message ? ` ${rule.message}` : ""),
        );
      }
      continue;
    }

    /**
     * Whether the reply ever lets up.
     *
     * The average sentence, across the whole reply. `long-sentence` judges one
     * sentence and finds nothing wrong with a reply of fifteen-word sentences,
     * which is exactly the reply that gets abandoned: no single sentence is
     * hard and there is no gap to rest in.
     *
     * Measured on 2026-08-19 over the 218 replies the gate judged. The corpus
     * median is 11.6 words a sentence. Of the four replies the reader stopped
     * on and complained about, every one ran above it: 13.5, 14.5, 15.7, 16.6.
     * Three other readings of "dense" went the other way. Those replies had
     * FEWER nominalisations, FEWER stacked modifiers and SHORTER words than the
     * corpus, so the vocabulary was not the load. The pace was.
     */
    if (rule.kind === "reply-pace") {
      const floor = rule.minWords ?? 80;
      const max = rule.maxMeanWords ?? 13;
      let words = 0;
      let count = 0;
      for (const sentence of sentences(text)) {
        words += sentence.words;
        count++;
      }
      if (count > 0 && words >= floor) {
        const mean = words / count;
        if (mean > max) {
          add(
            rule,
            0,
            Math.min(text.length, firstLineEnd(text)),
            `${mean.toFixed(1)} words a sentence on average, over ${max}.` +
              (rule.message ? ` ${rule.message}` : ""),
          );
        }
      }
      continue;
    }

    /**
     * The question a reply ends on.
     *
     * `say-what-needs-a-decision` asks every reply with a choice in it to end
     * by naming the choice. This is the other half: an ask the reader has to
     * unpack before answering leaves them worse off than no ask at all.
     *
     * Two measures, because the fault comes in two shapes. Read across three
     * days of transcripts to 2026-08-19: of 64 replies that ended in a
     * question, 10 were long or nested, and those included the one the reader
     * answered with "That last sentence: what does that mean?".
     *
     * A leading "which" or "what" is the interrogative, not a clause. Counting
     * it fired on "Which one, and which rec?", which is five words and clear.
     */
    if (rule.kind === "unreadable-ask") {
      const max = rule.maxWords ?? 15;
      const maxClauses = rule.maxClauses ?? 1;
      // Masked, not raw: a reply that ends in a fenced block or a table has no
      // closing question, and `maskNonProse` preserves offsets so the finding
      // still lands on the right line.
      const ask = closingQuestion(maskNonProse(text));
      if (ask) {
        const words = (ask.text.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;
        const clauses = subordinators(ask.text);
        if (words > max || clauses > maxClauses) {
          const why =
            words > max
              ? `${words} words, over ${max}.`
              : `${clauses} clauses to unpack before it can be answered.`;
          add(rule, ask.start, ask.end, why + (rule.message ? ` ${rule.message}` : ""));
        }
      }
      continue;
    }

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

    /**
     * How widely the sentence lengths vary.
     *
     * Every other rule here judges one sentence. This judges the set. Prose a
     * person edited swings between short and long; generated prose clusters
     * near one length, and it goes on clustering after the giveaway words are
     * taken out, which is the whole reason this exists.
     *
     * The figure is the standard deviation over the mean, so it compares a
     * short document with a long one. Sentences under three words are dropped:
     * a heading fragment or a one-word list item is not prose and would widen
     * the spread for free.
     */
    if (rule.kind === "sentence-spread") {
      const floor = rule.minSentences ?? 20;
      const min = rule.minSpread ?? 0.45;
      const words = sentences(text)
        .map((s) => s.words)
        .filter((n) => n >= 3);
      if (words.length < floor) continue;
      const mean = words.reduce((a, b) => a + b, 0) / words.length;
      if (mean <= 0) continue;
      const sd = Math.sqrt(
        words.reduce((a, b) => a + (b - mean) ** 2, 0) / words.length,
      );
      const spread = sd / mean;
      if (spread >= min) continue;
      add(
        rule,
        0,
        Math.min(text.length, firstLineEnd(text)),
        `sentence spread ${spread.toFixed(2)}, under ${min}.` +
          (rule.message ? ` ${rule.message}` : ""),
      );
      continue;
    }

    if (rule.kind === "unglossed-term") {
      // A term counts as explained once it has appeared before, so only the
      // FIRST use is ever reported. Repeating an acronym is not the problem;
      // introducing one without saying what it does is.
      const seen = new Set<string>();
      const known = new Set((rule.known ?? []).map((k) => k.toLowerCase()));
      const emphasis = new Set((rule.emphasis ?? []).map((k) => k.toLowerCase()));
      for (const term of jargonTerms(text)) {
        const key = term.text.toLowerCase();
        if (known.has(key)) continue;
        // A word shouted for emphasis is the same shape as an acronym and is
        // not jargon. "End every workflow with DONE" asks for no gloss.
        if (emphasis.has(key) || isShoutedWord(term.text)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        // A project's own vocabulary is declared through `allow`.
        const allowed = allowedBy(ruleSet, rule.id, term.text);
        if (allowed) {
          const { line } = locate(starts, term.start);
          silenced.push({ pattern: allowed.entry.pattern, ruleId: rule.id, line });
          continue;
        }
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
