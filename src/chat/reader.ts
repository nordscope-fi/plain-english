/**
 * Reading what an agent actually said.
 *
 * Every other channel in this package sits in front of a write. This one sits
 * behind a reply, for a reason worth stating: until recently a chat reply was
 * genuinely unreachable, and the documentation said so. Three of the four
 * agents now carry the final assistant message on a stop event, and all four
 * write their sessions to local disk.
 *
 * So a reader answers two questions with one body of knowledge:
 *
 *   read()     every reply this agent has made, for `lint --chat`
 *   current()  the one reply a stop event is about, for `hook chat`
 *
 * They are one interface on purpose. Copilot's `Stop` does not carry the reply
 * and Codex's is documented as possibly incomplete, so both have to fall back
 * to the transcript to answer a stop event. Building the hook and the scan
 * apart would give this package two ways to find the same text, which is the
 * shape `docs/design-rationale.md` says four agents cost one linter to avoid.
 *
 * Format evidence, per `docs/verifying-an-adapter.md`, is recorded on each
 * reader. None of it is guesswork from vendor prose alone: every location was
 * read off a live store, and every location was then checked against the
 * vendor's documentation, which is how the Cursor reader stopped pointing at
 * the wrong file.
 */

import { readFileSync } from "node:fs";

/** One thing an agent said, in the chat window. */
export interface Reply {
  /** Markdown, exactly as it was shown. */
  text: string;
  /**
   * Whether a subagent said it.
   *
   * The reason this field exists: an output style never reaches a subagent, so
   * a single number across both hides the one gap the style cannot close.
   * False where the agent has no such concept.
   */
  isSubagent: boolean;
  /** Session id, for the report. */
  session: string;
  /** Absolute path to the store, so a finding names something openable. */
  source: string;
  /** Line in that file, or the turn index for a store that has no lines. */
  line: number;
  /** ISO 8601, where the store carries one. */
  at?: string;
}

export interface ReadOptions {
  /**
   * Restrict to replies made in this working directory.
   *
   * The default scope is one repository, because a linter run inside a project
   * that reported on every project on the machine would be answering a
   * question nobody asked.
   */
  cwd?: string;
  /** How far back to look. */
  sinceDays?: number;
}

/**
 * Why a reader cannot run.
 *
 * Not a boolean. `docs/verifying-an-adapter.md` opens by naming the failure
 * this prevents: an adapter that reads nothing allows everything and looks
 * exactly like one that found nothing. A reader that cannot run has to say so
 * in words the caller can print.
 */
export type Availability = { ok: true } | { ok: false; why: string };

export interface ChatReader {
  /** Matches the agent profile id in `src/agents/`. */
  id: string;
  label: string;
  available(): Availability;
  read(options?: ReadOptions): Reply[];
  /**
   * The reply a stop event is about, or null when this agent has no such
   * event or the payload names nothing readable.
   */
  current(payload: Record<string, unknown>): Reply | null;
}

/** Read a string field, trying each name, since agents disagree on casing. */
export function field(payload: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = payload[name];
    if (typeof v === "string" && v.length) return v;
  }
  return undefined;
}

/**
 * Parse a JSONL file into records, skipping anything unparseable.
 *
 * A half-written last line is normal: these files are appended to by a running
 * process, so a reader that threw on one would fail against exactly the
 * session somebody is asking about.
 */
export function readJsonl(
  path: string,
  onRecord: (record: Record<string, unknown>, line: number) => void,
): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && typeof record === "object") {
      onRecord(record as Record<string, unknown>, i + 1);
    }
  }
}

/**
 * Path segments, on either separator.
 *
 * Windows `resolve` returns backslashes, so anything asking "is this directory
 * in the path" has to accept both. This repository has already shipped that
 * bug once, in an assertion that built a path by string suffix.
 */
export function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** Whether a path contains a directory with this name, at any depth. */
export function hasSegment(path: string, name: string): boolean {
  return segments(path).includes(name);
}

/** Whether a reply's directory is inside the requested one. */
export function inScope(replyCwd: string | undefined, wanted: string | undefined): boolean {
  if (!wanted) return true;
  if (!replyCwd) return false;
  const a = segments(replyCwd);
  const b = segments(wanted);
  if (b.length > a.length) return false;
  // Segment by segment rather than by string prefix, so `/work/repository` is
  // not read as inside `/work/repo`.
  return b.every((part, i) => a[i] === part);
}

/** Whether a timestamp is inside the window. */
export function withinDays(at: string | undefined, days: number | undefined, now: number): boolean {
  if (days === undefined) return true;
  if (!at) return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return true;
  return now - t <= days * 24 * 60 * 60 * 1000;
}
