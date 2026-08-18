/**
 * Judging a chat reply.
 *
 * Every other channel sits in front of a write and can refuse it. This one
 * sits on a stop event, after the words exist, and refusing means asking the
 * model to say them again differently. That is a weaker gate than a refused
 * write and a much stronger one than a prompt, which is all this channel had.
 *
 * Three things here are not in `decide`.
 *
 * The text arrives already extracted, from a `ChatReader`. A stop event has no
 * tool input to mine.
 *
 * `ask` has no meaning. There is no write to permit, so the advisory tier
 * becomes a message to the user and the strict tier becomes a block that sends
 * the findings back to the model.
 *
 * And blocking can loop. The model rewrites, the rewrite trips another rule,
 * and it blocks again. Everything in `shouldBlock` exists for that.
 */

import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintText, type Finding } from "../lint.ts";
import { chatRuleSet, resolveRuleSet, type RuleSet } from "../rules.ts";
import type { Reply } from "../chat/reader.ts";
import {
  ACK_WINDOW_MS,
  formatReason,
  hasAck,
  HOOK_BUDGET_MS,
  type Decision,
} from "./hook.ts";

/**
 * Where a turn's block is remembered.
 *
 * Deliberately the same shape as `ackPath`: repository root, one file, an
 * `mtime` that expires on its own. A second state mechanism with its own
 * lifetime would be state two code paths touch, and stale state that stops a
 * gate firing without saying so is this project's recurring failure.
 */
export function blockStatePath(projectDir: string, sessionId: string): string {
  // A session id is a uuid from the agent. Anything else is not going in a path.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
  return resolve(projectDir, `.plain-english-chat-${safe}`);
}

/** Whether this turn has already been blocked once. */
function alreadyBlocked(path: string, promptId: string, now: number): boolean {
  try {
    const stat = statSync(path);
    if (now - stat.mtimeMs > ACK_WINDOW_MS) return false;
    // The prompt id distinguishes turns within one session. Without it, one
    // block would silence the whole session for the ack window.
    return readPromptId(path) === promptId;
  } catch {
    return false;
  }
}

function readPromptId(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function rememberBlock(path: string, promptId: string): void {
  try {
    writeFileSync(path, promptId, "utf8");
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // A state file we cannot write means we might block twice. That is worse
    // than not blocking, so the caller treats a write failure as "do not block".
  }
}

export interface ChatDecisionOptions {
  projectDir: string;
  ruleSet?: RuleSet;
  budgetMs?: number;
  /**
   * The agent's own loop guard, where it has one.
   *
   * Claude Code and Copilot both document `stop_hook_active`, set when the
   * current turn is already the result of a hook blocking. Honouring it is not
   * optional: it is the mechanism the agent gives you to avoid an infinite
   * loop, and ignoring it means building your own worse one.
   */
  stopHookActive?: boolean;
  /** Distinguishes turns within a session, so a block is once per turn. */
  promptId?: string;
  now?: number;
  /**
   * Second opinion on the reply limits, and only on those.
   *
   * `reply-length` and `reader-load` are counts, and a count cannot tell a wall
   * of text from a walkthrough the reader asked for. When the only thing
   * failing is a count, this is consulted and may waive it. Returning
   * `undefined`, or not supplying it at all, leaves the count in charge.
   *
   * Injected rather than called directly so the decision stays a pure function
   * and the tests never shell out to a model.
   */
  judge?: (reply: Reply, findings: Finding[]) => { ok: boolean; reason?: string } | undefined;
}

/**
 * The rules a judge may waive.
 *
 * Deliberately a closed list. Every other rule is a fact about the text that no
 * amount of context makes acceptable: an em dash is an em dash. These two are
 * measurements whose meaning depends on what was asked.
 */
const JUDGEABLE = new Set(["reply-length", "reader-load"]);

/**
 * What to do about one reply.
 *
 * Mirrors `decide`: allow with findings when there is nothing at the failing
 * tier, allow when a `touch`ed ack waives the channel, and otherwise refuse.
 */
export function decideChat(reply: Reply, opts: ChatDecisionOptions): Decision {
  const now = opts.now ?? Date.now();
  const base = opts.ruleSet ?? resolveRuleSet(opts.projectDir);
  const ruleSet = chatRuleSet(base);

  const text = reply.text.trim();
  if (!text) return { allow: true, decision: "allow", findings: [] };

  const res = lintText(text, ruleSet, {
    // A reply carries no waivers, and one that quotes the directive syntax is
    // not writing one.
    allowInlineSuppression: false,
    budgetMs: opts.budgetMs ?? HOOK_BUDGET_MS,
  });
  const findings = res.findings;
  const timedOut = res.timedOut.length ? { timedOut: [...res.timedOut].sort() } : {};

  // The chat channel decides its own tier. `failOn` at the top of a config is
  // about whether a lint run fails a build, and a reply has no build to fail.
  const tier = base.chat?.failOn ?? ruleSet.failOn;
  const failing = tier === "warn" ? findings : findings.filter((f) => f.severity === "error");
  if (!failing.length) return { allow: true, decision: "allow", findings, ...timedOut };

  if (hasAck("chat", opts.projectDir, now)) {
    return { allow: true, decision: "allow", findings, ...timedOut };
  }

  // The cheap check has fired and it is the only thing that has. Ask before
  // refusing, because the counts are the two rules that can be wrong about a
  // reply the reader wanted. Anything else failing skips this entirely, which
  // is what keeps the model call on roughly one reply in ten rather than all
  // of them.
  if (opts.judge && failing.every((f) => JUDGEABLE.has(f.ruleId))) {
    const verdict = opts.judge(reply, failing);
    if (verdict?.ok) {
      return { allow: true, decision: "allow", findings, ...timedOut };
    }
    if (verdict && verdict.reason) {
      // The judge said what the reply should have led with. That is more use
      // than "over 250 words", so it replaces the count in the message.
      const reason = verdict.reason;
      if (!shouldBlock(opts, now)) {
        return { allow: true, decision: "ask", reason, advisory: reason, findings, ...timedOut };
      }
      return { allow: false, decision: "deny", reason, advisory: reason, findings, ...timedOut };
    }
    // No verdict at all: the judge timed out, failed to start, or answered
    // something unreadable. Fall through to the count, which is the answer
    // this package had before the judge existed.
  }

  const reason = formatReason(failing, "chat", "This reply");

  // Advisory tier. Nothing is refused, and the user is told. On this channel
  // there is no write to hold up, so the default costs a line of output and
  // never a turn.
  if (tier === "never") {
    return { allow: true, decision: "ask", reason, advisory: reason, findings, ...timedOut };
  }

  if (!shouldBlock(opts, now)) {
    // Already blocked this turn, or the agent says this turn exists because we
    // blocked the last one. Say it once more as advice and let the turn end.
    return { allow: true, decision: "ask", reason, advisory: reason, findings, ...timedOut };
  }

  return { allow: false, decision: "deny", reason, advisory: reason, findings, ...timedOut };
}

/**
 * Whether blocking is safe, and record it when it is.
 *
 * Two guards, both required. A blocked turn produces a new reply, which can
 * trip a different rule, which blocks again: without a stop condition that is
 * a model rewriting forever and a person watching it.
 */
function shouldBlock(opts: ChatDecisionOptions, now: number): boolean {
  if (opts.stopHookActive) return false;
  const promptId = opts.promptId ?? "";
  const path = blockStatePath(opts.projectDir, promptId ? promptId : "session");
  if (alreadyBlocked(path, promptId, now)) return false;
  rememberBlock(path, promptId);
  return true;
}

/** Exported for the report, which counts findings by tier. */
export function tierOf(findings: Finding[]): { errors: number; warns: number } {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warns: findings.filter((f) => f.severity === "warn").length,
  };
}
