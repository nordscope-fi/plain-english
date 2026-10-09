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

import { lintText, type Finding } from "../lint.ts";
import type { RuleSet } from "../rules.ts";
import type { ChatReader, Reply } from "../chat/reader.ts";
import { CHAT_JUDGE_CALL_MS } from "../chat/budget.ts";
import type { CheckerIo } from "../io.ts";
import { nodeIo } from "../node-io.ts";
import { sha256 } from "../sha256.ts";
import { nativeJudgeResult, type JudgeMeasurement } from "./judge-measurement.ts";
import { startJudgeReceipt } from "./judge-receipts.ts";
import { spawnJudge } from "./judge-spawn.ts";

type Env = Readonly<Record<string, string | undefined>>;

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
export const JUDGE_TIMEOUT_MS = CHAT_JUDGE_CALL_MS;

/** Background checks cannot use tools or save a local conversation. */
export const CLAUDE_JUDGE_ARGS = [
  "-p", "--tools", "", "--disallowed-tools", "*", "--strict-mcp-config",
  "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json",
];

/** Vibe already requires explicit opt-in and limits each check's usage. */
export const VIBE_JUDGE_ARGS = [
  "--output", "text", "--max-turns", "1", "--disabled-tools", "*", "--max-price", "0.05", "-p",
];

/** Whether this process is itself a judge, and must not start another. */
export function isJudge(env: Env = nodeIo.env): boolean {
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
  io?: CheckerIo,
): string | undefined {
  for (const key of ["prompt", "user_message", "userMessage", "last_user_message"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  try {
    return reader?.lastAsk?.(payload, io);
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
  const native = nativeJudgeResult(stdout);
  if (native) {
    return native["is_error"] === true || typeof native["result"] !== "string"
      ? undefined : parseVerdict(native["result"]);
  }
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
  env?: Env;
  cwd?: string;
  /** Fixed diagnostic text only; never echo the submitted passage. */
  onUnavailable?: (reason: string) => void;
  /** Provider usage only, with missing measurements preserved as null. */
  onMeasurement?: (measurement: JudgeMeasurement) => void;
  /** Answers from the Claude Code mod, which asks the model itself (ADR-006). */
  answered?: ModAnswers;
}

/** One answer the mod got for a model request, keyed by `answerKey`. */
export interface ModAnswer {
  key: string;
  /** The model's reply. Absent when the mod got none. */
  text?: string;
  /** Why there is no reply, in `onUnavailable`'s words. */
  unavailable?: "timed out" | "failed";
  /** Token counts the mod reported, with `TOKEN_FIELDS` names. */
  usage?: Record<string, number>;
}

/**
 * The answers so far, and the deadline the first run fixed.
 *
 * The CLI replays the whole decision on every run, so an answer it has already
 * used comes back again. Only the newest answer is new to this run.
 */
export interface ModAnswers {
  answers: ModAnswer[];
  deadline?: number;
}

/** What the mod is asked to send, printed instead of a decision. */
export interface HostRequest {
  key: string;
  prompt: string;
  timeoutMs: number;
}

/**
 * Thrown when a question has no answer yet. `cmdHook` catches it before its
 * fail-open handler and prints the request. Nothing is written before a judge
 * is asked, so the run that throws leaves no state behind.
 */
export class ModelRequest extends Error {
  constructor(readonly request: HostRequest) {
    super("model answer needed");
  }
}

/** The key an answer is filed under: the whole filled prompt, hashed. */
export function answerKey(filled: string): string {
  return sha256(filled);
}

/** Read the mod's answers off a payload, or `undefined` when the route is off. */
export function hostRoute(payload: Record<string, unknown>, env: Env = nodeIo.env): ModAnswers | undefined {
  if (env["PLAIN_ENGLISH_MODEL_ROUTE"] !== "host") return undefined;
  const raw = payload["plainEnglishModel"];
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const answers = Array.isArray(record["answers"]) ? record["answers"].flatMap((item): ModAnswer[] => {
    if (typeof item !== "object" || item === null) return [];
    const answer = item as Record<string, unknown>;
    if (typeof answer["key"] !== "string") return [];
    const usage = typeof answer["usage"] === "object" && answer["usage"] !== null ? answer["usage"] as Record<string, number> : undefined;
    return [{
      key: answer["key"],
      ...(typeof answer["text"] === "string" ? { text: answer["text"] } : {}),
      ...(answer["unavailable"] === "timed out" ? { unavailable: "timed out" as const } : {}),
      ...(usage ? { usage } : {}),
    }];
  }) : [];
  const deadline = typeof record["deadline"] === "number" && Number.isFinite(record["deadline"]) ? record["deadline"] : undefined;
  return { answers, ...(deadline !== undefined ? { deadline } : {}) };
}

function answerFromMod(filled: string, opts: JudgeOptions, answered: ModAnswers): Verdict | undefined {
  const key = answerKey(filled);
  const index = answered.answers.findIndex((answer) => answer.key === key);
  if (index === -1) throw new ModelRequest({ key, prompt: filled, timeoutMs: opts.timeoutMs ?? JUDGE_TIMEOUT_MS });
  const answer = answered.answers[index]!;
  if (index === answered.answers.length - 1) {
    const measurement: JudgeMeasurement = {
      provider: "claude",
      outcome: answer.text !== undefined ? "complete" : answer.unavailable === "timed out" ? "timed_out" : "failed",
      reportedCostUsd: null,
      invoiceCostUsd: null,
      costBasis: "unknown",
      usage: answer.usage ?? null,
      modelUsage: null,
    };
    startJudgeReceipt(opts.env ?? nodeIo.env, "claude")(measurement);
    try { opts.onMeasurement?.(measurement); } catch { /* optional */ }
  }
  if (answer.text === undefined) {
    opts.onUnavailable?.(answer.unavailable ?? "failed");
    return undefined;
  }
  const verdict = parseVerdict(answer.text);
  if (!verdict) opts.onUnavailable?.("returned no usable answer");
  return verdict;
}

/**
 * Run one judge and return its verdict, or `undefined` to defer to the count.
 * With answers from the mod (ADR-006) it replays them; otherwise the CLI
 * starts the agent's print mode (`judge-spawn.ts`). The plugin's mod always
 * brings answers, and its build carries no way to start a program (ADR-008).
 */
export function runJudge(input: string, opts: JudgeOptions): Verdict | undefined {
  const env = opts.env ?? nodeIo.env;
  if (isJudge(env)) return undefined;
  if (!opts.prompt.includes("$ARGUMENTS")) return undefined;

  const filled = opts.prompt.replace("$ARGUMENTS", input);
  if (opts.answered) return answerFromMod(filled, opts, opts.answered);
  return spawnJudge(filled, opts, env);
}
