/**
 * Time budgets for chat hooks and their optional semantic judges.
 *
 * A reply that trips a count can run two model calls: readability first, then
 * whether the length was earned. The complete pipeline must finish before the
 * host kills the Stop hook, or the host discards the decision and reports a
 * timeout to the reader.
 */

/** Most time one model call may take. */
export const CHAT_JUDGE_CALL_MS = 25_000;

/** Shared deadline for every model call made while judging one reply. */
export const CHAT_JUDGE_PIPELINE_MS = 45_000;

/** Host deadline, leaving 15 seconds for startup, output and shutdown. */
export const CHAT_HOOK_TIMEOUT_MS = 60_000;
export const CHAT_HOOK_TIMEOUT_SECONDS = CHAT_HOOK_TIMEOUT_MS / 1000;

/**
 * How much time the next judge may use without crossing the pipeline deadline.
 * Zero means skip the call and fall back to the deterministic result.
 */
export function nextJudgeTimeout(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.min(CHAT_JUDGE_CALL_MS, deadline - now));
}
