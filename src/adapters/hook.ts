/**
 * Deciding whether a pending tool call may write what it is about to write.
 *
 * Nothing in this file knows which agent asked. A profile in `src/agents/`
 * translates that agent's payload into a `NormalisedEvent` on the way in, and
 * translates the `Decision` below into that agent's wire format on the way out.
 * What is left in between is the part worth sharing, and it is most of it.
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
import { asRecord, pick, pickArray } from "../agents/fields.ts";
import type { NormalisedEvent } from "../agents/profile.ts";

export type Channel = "docs" | "github" | "issue";

export const CHANNELS: readonly Channel[] = ["docs", "github", "issue"];

export function isChannel(v: string): v is Channel {
  return (CHANNELS as readonly string[]).includes(v);
}

/** A payload as it arrived, before a profile has made sense of it. */
export type RawPayload = Record<string, unknown>;

/**
 * What the hook asks the agent to do.
 *
 *   allow  nothing to report
 *   ask    surface to the human and let them decide
 *   deny   refuse the write outright
 *
 * `deny` overrides an agent's skip-permissions mode, so a denied write has no
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
 * Agents kill a hook somewhere between ten and thirty seconds. Well under all
 * of them on purpose: a write stalled for several seconds is a worse outcome
 * than a banned term reaching a document that a human is about to read anyway.
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

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/**
 * Heredoc terminators, which is how multi-line commit messages usually arrive.
 *
 * The whitespace before the back-reference is `[ \t]*` and must stay that way.
 * It was `\s*`, which overlaps the lazy `[\s\S]*?` in front of it, and an
 * unterminated heredoc whose body is blank lines then backtracks quadratically:
 * measured at 3.1s for 50KB, 12.5s for 100KB, 49.7s for 200KB and 200s for
 * 400KB. Nothing bounded it. `HOOK_BUDGET_MS` is passed to `lintText` and
 * covers no part of extraction, and `findUnsafe` screens patterns that arrive
 * from configuration, not the ones written here. So a malformed heredoc in a
 * commit message hung the hook, and the hook holds up the agent's write.
 *
 * Nothing is lost by narrowing it: a heredoc terminator may be indented with
 * tabs, and only under `<<-`.
 */
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2\b/g;

/**
 * Every pattern this module matches against agent-supplied text.
 *
 * Exported so a test can put them through `findUnsafe`, the same screen a
 * pattern from a project's config gets. Nothing screened these until a hand-
 * written one in `heredocBodies` turned out to backtrack quadratically, and a
 * regex is no safer for having been written here rather than in a YAML file.
 */
export const COMMAND_PATTERNS: Record<string, RegExp> = {
  WRITE_COMMAND,
  FILE_FLAG,
  INLINE_FLAG,
  HEREDOC,
  MARKDOWN,
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** The text inside each heredoc in a command. */
function heredocBodies(cmd: string): string[] {
  const out: string[] = [];
  const re = new RegExp(HEREDOC.source, HEREDOC.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (m[3]) out.push(m[3]);
  }
  return out;
}

/**
 * Longest command string worth reading.
 *
 * A payload is one tool call. Past this it is not a commit message, and the
 * cost of being wrong is a linear scan of something enormous while the agent
 * waits. The second line of defence behind the regex fix above, because the
 * next hand-written pattern here gets no screen either.
 */
export const MAX_COMMAND_BYTES = 256 * 1024;

/**
 * The text a Bash command would publish. Returns an empty array for read-only
 * commands so `gh pr view` never gets judged on somebody else's prose.
 */
export function extractFromBash(cmd: string): string[] {
  if (cmd.length > MAX_COMMAND_BYTES) return [];
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

/** One file's worth of about-to-be-written text. */
export interface FileText {
  path: string;
  text: string;
}

/**
 * The files a write-shaped call would change, and the text going into each.
 *
 * Keeping them paired is what lets a patch touching both a README and a source
 * file have only the README judged.
 */
export function extractFromFileWrite(event: NormalisedEvent): FileText[] {
  const input = event.input;
  const path = pick(input, "filePath");

  switch (event.tool) {
    case "write":
      return [{ path, text: pick(input, "content") }];
    case "edit":
      // Only the inserted side.
      return [{ path, text: pick(input, "newString") }];
    case "multi-edit":
      return pickArray(input, "edits").map((e) => ({
        path,
        text: pick(asRecord(e), "newString"),
      }));
    case "patch":
      return pickArray(input, "files").map((f) => {
        const entry = asRecord(f);
        return { path: pick(entry, "path"), text: pick(entry, "text") };
      });
    default:
      return [];
  }
}

/** The text a Linear-style issue call would show a reader. */
export function extractFromIssue(input: Record<string, unknown>): string[] {
  const parts = [pick(input, "title"), pick(input, "description"), pick(input, "body")];
  for (const p of pickArray(input, "patch")) {
    const entry = asRecord(p);
    // newString / text only. The removed side is text on its way out.
    parts.push(pick(entry, "newString"), pick(entry, "text"));
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
 * Where the repository is.
 *
 * `CLAUDE_PROJECT_DIR` is the only one of these an agent sets today, so the
 * payload's own `cwd` is the portable answer and the fallback is the process's.
 * Without any of them every markdown file the session touches anywhere on disk
 * would be judged, including other repositories.
 */
export function projectDirFor(event: NormalisedEvent, explicit?: string): string {
  return explicit || process.env["CLAUDE_PROJECT_DIR"] || event.cwd || process.cwd();
}

/**
 * Decide on one normalised tool call.
 *
 * The channel says which kind of text is arriving, and is fixed by whichever
 * hook entry invoked us rather than inferred from the payload.
 */
export function decide(
  event: NormalisedEvent,
  channel: Channel,
  opts: { projectDir?: string; ruleSet?: RuleSet } = {},
): Decision {
  const projectDir = projectDirFor(event, opts.projectDir);
  const allow = (): Decision => ({ allow: true, decision: "allow", findings: [] });

  let files: FileText[] = [];
  let texts: string[] = [];

  if (channel === "docs") {
    files = extractFromFileWrite(event).filter(
      (f) =>
        f.path !== "" &&
        MARKDOWN.test(f.path) &&
        (!isAbsolute(f.path) || isUnderProject(f.path, projectDir)),
    );
    if (!files.length) return allow();
  } else if (channel === "github") {
    if (event.tool !== "bash") return allow();
    texts = extractFromBash(pick(event.input, "command"));
  } else {
    texts = extractFromIssue(event.input);
  }

  const ruleSet = opts.ruleSet ?? resolveRuleSet(projectDir);

  // A file the project has excluded is never judged, whichever channel it
  // arrives through.
  if (files.length) {
    const base = resolve(projectDir);
    files = files.filter((f) => {
      const abs = resolve(base, f.path);
      const rel = abs.startsWith(base + sep) ? abs.slice(base.length + 1) : f.path;
      return !matchesAny(rel, ruleSet.exclude);
    });
    texts = files.map((f) => f.text);
  }

  texts = texts.filter((t) => t.trim() !== "");
  if (!texts.length) return allow();

  const findings: Finding[] = [];
  const stalled = new Set<string>();
  for (const text of texts) {
    // A hook payload is one edit, so the budget is tighter than the CLI's: an
    // agent kills the hook well before a minute, and a write held up for even a
    // few seconds is worse than a term slipping through. Fail-open on exhaustion.
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
  if (hasAck(channel, projectDir)) {
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
 * Where the hatch lives now.
 *
 * At the repository root, not inside a directory, because the message tells a
 * human to `touch` it and `touch` will not create a missing parent. The old
 * path worked only because Claude Code had already made `.claude/`; an agent
 * that keeps no directory would have made the advice impossible to follow.
 */
export function ackPath(channel: Channel, projectDir: string): string {
  return resolve(projectDir, `.plain-english-ack-${channel}`);
}

/**
 * The pre-0.4.0 location, still honoured.
 *
 * Somebody who learned the old path from a refusal message should not find it
 * has stopped working because the tool grew support for another agent.
 */
function legacyAckPath(channel: Channel, projectDir: string): string {
  return resolve(projectDir, ".claude", `.${channel}-plain-english-ack`);
}

/**
 * True when the human has waived this channel recently.
 *
 * It expires on purpose. A permanent file is one somebody creates during a
 * deadline and never removes, which turns the whole check off without a record.
 * Ten minutes is long enough to land the write in front of you and short enough
 * that it cannot become the configuration.
 *
 * A missing or unreadable file waives nothing.
 */
export function hasAck(channel: Channel, projectDir: string, now = Date.now()): boolean {
  for (const path of [ackPath(channel, projectDir), legacyAckPath(channel, projectDir)]) {
    try {
      if (now - statSync(path).mtimeMs < ACK_WINDOW_MS) return true;
    } catch {
      /* absent or unreadable waives nothing */
    }
  }
  return false;
}

const CHANNEL_LABEL: Record<Channel, string> = {
  docs: "This file",
  github: "This commit message, PR or issue body",
  issue: "This issue title or body",
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
    `Last resort, and the human's call, not yours: touch .plain-english-ack-${channel}`,
    `  It waives this channel for ${ACK_WINDOW_MS / 60000} minutes, then expires on its own.`,
  ].join("\n");
}
