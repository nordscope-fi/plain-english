/**
 * The chat judge.
 *
 * `reply-length` and `reader-load` are counts, and a count cannot tell a wall
 * of text from a walkthrough the reader asked for. Measured over seven days of
 * transcripts on 2026-08-18, the two together fire on roughly one reply in ten,
 * so getting that difference wrong is the whole cost of the rules.
 *
 * This shells out to the agent's own print mode rather than adding a model
 * client. Same shape as the Vibe judge in `src/agents/vibe.ts`, and for the
 * same reason: the machine already has a working, authenticated model on the
 * PATH, and a second way to reach one is a second thing to configure and to
 * leak credentials through.
 *
 * Everything here fails towards the count. A judge that cannot start, cannot
 * finish in time, or answers with something unreadable returns `undefined`,
 * and `decideChat` then uses the number it already had. A gate that opens
 * because a subprocess died is the failure this package keeps finding in other
 * people's tools.
 */

import { spawnSync } from "node:child_process";
import { lintText, type Finding } from "../lint.ts";
import type { RuleSet } from "../rules.ts";
import type { ChatReader, Reply } from "../chat/reader.ts";

export interface Verdict {
  ok: boolean;
  reason?: string;
}

/**
 * Set in the child's environment so a judge cannot start a judge.
 *
 * The subprocess runs in the same directory and reads the same settings, so
 * without this its own Stop hook would run, measure its own reply, and start
 * another. This exact recursion was live in the Vibe judge and survived only
 * because the tools were disabled there.
 */
export const JUDGE_MARKER = "PLAIN_ENGLISH_CHAT_JUDGE";

/** How long the judge may take before the count wins by default. */
export const JUDGE_TIMEOUT_MS = 25_000;

/** Whether this process is itself a judge, and must not start another. */
export function isJudge(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JUDGE_MARKER] === "1";
}

/**
 * What the reader last asked.
 *
 * The payload first, because an agent that sends the question is telling you
 * the truth about the turn it is ending. Claude Code sends the reply and not
 * the question, so the transcript is the fallback rather than the exception:
 * measured over three days on 2026-08-19, 32 of 39 judge calls had nothing
 * from the payload and ran on "(not available)".
 */
export function lastAsked(
  payload: Record<string, unknown>,
  reader?: { lastAsk?: ChatReader["lastAsk"] },
): string | undefined {
  for (const key of ["prompt", "user_message", "userMessage", "last_user_message"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  try {
    return reader?.lastAsk?.(payload);
  } catch {
    // A transcript we cannot parse means the judge works from the reply alone,
    // which is what it did before this existed.
    return undefined;
  }
}

/**
 * What the judge is shown.
 *
 * The reader's last message is not decoration. Every exception in the ruleset
 * ("the reader asked you to explain", "the options are the answer") is a fact
 * about the question, not about the reply, so a judge without it is being
 * asked to guess.
 */
export function judgeInput(reply: Reply, ask: string | undefined, findings: Finding[]): string {
  return [
    "What the reader last said:",
    (ask ?? "(not available)").slice(0, 4000),
    "",
    "What the linter measured:",
    ...findings.map((f) => `- ${f.ruleId}: ${f.message ?? ""}`.trimEnd()),
    "",
    "The reply:",
    reply.text.slice(0, 20_000),
  ].join("\n");
}

/**
 * Above this, a docs write skips the semantic judge entirely and the
 * deterministic pass is the whole gate.
 *
 * The docs semantic gate used to be a harness `prompt` hook: the runner built
 * the payload from the whole file and sent it to a model before any package
 * code ran, so a large file failed with `Prompt is too long` and the write
 * surfaced as a permission prompt. The command hook reads the payload first, so
 * it can decline the model call instead. Named and sized to match
 * `MAX_COMMAND_BYTES` in `hook.ts`, and compared the same way, against
 * `.length`. A payload under this is well within the model's context, so a
 * single threshold is the whole guard: no truncation, judged or skipped whole.
 */
export const DOCS_MAX_JUDGE_BYTES = 256 * 1024;

/** Whether a docs payload is too large to judge, and passes on its size alone. */
export function overDocsJudgeLimit(payload: string): boolean {
  return payload.length > DOCS_MAX_JUDGE_BYTES;
}

/**
 * Read a verdict out of whatever the model wrote.
 *
 * Deliberately strict about the failure case and forgiving about the shape.
 * Anything that is not a clear pass or a clear refusal returns `undefined`,
 * which hands the decision back to the count rather than inventing one.
 */
export function parseVerdict(stdout: string): Verdict | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  // The model is asked for bare JSON and usually sends it. A fenced block or a
  // sentence in front of it is not worth losing a verdict over.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const ok = (body as Record<string, unknown>)["ok"];
  if (typeof ok !== "boolean") return undefined;
  if (ok) return { ok: true };
  const reason = (body as Record<string, unknown>)["reason"];
  // A refusal with no reason is worse than no refusal: it holds the turn and
  // says nothing about what to do differently. Fall back to the count.
  if (typeof reason !== "string" || !reason.trim()) return undefined;
  return { ok: false, reason: reason.trim() };
}

/**
 * Whether a refusal is fit to send.
 *
 * The reason is shown to the reader and goes back to the model, so it is this
 * package speaking and it is held to this package's rules. Caught live on the
 * first end-to-end run: the judge refused a reply and put an em dash in the
 * refusal. A linter that emits the thing it bans has nothing to say.
 *
 * Only blocking findings disqualify a reason. A warning in a sentence that is
 * otherwise the most useful thing the reader will see is not worth trading for
 * a bare word count.
 */
export function usableReason(reason: string, ruleSet: RuleSet): boolean {
  return lintText(reason, ruleSet, { allowInlineSuppression: false }).errorCount === 0;
}

export interface JudgeOptions {
  /** The rendered `chat` prompt, with `$ARGUMENTS` still in it. */
  prompt: string;
  /** Executable to run in print mode. */
  command: string;
  /** Arguments before the prompt. */
  args: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Run one judge and return its verdict, or `undefined` to defer to the count. */
export function runJudge(input: string, opts: JudgeOptions): Verdict | undefined {
  const env = opts.env ?? process.env;
  if (isJudge(env)) return undefined;
  if (!opts.prompt.includes("$ARGUMENTS")) return undefined;

  const filled = opts.prompt.replace("$ARGUMENTS", input);
  let out;
  try {
    out = spawnSync(opts.command, [...opts.args, filled], {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? JUDGE_TIMEOUT_MS,
      cwd: opts.cwd,
      env: { ...env, [JUDGE_MARKER]: "1" },
      // A judge that inherits stdin can block on it forever.
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  if (out.error || out.status !== 0) return undefined;
  return parseVerdict(out.stdout ?? "");
}
