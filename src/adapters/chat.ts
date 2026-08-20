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

import { readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
 * The temporary directory, not the repository. 0.12.0 put it in the project
 * root, beside the ack file, on the reasoning that one expiring-`mtime`
 * mechanism is better than two. That was wrong about where, and the difference
 * is who writes it. The ack file is touched by a person and belongs where they
 * can see it. This one is written by the gate, read by the gate, and never
 * looked at, so in a working tree it is litter: one file per session, nothing
 * deleting them, nothing ignoring them. One repository collected fourteen in an
 * afternoon, and any `git add -A` would have committed them.
 *
 * Losing the file is safe. It means "not blocked yet", and `stop_hook_active`
 * is the real loop guard either way.
 *
 * The project directory is part of the name so two checkouts of the same
 * repository, or two repositories in one session, cannot share a turn's state.
 */
export function blockStatePath(projectDir: string, sessionId: string): string {
  // A session id is a uuid from the agent. Anything else is not going in a path.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
  const scope = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 12);
  return resolve(tmpdir(), `plain-english-chat-${scope}-${safe}`);
}

/**
 * Remove the state files 0.12.0 left in a working tree.
 *
 * Called by `init`, which is already writing to this repository and is the one
 * moment the package has permission to tidy. Named by our own marker, so
 * nothing else can match.
 */
export function sweepLegacyState(projectDir: string): string[] {
  const removed: string[] = [];
  try {
    for (const name of readdirSync(projectDir)) {
      if (!name.startsWith(".plain-english-chat-")) continue;
      try {
        unlinkSync(resolve(projectDir, name));
        removed.push(name);
      } catch {
        // A file we cannot delete is not worth failing an install over.
      }
    }
  } catch {
    // An unreadable directory means nothing to sweep.
  }
  return removed;
}

/**
 * What a turn's earlier block was about.
 *
 * Two fields, because "blocked already" is no longer the whole question. A
 * block that asked for a substitution and a block that asked for a rewrite
 * leave the turn in different places, and only one of them is worth a second
 * look. The file is two lines: the prompt id, then the kind.
 *
 * `null` means no usable state: no file, an unreadable one, or one older than
 * the ack window. All three mean "not blocked yet", which is the safe answer.
 */
type BlockKind = "punctuation" | "clarity" | "final";

interface BlockState {
  promptId: string;
  kind: BlockKind;
}

function readBlockState(path: string, now: number): BlockState | null {
  try {
    const stat = statSync(path);
    if (now - stat.mtimeMs > ACK_WINDOW_MS) return null;
    const [id = "", kind = ""] = readFileSync(path, "utf8").split("\n");
    return {
      promptId: id.trim(),
      // A file written before 0.14.0 holds the prompt id alone. Reading that
      // as a rewrite request is the old behaviour, which is the safe default.
      kind: kind.trim() === "punctuation" ? "punctuation" : kind.trim() === "final" ? "final" : "clarity",
    };
  } catch {
    return null;
  }
}

function rememberBlock(path: string, promptId: string, kind: BlockKind): void {
  try {
    writeFileSync(path, `${promptId}\n${kind}`, "utf8");
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // A state file we cannot write means we might block twice. That is worse
    // than not blocking, so the caller treats a write failure as "do not block".
  }
}

/**
 * Rules a rewrite can satisfy without rethinking the reply.
 *
 * A dash becomes a comma and everything else about the reply is unchanged, so
 * the text that comes back has never been judged on whether anyone could
 * follow it. Measured over the three days to 2026-08-19: of 69 blocks, 38 said
 * nothing but this.
 */
const SUBSTITUTION_ONLY = new Set(["em-dash", "em-dash-density", "en-dash-as-punctuation"]);

function punctuationOnly(findings: Finding[]): boolean {
  return findings.length > 0 && findings.every((f) => SUBSTITUTION_ONLY.has(f.ruleId));
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
const JUDGEABLE = new Set(["reply-length", "reader-load", "reply-pace"]);

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
      if (!shouldBlock(opts, now, failing)) {
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

  if (!shouldBlock(opts, now, failing)) {
    // Already blocked this turn, or the agent says this turn exists because we
    // blocked the last one. Say it once more as advice and let the turn end.
    return { allow: true, decision: "ask", reason, advisory: reason, findings, ...timedOut };
  }

  return { allow: false, decision: "deny", reason, advisory: reason, findings, ...timedOut };
}

/**
 * Whether blocking is safe, and record it when it is.
 *
 * The stop condition is what everything here is for. A blocked turn produces a
 * new reply, which can trip a different rule, which blocks again: without a
 * bound that is a model rewriting forever and a person watching it.
 *
 * One block a turn was that bound until 0.14.0, and it was too tight in one
 * direction. A block that only ever said "no em dashes" spends the turn on a
 * find-and-replace, and the reply that comes back is the same reply with
 * different characters. So the bound is now two, and the second is available
 * only when the first asked for a substitution and the rewrite turned out to
 * be unreadable. A dash followed by another dash gets nothing, and neither
 * does a clarity block followed by anything.
 */
function shouldBlock(opts: ChatDecisionOptions, now: number, failing: Finding[]): boolean {
  const promptId = opts.promptId ?? "";
  const path = blockStatePath(opts.projectDir, promptId ? promptId : "session");
  const prior = readBlockState(path, now);
  const kind: BlockKind = punctuationOnly(failing) ? "punctuation" : "clarity";

  const sameTurn = prior !== null && prior.promptId === promptId;
  const retry = sameTurn && prior.kind === "punctuation" && kind === "clarity";

  // `stop_hook_active` is the agent telling you this turn exists because you
  // blocked the last one. Honouring it is not optional, and the one exception
  // is the retry, which is bounded and records `final` so there is no third.
  if (opts.stopHookActive && !retry) return false;
  if (sameTurn && !retry) return false;

  rememberBlock(path, promptId, retry ? "final" : kind);
  return true;
}

/** Exported for the report, which counts findings by tier. */
export function tierOf(findings: Finding[]): { errors: number; warns: number } {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warns: findings.filter((f) => f.severity === "warn").length,
  };
}
