import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { claudeCodeChat } from "../src/chat/claude-code.ts";
import { codexChat } from "../src/chat/codex.ts";
import { cursorChat } from "../src/chat/cursor.ts";
import { copilotChat } from "../src/chat/copilot.ts";
import { READERS, readAll, readerFor, readerIds } from "../src/chat/registry.ts";
import { inScope, withinDays } from "../src/chat/reader.ts";
import { chatRuleSet, compile, loadDefault } from "../src/rules.ts";
import { decideChat, blockStatePath } from "../src/adapters/chat.ts";
import { decide } from "../src/adapters/hook.ts";
import { byId } from "../src/agents/registry.ts";
import { lintText } from "../src/lint.ts";

/**
 * Fixtures are hand-authored in each agent's real record shape, never copied
 * from a real session. A transcript holds whatever passed through a tool, so
 * committing one would put somebody's file contents in this repository.
 *
 * The shapes themselves were read off live stores and then checked against
 * each vendor's documentation. `docs/verifying-an-adapter.md` records which
 * claims came from which.
 */

let home: string;
const env: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in env)) env[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "plain-english-chat-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(env)) delete env[k];
});

function write(path: string, body: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("Claude Code transcripts", () => {
  const seed = (projectCwd = "/work/repo") => {
    setEnv("CLAUDE_CONFIG_DIR", home);
    const project = resolve(home, "projects", "-work-repo");
    write(
      resolve(project, "session-1.jsonl"),
      jsonl([
        { type: "user", message: { role: "user", content: "hi" }, cwd: projectCwd },
        {
          type: "assistant",
          isSidechain: false,
          sessionId: "session-1",
          cwd: projectCwd,
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "The main loop said this." }] },
        },
        {
          // Thinking and tool calls are not replies, and reading them would put
          // text nobody saw into a report about what was shown.
          type: "assistant",
          isSidechain: false,
          cwd: projectCwd,
          message: { role: "assistant", content: [{ type: "thinking", thinking: "not a reply" }] },
        },
      ]),
    );
    // A subagent writes its own file, one to three levels further down. This
    // directory is the whole reason the walk recurses.
    write(
      resolve(project, "session-1", "subagents", "agent-abc.jsonl"),
      jsonl([
        {
          type: "assistant",
          isSidechain: true,
          sessionId: "session-1",
          cwd: projectCwd,
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "The subagent said this." }] },
        },
      ]),
    );
  };

  it("finds a subagent reply in its own nested file", () => {
    // The bug this pins: scanning only projects/<project>/*.jsonl found every
    // main-loop reply and no subagent reply, and reported that as zero rather
    // than as an error. Subagents are the one place an output style cannot
    // reach, so a zero there is the most misleading number this tool can print.
    seed();
    const replies = claudeCodeChat.read();
    // Order is newest file first, which is what a report wants and not
    // something this assertion should depend on.
    expect(replies.map((r) => r.text).sort()).toEqual([
      "The main loop said this.",
      "The subagent said this.",
    ]);
    expect(replies.filter((r) => r.isSubagent)).toHaveLength(1);
    expect(replies.find((r) => r.isSubagent)?.text).toBe("The subagent said this.");
  });

  it("skips thinking blocks, which nobody was shown", () => {
    seed();
    expect(claudeCodeChat.read().some((r) => r.text.includes("not a reply"))).toBe(false);
  });

  it("scopes to one repository by the record's own cwd", () => {
    seed("/work/other");
    expect(claudeCodeChat.read({ cwd: "/work/repo" })).toHaveLength(0);
    expect(claudeCodeChat.read({ cwd: "/work/other" })).toHaveLength(2);
  });

  it("ignores the auto-memory directory, which holds no transcripts", () => {
    seed();
    write(resolve(home, "projects", "-work-repo", "memory", "MEMORY.jsonl"), jsonl([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "memory note" }] } },
    ]));
    expect(claudeCodeChat.read().some((r) => r.text === "memory note")).toBe(false);
  });

  it("says why it has nothing rather than reporting clean", () => {
    setEnv("CLAUDE_CONFIG_DIR", resolve(home, "absent"));
    const a = claudeCodeChat.available();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.why).toMatch(/SKIP_PROMPT_HISTORY|none have been written/);
  });

  it("takes the reply off the stop event, not the transcript, which lags", () => {
    const reply = claudeCodeChat.current({
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: "/tmp/nope.jsonl",
      last_assistant_message: "Done. Two files changed.",
    });
    expect(reply?.text).toBe("Done. Two files changed.");
    expect(reply?.isSubagent).toBe(false);
  });

  it("marks a SubagentStop reply as a subagent's", () => {
    const reply = claudeCodeChat.current({
      hook_event_name: "SubagentStop",
      agent_id: "agent_1",
      agent_type: "Explore",
      last_assistant_message: "Found three call sites.",
    });
    expect(reply?.isSubagent).toBe(true);
  });
});

describe("Codex rollout files", () => {
  const seed = (cwd = "/work/repo") => {
    setEnv("CODEX_HOME", home);
    write(
      resolve(home, "sessions", "2026", "08", "18", "rollout-x.jsonl"),
      jsonl([
        { type: "session_meta", payload: { session_id: "abc", cwd } },
        {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Codex replied here." }],
          },
        },
        // A user message uses input_text, and is not a reply.
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a question" }] },
        },
      ]),
    );
  };

  it("reads output_text from an assistant response_item", () => {
    seed();
    expect(codexChat.read().map((r) => r.text)).toEqual(["Codex replied here."]);
  });

  it("takes the working directory from session_meta, which carries it once", () => {
    seed("/work/elsewhere");
    expect(codexChat.read({ cwd: "/work/repo" })).toHaveLength(0);
    expect(codexChat.read({ cwd: "/work/elsewhere" })).toHaveLength(1);
  });

  it("falls back to the transcript when the event carries no message", () => {
    // Codex documents last_assistant_message as "if available". Absence is
    // expected rather than a bug, which is why there is a fallback at all.
    seed();
    const path = resolve(home, "sessions", "2026", "08", "18", "rollout-x.jsonl");
    const reply = codexChat.current({ session_id: "abc", transcript_path: path });
    expect(reply?.text).toBe("Codex replied here.");
  });

  it("prefers the event's own message when it has one", () => {
    seed();
    const reply = codexChat.current({ session_id: "abc", last_assistant_message: "From the event." });
    expect(reply?.text).toBe("From the event.");
  });
});

describe("Cursor agent transcripts", () => {
  it("reads the JSONL transcript, not the metadata store", () => {
    // Disk inspection alone found ~/.cursor/chats/<hash>/<uuid>/store.db, where
    // 11 of 39 blobs parsed and 4 were assistant messages. Building on that
    // would have reported a fraction of the replies and looked like a clean
    // scan. The documentation named this file instead.
    setEnv("CURSOR_HOME", home);
    const session = "86bba682";
    write(
      resolve(home, "projects", "-work-repo", "agent-transcripts", session, `${session}.jsonl`),
      jsonl([
        { role: "user", message: { content: [{ type: "text", text: "do a thing" }] } },
        { role: "assistant", message: { content: [{ type: "text", text: "Cursor replied here." }] } },
        { type: "turn_ended", status: "success" },
      ]),
    );
    expect(cursorChat.read().map((r) => r.text)).toEqual(["Cursor replied here."]);
  });

  it("gates nothing, and says so by returning null", () => {
    // Cursor documents stop and afterAgentResponse hooks; several reports say
    // its CLI dispatches only the two shell events. Until that is verified
    // against a running agent, chat on Cursor is ungated.
    expect(cursorChat.current({ last_assistant_message: "anything" })).toBeNull();
  });
});

describe("Copilot session store", () => {
  it("says why it cannot run rather than returning an empty list", () => {
    setEnv("COPILOT_HOME", resolve(home, "absent"));
    const a = copilotChat.available();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.why).toContain("session-store.db");
  });

  it("takes a SubagentStop reply straight off the event", () => {
    // Copilot's Stop does not carry the reply and its SubagentStop does. That
    // asymmetry is the reason `current` exists rather than the hook reading
    // one field everywhere.
    const reply = copilotChat.current({ sessionId: "s1", response: "Copilot subagent said this." });
    expect(reply?.text).toBe("Copilot subagent said this.");
    expect(reply?.isSubagent).toBe(true);
  });
});

describe("the reader registry", () => {
  it("covers every agent this package supports", () => {
    expect(readerIds().sort()).toEqual(["claude-code", "codex", "copilot", "cursor"]);
    for (const id of readerIds()) expect(readerFor(id)?.id).toBe(id);
  });

  it("keeps a failure as a reason, never as an empty result", () => {
    // The failure docs/verifying-an-adapter.md opens by naming: a reader that
    // read nothing and one that found nothing are indistinguishable unless the
    // first one says so.
    setEnv("CLAUDE_CONFIG_DIR", resolve(home, "absent"));
    setEnv("CODEX_HOME", resolve(home, "absent"));
    setEnv("COPILOT_HOME", resolve(home, "absent"));
    setEnv("CURSOR_HOME", resolve(home, "absent"));
    const results = readAll(READERS, {});
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.replies).toEqual([]);
      expect(r.unavailable, `${r.id} should say why it found nothing`).toBeTruthy();
    }
  });
});

describe("the chat ruleset", () => {
  const base = compile(loadDefault());
  const set = chatRuleSet(base);

  it("carries the chat tells, which the document ruleset does not", () => {
    expect(set.rules.some((r) => r.id === "affirmation-opener")).toBe(true);
    expect(base.rules.some((r) => r.id === "affirmation-opener")).toBe(false);
  });

  it("drops the waiver rule, since a reply carries no waivers", () => {
    expect(set.readability.some((r) => r.kind === "unexplained-suppression")).toBe(false);
  });

  it("still masks code, so a reply quoting a banned term is not a finding", () => {
    const reply = "The helper is called `leverage()` and it does nothing.";
    expect(lintText(reply, set).errorCount).toBe(0);
  });

  it("catches an opener only at the start of a reply", () => {
    expect(lintText("Great question. The answer is four.", set).findings.some(
      (f) => f.ruleId === "affirmation-opener",
    )).toBe(true);
    expect(lintText("You asked what makes a great question here.", set).findings.some(
      (f) => f.ruleId === "affirmation-opener",
    )).toBe(false);
  });

  it("catches a closing pleasantry anywhere", () => {
    expect(lintText("Two files changed. Hope this helps.", set).findings.some(
      (f) => f.ruleId === "closing-pleasantry",
    )).toBe(true);
  });
});

describe("scope and window helpers", () => {
  it("treats a subdirectory as inside the repository", () => {
    expect(inScope("/work/repo/src", "/work/repo")).toBe(true);
    expect(inScope("/work/repo", "/work/repo")).toBe(true);
    // A sibling whose name merely starts the same way is not inside it.
    expect(inScope("/work/repository", "/work/repo")).toBe(false);
    expect(inScope(undefined, "/work/repo")).toBe(false);
    expect(inScope(undefined, undefined)).toBe(true);
  });

  it("keeps a reply with no timestamp rather than dropping it", () => {
    const now = Date.parse("2026-08-18T00:00:00Z");
    expect(withinDays(undefined, 30, now)).toBe(true);
    expect(withinDays("2026-08-17T00:00:00Z", 30, now)).toBe(true);
    expect(withinDays("2026-01-01T00:00:00Z", 30, now)).toBe(false);
  });
});

describe("the chat gate", () => {
  const base = compile(loadDefault());
  const strict = { ...base, failOn: "error" as const };
  const reply = (text: string) => ({
    text,
    isSubagent: false,
    session: "s1",
    source: "/tmp/t.jsonl",
    line: 1,
  });

  it("allows a clean reply and says nothing", () => {
    const d = decideChat(reply("Two files changed. Tests pass."), {
      projectDir: home,
      ruleSet: strict,
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it("reports without holding up a turn under the advisory default", () => {
    // failOn: never is the shipped default. On this channel the cost of the
    // default is a line of output, never a turn.
    const d = decideChat(reply("We leverage a seamless approach."), {
      projectDir: home,
      ruleSet: base,
    });
    expect(d.allow).toBe(true);
    expect(d.advisory).toContain("leverage");
  });

  it("blocks under strict mode and hands the findings to the model", () => {
    const d = decideChat(reply("We leverage a seamless approach."), {
      projectDir: home,
      ruleSet: strict,
      promptId: "p1",
    });
    expect(d.allow).toBe(false);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("leverage");
  });

  it("blocks a turn at most once, so a rewrite cannot loop", () => {
    // The failure this prevents: block, the model rewrites, the rewrite trips
    // another rule, block again, forever, with a person watching it.
    const opts = { projectDir: home, ruleSet: strict, promptId: "p1" };
    expect(decideChat(reply("We leverage this."), opts).allow).toBe(false);
    const second = decideChat(reply("We utilize this instead."), opts);
    expect(second.allow).toBe(true);
    expect(second.advisory).toContain("utiliz");
  });

  it("blocks again on a new turn", () => {
    expect(
      decideChat(reply("We leverage this."), { projectDir: home, ruleSet: strict, promptId: "a" })
        .allow,
    ).toBe(false);
    expect(
      decideChat(reply("We leverage this."), { projectDir: home, ruleSet: strict, promptId: "b" })
        .allow,
    ).toBe(false);
  });

  it("never blocks when the agent says this turn is already a hook's doing", () => {
    // Both Claude Code and Copilot document stop_hook_active for exactly this.
    // Ignoring it means building a worse version of the guard they gave you.
    const d = decideChat(reply("We leverage this."), {
      projectDir: home,
      ruleSet: strict,
      promptId: "fresh",
      stopHookActive: true,
    });
    expect(d.allow).toBe(true);
  });

  it("is waived by the ack file, like every other channel", () => {
    writeFileSync(resolve(home, ".plain-english-ack-chat"), "");
    const d = decideChat(reply("We leverage this."), {
      projectDir: home,
      ruleSet: strict,
      promptId: "p9",
    });
    expect(d.allow).toBe(true);
    // The hatch silences the advice as well as the refusal, or an agent that
    // can only be told things keeps being told this one.
    expect(d.advisory).toBeUndefined();
  });

  it("keeps its state file beside the ack file, and lets it expire", () => {
    const path = blockStatePath(home, "p1");
    expect(path.startsWith(home)).toBe(true);
    expect(path).toContain(".plain-english-chat-");

    const opts = { projectDir: home, ruleSet: strict, promptId: "p1" };
    expect(decideChat(reply("We leverage this."), opts).allow).toBe(false);
    // Eleven minutes later the window has passed and the gate works again,
    // rather than a stale file silencing it forever.
    const later = Date.now() + 11 * 60 * 1000;
    expect(decideChat(reply("We leverage this."), { ...opts, now: later }).allow).toBe(false);
  });

  it("refuses to be handed to the write-path decider", () => {
    // decide() reads tool input, and a stop event has none. Reaching that
    // branch would judge an empty object and allow everything.
    expect(() => decide({ tool: "other", input: {} }, "chat", { projectDir: home })).toThrow(
      /decideChat/,
    );
  });
});

describe("stop-event wire formats", () => {
  const blocked = {
    allow: false,
    decision: "deny" as const,
    reason: "no",
    advisory: "no",
    findings: [],
  };
  const advisory = { allow: true, decision: "ask" as const, advisory: "heads up", findings: [] };
  const clean = { allow: true, decision: "allow" as const, findings: [] };

  it("claude-code echoes the event it was given", () => {
    const out = byId("claude-code")!.emitChat!(blocked, "SubagentStop");
    const body = JSON.parse(out.stdout);
    expect(body.hookSpecificOutput.hookEventName).toBe("SubagentStop");
    expect(body.hookSpecificOutput.decision).toBe("block");
    expect(out.exitCode).toBe(0);
  });

  it("every agent says nothing at all about a clean reply", () => {
    for (const id of ["claude-code", "codex", "copilot"]) {
      expect(byId(id)!.emitChat!(clean, "Stop").stdout, id).toBe("");
    }
  });

  it("an advisory reaches the user without refusing the turn", () => {
    for (const id of ["claude-code", "codex", "copilot"]) {
      const body = JSON.parse(byId(id)!.emitChat!(advisory, "Stop").stdout);
      expect(body.systemMessage, id).toBe("heads up");
      expect(body.decision, id).toBeUndefined();
    }
  });

  it("copilot leaves modifiedResponse out while nothing sets it", () => {
    // The field exists on Decision so the contract does not have to change
    // later. Using it means generating prose, and nothing here does.
    const body = JSON.parse(byId("copilot")!.emitChat!(blocked, "subagentStop").stdout);
    expect(body.decision).toBe("block");
    expect("modifiedResponse" in body).toBe(false);
  });

  it("no agent ever exits non-zero, which Copilot reads as a refusal", () => {
    for (const id of ["claude-code", "codex", "copilot"]) {
      for (const d of [clean, advisory, blocked]) {
        expect(byId(id)!.emitChat!(d, "Stop").exitCode, id).toBe(0);
      }
    }
  });
});
