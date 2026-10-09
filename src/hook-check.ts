/**
 * One hook check, shared by the CLI's `hook` command and the Claude Code
 * plugin's mod (ADR-008).
 *
 * Everything outside the arguments comes through `io`: the CLI passes its
 * Node io, and the mod passes a replay of what it fetched. The agent's profile
 * and chat reader are passed in rather than looked up, so the mod's build
 * carries only Claude Code's. A model question with no answer yet throws
 * `ModelRequest` (ADR-006); the caller answers it and runs the check again.
 */
import { decide, extractFromBash, extractFromIssue, hasAck, projectDirFor, scopedDocsFiles, HOOK_BUDGET_MS, POST_BUDGET_MS, type Channel, type Decision } from "./adapters/hook.ts";
import { decideChat } from "./adapters/chat.ts";
import { isJudge, CLAUDE_JUDGE_ARGS, VIBE_JUDGE_ARGS, judgeInput, lastAsked, runJudge, usableReason, overDocsJudgeLimit, type ModAnswers } from "./adapters/judge.ts";
import type { AgentProfile, HookEvent, NormalisedEvent } from "./agents/profile.ts";
import { CHAT_JUDGE_PIPELINE_MS, DOCS_JUDGE_CALL_MS, nextJudgeTimeout } from "./chat/budget.ts";
import type { ChatReader } from "./chat/reader.ts";
import { chatTurnId } from "./chat/turn.ts";
import type { CheckerIo } from "./io.ts";
import { toPosix } from "./paths.ts";
import { renderPrompts } from "./render.ts";
import { chatRuleSet, compile, loadDefault, resolveRuleSet, type RuleSet } from "./rules.ts";

export const CONFIGURATION_UNAVAILABLE = "plain-english: configuration unavailable; using local built-in pattern checks as advice only.";

export interface HookCheck {
  channel: Channel;
  /** The event, without the mod's `plainEnglishModel` answers. */
  payload: Record<string, unknown>;
  profile: Pick<AgentProfile, "id" | "parse" | "emit" | "emitChat" | "advisoryPhase" | "supportsModelChecks">;
  /** The agent's chat reader, for the chat channel. */
  reader?: ChatReader;
  /** `post` runs after the tool did, so it can only tell the model something. */
  event?: HookEvent;
  /** The model the judge asks for, where the caller names one. */
  model?: string;
  /** The mod's answers so far (ADR-006). */
  answered?: ModAnswers;
  /** A project folder the caller already knows, for agents whose payload lacks one. */
  chatCwd?: string;
  io: CheckerIo;
}

export interface HookResult {
  stdout: string;
  exitCode: number;
  /** For the CLI's recorder: the normalised event and the decision, when a tool call was judged. */
  parsed?: NormalisedEvent;
  decision?: Decision;
}

/** The ruleset a hook judges by, resolved from the directory it fired in. */
export function ruleSetFor(cwd: string, io: CheckerIo): RuleSet {
  try {
    return resolveRuleSet(io.path.resolve(io.cwd, cwd), io);
  } catch {
    io.notice(CONFIGURATION_UNAVAILABLE);
    const fallback = compile(loadDefault(io));
    return { ...fallback, modelChecks: false, chat: { ...fallback.chat, failOn: "never" } };
  }
}

function modelChecksEnabled(ruleSet: RuleSet, profile: HookCheck["profile"], io: CheckerIo): boolean {
  if (profile.supportsModelChecks === false) return false;
  return ruleSet.modelChecks ?? (profile.id === "claude-code" ||
    (profile.id === "vibe" && io.env["PLAIN_ENGLISH_VIBE_JUDGE"] === "1"));
}

function modelCommand(agent: string, model?: string): { command: string; args: string[] } {
  return agent === "vibe"
    ? { command: "vibe", args: VIBE_JUDGE_ARGS }
    : { command: "claude", args: [...CLAUDE_JUDGE_ARGS, ...(model ? ["--model", model] : [])] };
}

export function hookCheck(check: HookCheck): HookResult {
  if (check.channel === "chat") return chatCheck(check);
  const { channel, payload, profile, io, answered } = check;
  const event: HookEvent = check.event ?? "pre";
  const env = io.env;
  const unavailable = (reason: string) => io.notice(`plain-english: extra model check ${reason}; pattern checks still apply.`);

  // The post event is not holding up a write, so the tight budget buys
  // nothing there but an incomplete scan.
  const budgetMs = event === "post" ? POST_BUDGET_MS : HOOK_BUDGET_MS;
  const parsed = profile.parse(payload);
  let decision = decide(parsed, channel, { budgetMs, alreadyApplied: event === "post", io });
  const projectDir = projectDirFor(parsed, undefined, io);
  const ruleSet = ruleSetFor(projectDir, io);
  // Send extracted prose, never the original tool call: a command or patch
  // can contain unrelated private text and excluded files.
  const requests: { channel: Channel; input: string }[] = [];
  if (channel === "docs" || (channel === "github" && parsed.tool === "bash")) {
    const files = scopedDocsFiles(parsed, ruleSet, undefined, { alreadyApplied: event === "post", io }).filter((file) =>
      file.text.trim() && !["CLAUDE.md", "writing-style.md"].includes(io.path.basename(file.path)));
    if (files.length) requests.push({
      channel: "docs",
      input: JSON.stringify({ files: files.map((file) => ({
        ...file,
        path: toPosix(io.path.relative(io.path.resolve(io.cwd, projectDir), io.path.resolve(io.cwd, file.path))),
      })) }),
    });
  }
  const texts = channel === "github" && parsed.tool === "bash"
    ? extractFromBash(String(parsed.input["command"] ?? ""), parsed.cwd || projectDir, io)
    : channel === "issue" ? extractFromIssue(parsed.input) : [];
  if (texts.length) requests.push({ channel, input: JSON.stringify({ texts }) });

  // Optional semantic checks share one deadline and the same runtime choices
  // as the deterministic pass. Installed prompt hooks cannot enforce those
  // choices before disclosing their input, so the checker owns every model call.
  const semanticPhase = ruleSet.failOn === "never" ? (profile.advisoryPhase ?? "pre") : "pre";
  if (event === semanticPhase && decision.allow && !isJudge(env) && modelChecksEnabled(ruleSet, profile, io)) {
    const deadline = answered?.deadline ?? io.now() + DOCS_JUDGE_CALL_MS;
    if (answered) answered.deadline = deadline;
    for (const request of requests) {
      if (hasAck(request.channel, projectDir, undefined, io) || overDocsJudgeLimit(request.input)) continue;
      const timeoutMs = Math.max(0, deadline - io.now());
      if (timeoutMs === 0) break;
      const prompt = renderPrompts(ruleSet, "prose")[request.channel];
      if (!prompt) continue;
      const verdict = runJudge(request.input, {
        prompt,
        ...modelCommand(profile.id, check.model),
        cwd: io.path.resolve(io.cwd, projectDir),
        timeoutMs,
        env,
        onUnavailable: unavailable,
        ...(answered ? { answered } : {}),
      });
      if (verdict && !verdict.ok && verdict.reason && usableReason(verdict.reason, ruleSet)) {
        decision = {
          ...decision,
          allow: event === "post",
          decision: event === "post" ? "allow" : ruleSet.failOn === "never" ? "ask" : "deny",
          reason: verdict.reason,
          advisory: verdict.reason,
        };
        break;
      }
    }
  }

  const out = profile.emit(decision, event);
  return { stdout: out.stdout, exitCode: out.exitCode, parsed, decision };
}

/**
 * The chat gate, on a stop event.
 *
 * Fails open in the strongest sense available here: an agent with no reader,
 * no `emitChat`, or a payload carrying no reply gets silence and exit 0. A
 * chat hook that refused a turn because it could not find the text would be
 * worse than no chat hook.
 */
function chatCheck(check: HookCheck): HookResult {
  const { payload, profile, reader, io, answered } = check;
  const silent = { stdout: "", exitCode: 0 };
  if (!profile.emitChat || !reader) return silent;
  const env = io.env;
  const unavailable = (reason: string) => io.notice(`plain-english: extra model check ${reason}; pattern checks still apply.`);

  const reply = reader.current(payload, io);
  if (!reply || !reply.text.trim()) return silent;

  const cwd = check.chatCwd ?? profile.parse(payload).cwd ??
    (typeof payload["cwd"] === "string" ? payload["cwd"] : io.cwd);
  const eventName = String(payload["hook_event_name"] ?? payload["hookEventName"] ?? "Stop");
  const ruleSet = ruleSetFor(cwd, io);
  const turn = chatTurnId(payload, reader, reply, cwd, undefined, io);
  const helper = payload["agent_id"] ?? payload["subagent_id"];
  // A helper may share the parent's turn id while producing its own reply.
  const promptId = helper ? `${turn}:helper:${String(helper)}` : turn;
  // One deadline covers both optional model calls. Giving each call its own
  // full timeout allowed the pipeline to outlive the host hook around it.
  const judgeDeadline = answered?.deadline ?? io.now() + CHAT_JUDGE_PIPELINE_MS;
  if (answered) answered.deadline = judgeDeadline;

  const decision = decideChat(reply, {
    ruleSet,
    /**
     * Consulted only when a reply limit is the only thing failing, which is
     * roughly one reply in ten. Everything about it fails towards the count,
     * so a machine with no `claude` on the PATH behaves exactly as this
     * package did before the judge existed.
     */
    judge: (r, findings) => {
      if (isJudge(env) || !modelChecksEnabled(ruleSet, profile, io)) return undefined;
      const prompts = renderPrompts(ruleSet);
      const input = judgeInput(r, lastAsked(payload, reader, io), findings);
      const run = (prompt: string) => {
        const timeoutMs = nextJudgeTimeout(judgeDeadline);
        if (timeoutMs === 0) return undefined;
        return runJudge(input, {
          prompt,
          ...modelCommand(profile.id),
          cwd: io.path.resolve(io.cwd, cwd),
          timeoutMs,
          env,
          onUnavailable: unavailable,
          ...(answered ? { answered } : {}),
        });
      };

      /**
       * Can this reply be read? Asked first, and asked on its own.
       *
       * Two questions in one prompt answer whichever the prompt was framed
       * around, and this one lost: measured 2026-08-20, the combined judge
       * passed an unreadable reply twice while the same check alone caught it
       * both times. So it runs first and its refusal is final. A reply nobody
       * can decode has no length worth earning, and no waiver rescues it.
       *
       * Only a refusal short-circuits. A pass falls through to the length
       * judge, which is the question that was always being asked here.
       */
      const readablePrompt = prompts["chat-readable"];
      if (readablePrompt) {
        const readable = run(readablePrompt);
        if (readable && !readable.ok && readable.reason) {
          if (usableReason(readable.reason, chatRuleSet(ruleSet))) return readable;
        }
      }

      const prompt = prompts["chat"];
      if (!prompt) return undefined;
      const verdict = run(prompt);
      // The reason is shown to the reader and sent back to the model, so it is
      // this package speaking and it is held to this package's rules. Caught
      // live on the first end-to-end run: the judge refused a reply and put an
      // em dash in the refusal. A linter that emits the thing it bans has
      // nothing to say. An unusable reason falls back to the count.
      if (verdict && !verdict.ok && verdict.reason && !usableReason(verdict.reason, chatRuleSet(ruleSet))) {
        return undefined;
      }
      return verdict;
    },
    projectDir: io.path.resolve(io.cwd, cwd),
    // Both Claude Code and Copilot document this, and it is the agent telling
    // you the current turn exists because a hook blocked the last one.
    stopHookActive: payload["stop_hook_active"] === true || payload["stopHookActive"] === true ||
      (profile.id === "cursor" && typeof payload["loop_count"] === "number" && payload["loop_count"] > 0),
    promptId,
    io,
  });

  const out = profile.emitChat(decision, eventName);
  return { stdout: out.stdout, exitCode: out.exitCode };
}
