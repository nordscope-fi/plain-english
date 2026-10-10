/**
 * Check one draft passed as text (ADR-009).
 *
 * The plain-english skill's script calls this in Claude chat and Cowork,
 * where there is no project, no session and no hook event. The caller is the
 * model, so the checks a judge makes in Claude Code come back as questions
 * for it to answer about its own draft.
 */

import { HOOK_BUDGET_MS } from "./adapters/hook.ts";
import { JUDGEABLE } from "./adapters/chat.ts";
import type { CheckerIo } from "./io.ts";
import { DEFAULT_BUDGET_MS, lintText, type Finding } from "./lint.ts";
import { chatRuleSet, compile, loadDefault } from "./rules.ts";

export type DraftKind = "reply" | "document";

export interface DraftFinding {
  ruleId: string;
  severity: "error" | "warn";
  line: number;
  column: number;
  /** The matched passage. */
  quote: string;
  /** What to do about it. */
  message: string;
  /** A count the person's request can justify, such as length they asked for. */
  mayStand?: true;
}

export interface DraftReport {
  status: "checked" | "incomplete" | "invalid";
  kind?: DraftKind;
  findings: DraftFinding[];
  /** Questions only a reader can answer. */
  review: string[];
  /** Why a report is incomplete or invalid, and what a long report left out. */
  notes: string[];
}

export interface DraftCheckOptions {
  /** Milliseconds all rules may spend matching. Tests pass 0 to force a timeout. */
  budgetMs?: number;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * How many findings a report lists. Chat's code tool shows only part of a long
 * output, and a 300,000-character draft full of tells made several megabytes
 * of JSON that reached Claude cut off (#149). A draft past these limits needs
 * a rewrite, not a longer list.
 */
const MAX_PER_RULE = 5;
const MAX_FINDINGS = 50;

/** The findings a report lists, and a note for each kind of cut. */
function capped(all: DraftFinding[]): { findings: DraftFinding[]; notes: string[] } {
  const notes: string[] = [];
  const perRule = new Map<string, number>();
  const leftOut = new Map<string, number>();
  const kept = all.filter((f) => {
    const seen = perRule.get(f.ruleId) ?? 0;
    perRule.set(f.ruleId, seen + 1);
    if (seen < MAX_PER_RULE) return true;
    leftOut.set(f.ruleId, (leftOut.get(f.ruleId) ?? 0) + 1);
    return false;
  });
  for (const [rule, count] of leftOut) notes.push(`${count} more for ${rule} were left out.`);
  if (kept.length <= MAX_FINDINGS) return { findings: kept, notes };
  // Errors before warnings, then back into reading order.
  const chosen = new Set(
    [...kept].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)).slice(0, MAX_FINDINGS),
  );
  notes.push(`Showing ${MAX_FINDINGS} of ${all.length} findings. Fix these and check again.`);
  return { findings: kept.filter((f) => chosen.has(f)), notes };
}

function asFinding(f: Finding): DraftFinding {
  return {
    ruleId: f.ruleId,
    severity: f.severity,
    line: f.line,
    column: f.column,
    quote: f.match,
    message: f.message ?? "",
    ...(JUDGEABLE.has(f.ruleId) ? { mayStand: true as const } : {}),
  };
}

export function checkDraft(request: unknown, io: CheckerIo, options: DraftCheckOptions = {}): DraftReport {
  const invalid = (note: string, kind?: DraftKind): DraftReport => ({
    status: "invalid",
    ...(kind ? { kind } : {}),
    findings: [],
    review: [],
    notes: [note],
  });
  if (request === null || typeof request !== "object") {
    return invalid("The request must be an object with text and kind.");
  }
  const { text, kind } = request as Record<string, unknown>;
  if (kind !== "reply" && kind !== "document") {
    return invalid(`The kind must be reply or document; got ${kind === undefined ? "none" : JSON.stringify(kind)}.`);
  }
  if (typeof text !== "string" || !text.trim()) {
    return invalid("The text is empty, so there is no draft to check.", kind);
  }

  const base = compile(loadDefault(io));
  const reply = kind === "reply";
  const result = lintText(reply ? text.trim() : text, reply ? chatRuleSet(base) : base, {
    // A draft carries no waivers, and one that quotes the directive syntax is
    // not writing one.
    allowInlineSuppression: false,
    budgetMs: options.budgetMs ?? (reply ? HOOK_BUDGET_MS : DEFAULT_BUDGET_MS),
  });

  const { findings, notes } = capped(result.findings.map(asFinding));
  const review = reply
    ? base.chat.judge.map((check) => `${check.id}: ${oneLine(check.description)}`)
    : base.docs.guidance.flatMap((g) => (g.flag ? [`${g.id}: ${oneLine(g.flag)}`] : []));

  if (result.timedOut.length) {
    const rules = [...result.timedOut].sort().join(", ");
    return { status: "incomplete", kind, findings, review, notes: [`These rules ran out of time and did not report: ${rules}.`, ...notes] };
  }
  return { status: "checked", kind, findings, review, notes };
}
