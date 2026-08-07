/**
 * Claude Code PreToolUse adapter.
 *
 * Reads a hook payload on stdin, works out which text the call would put in
 * front of a reader, and returns an allow/deny decision.
 *
 * The extraction rules here encode escapes that reached real readers:
 *
 *   - Issue titles and patch bodies were invisible to the original guard, so
 *     em-dash titles landed for months.
 *   - Only the INSERTED side of an edit is judged. Judging the removed side
 *     means you can never edit a file that already contains a banned term.
 *   - `git commit -F msg.txt` carries no message in the command string. A guard
 *     that reads only the command sees nothing at all.
 *
 * Fail-open throughout. An internal error must never block a commit.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { lintText, type Finding } from "../lint.ts";
import { resolveRuleSet, type RuleSet } from "../rules.ts";
import { matchesAny } from "../glob.ts";

export type Channel = "docs" | "github" | "issue";

export interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/**
 * What the hook asks Claude Code to do.
 *
 *   allow  nothing to report
 *   ask    surface to the human and let them decide
 *   deny   refuse the write outright
 *
 * `deny` overrides --dangerously-skip-permissions, so a denied write has no
 * user-side escape hatch short of removing the hook. That is a lot of power
 * for a subjective style rule, so it is reserved for the opt-in strict mode.
 */
export type HookDecision = "allow" | "ask" | "deny";

export interface Decision {
  allow: boolean;
  decision: HookDecision;
  reason?: string;
  findings: Finding[];
  /**
   * Rules that ran out of match budget on this payload.
   *
   * Present only when the scan was incomplete. The write is still allowed,
   * because a linter must never be the reason a commit cannot happen, but the
   * caller can tell "nothing found" apart from "did not finish looking".
   */
  timedOut?: string[];
}

/**
 * Match budget for one hook payload.
 *
 * Claude Code kills the hook at thirty seconds. Well under that on purpose: a
 * write stalled for several seconds is a worse outcome than a banned term
 * reaching a document that a human is about to read anyway.
 */
export const HOOK_BUDGET_MS = 500;

/** Commands that introduce text a human will read. Everything else is ignored. */
const WRITE_COMMAND =
  /(^|[;&|]\s*)(git\s+commit\b|gh\s+pr\s+(create|edit|comment|review)\b|gh\s+issue\s+(create|edit|comment)\b|gh\s+release\s+(create|edit)\b)/i;

/** Flags whose value is a path to the real message body. */
const FILE_FLAG =
  /(?:^|\s)(?:-F|--file|--body-file|--notes-file)[=\s]+("([^"]+)"|'([^']+)'|([^\s"']+))/g;

/** Flags whose value is inline message text. */
const INLINE_FLAG =
  /(?:^|\s)(?:-m|--message|-t|--title|-b|--body|-n|--notes|--subject)[=\s]+("((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+))/g;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** Heredoc bodies, which is how multi-line commit messages usually arrive. */
function heredocBodies(cmd: string): string[] {
  const out: string[] = [];
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*?)\r?\n\s*\2\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (m[3]) out.push(m[3]);
  }
  return out;
}

/**
 * The text a Bash command would publish. Returns an empty array for read-only
 * commands so `gh pr view` never gets judged on somebody else's prose.
 */
export function extractFromBash(cmd: string): string[] {
  if (!WRITE_COMMAND.test(cmd)) return [];
  const parts: string[] = [];

  for (const body of heredocBodies(cmd)) parts.push(body);

  INLINE_FLAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_FLAG.exec(cmd)) !== null) {
    const value = m[2] ?? m[3] ?? m[4];
    if (value) parts.push(value.replace(/\\(["\\$`])/g, "$1"));
  }

  FILE_FLAG.lastIndex = 0;
  while ((m = FILE_FLAG.exec(cmd)) !== null) {
    const raw = m[2] ?? m[3] ?? m[4];
    if (!raw) continue;
    const path = expandHome(raw);
    try {
      // An unreadable path is not an error. The commit may create it later, or
      // the guard may simply be running somewhere else.
      parts.push(readFileSync(path, "utf8"));
    } catch {
      /* fail-open */
    }
  }

  return parts.filter((p) => p.trim() !== "");
}

/** The text a Write/Edit/MultiEdit/NotebookEdit call would put into a file. */
export function extractFromFileWrite(
  tool: string,
  input: Record<string, unknown>,
): string[] {
  switch (tool) {
    case "Write":
      return [str(input["content"])];
    case "Edit":
      // Only the inserted side.
      return [str(input["new_string"])];
    case "MultiEdit": {
      const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
      return edits.map((e) => str((e as Record<string, unknown>)["new_string"]));
    }
    case "NotebookEdit":
      return [str(input["new_source"])];
    default:
      return [];
  }
}

/** The text a Linear-style issue call would show a reader. */
export function extractFromIssue(input: Record<string, unknown>): string[] {
  const parts = [str(input["title"]), str(input["description"]), str(input["body"])];
  const patch = Array.isArray(input["patch"]) ? input["patch"] : [];
  for (const p of patch) {
    const entry = p as Record<string, unknown>;
    // new_string / text only. old_string is text being replaced.
    parts.push(str(entry["new_string"]), str(entry["text"]));
  }
  return parts.filter((p) => p.trim() !== "");
}

function isUnderProject(file: string, projectDir: string): boolean {
  if (!projectDir) return true; // no scope signal, judge it
  const f = resolve(file);
  const p = resolve(projectDir);
  return f === p || f.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Decide on a payload.
 *
 * `projectDir` scopes the docs channel. Without it every markdown file the
 * session touches anywhere on disk would be judged, including other repos.
 */
export function decide(
  payload: HookPayload,
  channel: Channel,
  opts: { projectDir?: string; ruleSet?: RuleSet } = {},
): Decision {
  const tool = str(payload.tool_name);
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  const projectDir = opts.projectDir ?? process.env["CLAUDE_PROJECT_DIR"] ?? "";

  let texts: string[] = [];
  let filePath = "";

  if (channel === "docs") {
    filePath = str(input["file_path"]) || str(input["notebook_path"]);
    if (!filePath) return { allow: true, decision: "allow", findings: [] };
    if (!/\.(md|markdown|mdx)$/i.test(filePath)) return { allow: true, decision: "allow", findings: [] };
    if (isAbsolute(filePath) && !isUnderProject(filePath, projectDir)) {
      return { allow: true, decision: "allow", findings: [] };
    }
    texts = extractFromFileWrite(tool, input);
  } else if (channel === "github") {
    if (tool !== "Bash") return { allow: true, decision: "allow", findings: [] };
    texts = extractFromBash(str(input["command"]));
  } else {
    texts = extractFromIssue(input);
  }

  texts = texts.filter((t) => t.trim() !== "");
  if (!texts.length) return { allow: true, decision: "allow", findings: [] };

  const ruleSet = opts.ruleSet ?? resolveRuleSet(projectDir || process.cwd());

  // A file the project has excluded is never judged, whichever channel it
  // arrives through.
  if (filePath) {
    const rel = projectDir
      ? resolve(filePath).slice(resolve(projectDir).length + 1)
      : filePath;
    if (matchesAny(rel, ruleSet.exclude)) {
      return { allow: true, decision: "allow", findings: [] };
    }
  }

  const findings: Finding[] = [];
  const stalled = new Set<string>();
  for (const text of texts) {
    // A hook payload is one edit, so the budget is tighter than the CLI's:
    // Claude Code kills the hook at 30 seconds, and a write held up for even a
    // few is worse than a term slipping through. Fail-open on exhaustion.
    const res = lintText(text, ruleSet, { budgetMs: HOOK_BUDGET_MS });
    findings.push(...res.findings);
    for (const id of res.timedOut) stalled.add(id);
  }

  const errors = findings.filter((f) => f.severity === "error");
  if (!errors.length) {
    // Allowing is the only safe answer, but say so rather than reporting a
    // clean scan. Otherwise a pathological document is the way past the guard.
    if (stalled.size) {
      return { allow: true, decision: "allow", findings, timedOut: [...stalled].sort() };
    }
    return { allow: true, decision: "allow", findings };
  }

  // The last-resort hatch the refusal message offers. It was advertised for
  // three releases without anything reading it, so `touch` did nothing and the
  // only way past a false positive was to edit config or pull the hook.
  if (hasAck(channel, projectDir || process.cwd())) {
    return { allow: true, decision: "allow", findings };
  }

  // Strict mode refuses outright. Otherwise the finding is surfaced to the
  // human, who can wave it through without editing config or removing a hook.
  const decision: HookDecision = ruleSet.failOn === "never" ? "ask" : "deny";
  return { allow: false, decision, reason: formatReason(errors, channel), findings };
}

/** How long a `touch`ed ack file waives findings for. */
export const ACK_WINDOW_MS = 10 * 60 * 1000;

/**
 * True when the human has waived this channel recently.
 *
 * It expires on purpose. A permanent file is one somebody creates during a
 * deadline and never removes, which turns the whole check off silently and
 * without a record. Ten minutes is long enough to land the write in front of
 * you and short enough that it cannot become the configuration.
 *
 * A missing or unreadable file waives nothing.
 */
export function hasAck(channel: Channel, projectDir: string, now = Date.now()): boolean {
  try {
    const path = resolve(projectDir, ".claude", ACK_FILE[channel]);
    return now - statSync(path).mtimeMs < ACK_WINDOW_MS;
  } catch {
    return false;
  }
}

const CHANNEL_LABEL: Record<Channel, string> = {
  docs: "This file",
  github: "This commit message, PR or issue body",
  issue: "This issue title or body",
};

const ACK_FILE: Record<Channel, string> = {
  docs: ".docs-plain-english-ack",
  github: ".github-plain-english-ack",
  issue: ".issue-plain-english-ack",
};

export function formatReason(errors: Finding[], channel: Channel): string {
  const shown = errors.slice(0, 5);
  const lines = shown.map((f) => {
    const hint = f.message ? ` ${f.message}` : "";
    return `  line ${f.line}: ${JSON.stringify(f.match)} (${f.ruleId})${hint}`;
  });
  const more = errors.length > shown.length ? `\n  ...and ${errors.length - shown.length} more` : "";

  return [
    `${CHANNEL_LABEL[channel]} contains writing that reads as machine-generated:`,
    "",
    lines.join("\n") + more,
    "",
    "Rewrite the quoted text in plain, direct language.",
    "Full ruleset: docs/writing-style.md",
    "",
    "Narrower ways to allow this, in order of preference:",
    "  1. <!-- plain-english-disable-next-line " + (shown[0]?.ruleId ?? "rule-id") + " -->",
    "  2. add the path to `exclude` in .plain-english.yml",
    "  3. lower the rule to `severity: warn` in .plain-english.yml",
    "",
    `Last resort, and the human's call, not yours: touch .claude/${ACK_FILE[channel]}`,
    `  It waives this channel for ${ACK_WINDOW_MS / 60000} minutes, then expires on its own.`,
  ].join("\n");
}

/**
 * The PreToolUse JSON Claude Code expects on stdout.
 *
 * `permissionDecision` accepts allow, ask, deny and defer. Emitting nothing
 * leaves the normal permission flow in charge, which is what an allow means
 * here.
 */
export function toHookOutput(decision: Decision): string {
  if (decision.allow) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  });
}
