import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { claudeCodeChat } from "../src/chat/claude-code.ts";
import { codexChat } from "../src/chat/codex.ts";
import { cursorChat } from "../src/chat/cursor.ts";
import { copilotChat } from "../src/chat/copilot.ts";
import { READERS, readAll, readerFor, readerIds } from "../src/chat/registry.ts";
import { hasSegment, inScope, withinDays } from "../src/chat/reader.ts";
import { chatRuleSet, compile, loadDefault } from "../src/rules.ts";
import { decideChat, blockStatePath, sweepLegacyState } from "../src/adapters/chat.ts";
import { decide, formatReason } from "../src/adapters/hook.ts";
import { byId } from "../src/agents/registry.ts";
import { lintText } from "../src/lint.ts";
import { JUDGE_MARKER, isJudge, judgeInput, lastAsked, parseVerdict, runJudge, usableReason } from "../src/adapters/judge.ts";

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

  it("reads the reader's last question off the transcript, which the stop event omits", () => {
    const path = resolve(home, "s1.jsonl");
    write(
      path,
      jsonl([
        { type: "user", message: { role: "user", content: "Why is the release job slow?" } },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Because it waits." }] },
        },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
      ]),
    );
    expect(claudeCodeChat.lastAsk?.({ transcript_path: path })).toBe("Why is the release job slow?");
  });

  it("falls back to the transcript for the question, since Stop carries only the reply", () => {
    const path = resolve(home, "s2.jsonl");
    write(
      path,
      jsonl([
        { type: "user", message: { role: "user", content: "Walk me through the release job." } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      ]),
    );
    expect(lastAsked({ transcript_path: path }, claudeCodeChat)).toBe(
      "Walk me through the release job.",
    );
  });

  it("prefers a question the payload carries over one read off disk", () => {
    const path = resolve(home, "s3.jsonl");
    write(
      path,
      jsonl([{ type: "user", message: { role: "user", content: "the stale one" } }]),
    );
    expect(lastAsked({ transcript_path: path, prompt: "the live one" }, claudeCodeChat)).toBe(
      "the live one",
    );
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
    expect(readerIds().sort()).toEqual(["claude-code", "codex", "copilot", "cursor", "vibe"]);
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
    setEnv("VIBE_HOME", resolve(home, "absent"));
    const results = readAll(READERS, {});
    expect(results).toHaveLength(5);
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

  /**
   * The judge, and the boundary of what it may waive.
   *
   * A count cannot tell a wall of text from a walkthrough the reader asked
   * for. Firing on one reply in ten, measured over seven days of transcripts,
   * that difference is the whole cost of the rule. So the counts get a second
   * opinion and nothing else does: an em dash is an em dash whatever was
   * asked.
   */
  describe("the reply limits get a second opinion", () => {
    const long = Array.from({ length: 65 }, (_, i) => `Point ${i} is settled.`).join(" ");
    const banned = long + " We leverage a seamless approach.";

    it("waives a length the reader asked for", () => {
      const d = decideChat(reply(long), {
        projectDir: home,
        ruleSet: strict,
        judge: () => ({ ok: true }),
      });
      expect(d.allow).toBe(true);
      expect(d.findings.some((f) => f.ruleId === "reply-length")).toBe(true);
    });

    it("refuses with what the reply should have led with, not with a word count", () => {
      const d = decideChat(reply(long), {
        projectDir: home,
        ruleSet: strict,
        judge: () => ({ ok: false, reason: "Lead with: point 7 is the answer." }),
      });
      expect(d.allow).toBe(false);
      expect(d.reason).toBe("Lead with: point 7 is the answer.");
      expect(d.reason).not.toMatch(/words of prose/);
    });

    it("is never asked about a rule it has no business waiving", () => {
      // A banned term is failing too, so the answer is already settled and the
      // model call would be spent to change nothing.
      let asked = false;
      const d = decideChat(reply(banned), {
        projectDir: home,
        ruleSet: strict,
        judge: () => {
          asked = true;
          return { ok: true };
        },
      });
      expect(asked).toBe(false);
      expect(d.allow).toBe(false);
    });

    it("falls back to the count when the judge cannot answer", () => {
      // Timed out, failed to start, or replied with something unreadable. The
      // count is the answer this package had before the judge existed, and a
      // gate that fails open because a subprocess died is the failure this
      // project keeps finding in other people's tools.
      const d = decideChat(reply(long), {
        projectDir: home,
        ruleSet: strict,
        judge: () => undefined,
      });
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/words of prose/);
    });

    it("costs nothing when no limit is failing", () => {
      let asked = false;
      decideChat(reply("Two files changed."), {
        projectDir: home,
        ruleSet: strict,
        judge: () => {
          asked = true;
          return { ok: true };
        },
      });
      expect(asked).toBe(false);
    });
  });

  it("allows a clean reply and says nothing", () => {
    const d = decideChat(reply("Two files changed. Tests pass."), {
      projectDir: home,
      ruleSet: strict,
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it("blocks by default here, while the document channel still only reports", () => {
    // The two tiers are separate on purpose. The top-level default stays
    // `never`, so installing this package cannot start failing anyone's build.
    // Chat ships `error`, because a reply has no build to fail and the whole
    // cost of the advisory tier is that the reader has already read the reply
    // by the time anything objects to it.
    expect(base.failOn).toBe("never");
    expect(base.chat.failOn).toBe("error");
    const d = decideChat(reply("We leverage a seamless approach."), {
      projectDir: home,
      ruleSet: base,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("leverage");
  });

  it("still reports without holding up a turn when a project asks for that", () => {
    const quiet = { ...base, chat: { ...base.chat, failOn: "never" as const } };
    const d = decideChat(reply("We leverage a seamless approach."), {
      projectDir: home,
      ruleSet: quiet,
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

  /**
   * The retry after a dash.
   *
   * Over the three days to 2026-08-19 the gate blocked 69 of the 218 replies
   * it judged, and 38 of those failed on nothing but an em dash. A turn gets
   * one block, so more than half of them were spent asking for a substitution,
   * and the rewrite that came back was never judged on anything else.
   */
  describe("a punctuation-only block does not use up the turn", () => {
    const dash = "We changed the release job \u2014 it merges now.";

    it("blocks a second time when the rewrite turns out to be unreadable", () => {
      const opts = { projectDir: home, ruleSet: strict, promptId: "d1" };
      expect(decideChat(reply(dash), opts).allow).toBe(false);
      const second = decideChat(reply("We leverage this."), {
        ...opts,
        stopHookActive: true,
      });
      expect(second.allow).toBe(false);
      expect(second.reason).toContain("leverage");
    });

    it("stops at two, so a rewrite still cannot loop", () => {
      const opts = { projectDir: home, ruleSet: strict, promptId: "d2" };
      expect(decideChat(reply(dash), opts).allow).toBe(false);
      expect(
        decideChat(reply("We leverage this."), { ...opts, stopHookActive: true }).allow,
      ).toBe(false);
      expect(
        decideChat(reply("We utilize this."), { ...opts, stopHookActive: true }).allow,
      ).toBe(true);
    });

    it("does not retry a dash with another dash", () => {
      const opts = { projectDir: home, ruleSet: strict, promptId: "d3" };
      expect(decideChat(reply(dash), opts).allow).toBe(false);
      expect(decideChat(reply(dash), { ...opts, stopHookActive: true }).allow).toBe(true);
    });

    it("does not retry a block that already named something else", () => {
      const opts = { projectDir: home, ruleSet: strict, promptId: "d4" };
      expect(decideChat(reply("We leverage this."), opts).allow).toBe(false);
      expect(
        decideChat(reply("We utilize this."), { ...opts, stopHookActive: true }).allow,
      ).toBe(true);
    });
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
    // Not inside the repository. Machine-written state that nobody reads by
    // hand has no business in somebody's working tree, and 0.12.0 shipped it
    // there: one file per session, never cleaned up, never gitignored. One
    // repo on the author's machine collected fourteen in an afternoon, and any
    // `git add -A` would have committed them.
    expect(path.startsWith(home)).toBe(false);
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path).toContain("plain-english-chat-");

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

  /**
   * Flat, not nested, and this one is observed rather than reasoned about.
   *
   * Run against Claude Code 2.1.234 in a real interactive session on
   * 2026-08-18, driving a pty with a minimal always-block Stop hook whose
   * reason asked for a word the model would never otherwise write. Same
   * driver, same session, one variable changed:
   *
   *   nested `{hookSpecificOutput: {decision: "block"}}`  -> Stop fired once,
   *     the turn ended, the word never appeared.
   *   flat   `{decision: "block", reason}`                -> Stop fired again
   *     with stop_hook_active true, and the reply carried the word.
   *
   * So the nested shape this package shipped could never hold a turn. The gate
   * ran, reported, and let every reply through, which is this project's
   * recurring failure wearing the package's own colours. `hookEventName` has
   * no place in a flat body; the event is echoed nowhere because the hook is
   * already registered per event.
   */
  it("claude-code blocks with the flat shape, which is the one that works", () => {
    const out = byId("claude-code")!.emitChat!(blocked, "SubagentStop");
    const body = JSON.parse(out.stdout);
    expect(body.decision).toBe("block");
    expect(body.reason).toBe("no");
    expect("hookSpecificOutput" in body).toBe(false);
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

describe("path handling survives Windows", () => {
  it("finds a subagent by its directory on either separator", () => {
    // The fixture in the reader test also sets isSidechain, so it passes even
    // when the directory check is broken. This asserts the directory check on
    // its own, with the separator Windows `resolve` actually returns.
    expect(hasSegment("C:\\Users\\x\\.claude\\projects\\p\\s\\subagents\\a.jsonl", "subagents")).toBe(true);
    expect(hasSegment("/srv/agent/projects/p/s/subagents/a.jsonl", "subagents")).toBe(true);
    // Not a substring match: a project literally named "subagents-notes" is a
    // project, not a subagent.
    expect(hasSegment("/srv/agent/projects/subagents-notes/s.jsonl", "subagents")).toBe(false);
  });

  it("scopes by path segment, not by string prefix", () => {
    // `/work/repository`.startsWith("/work/repo") is true and wrong.
    expect(inScope("C:\\work\\repo\\src", "C:\\work\\repo")).toBe(true);
    expect(inScope("/work/repository", "/work/repo")).toBe(false);
    expect(inScope("C:\\work\\repository", "C:\\work\\repo")).toBe(false);
  });
});

describe("shapes observed against live agents on 2026-08-18", () => {
  it("claude-code: Stop and SubagentStop install nested, never flat", () => {
    // Flat is what the documentation shows for Stop, and against 2.1.234 it
    // fails validation. `claude --help` says the consequence out loud: in print
    // mode a settings file that fails validation is silently ignored. So a flat
    // entry here takes every other hook in the user's file down with it.
    const config = byId("claude-code")!.plan({ prompts: {}, model: "" }).config;
    for (const event of ["hooks.Stop", "hooks.SubagentStop"]) {
      const file = config.find((c) => c.at.join(".") === event)!;
      expect(file, `${event} not installed`).toBeTruthy();
      expect(file.shape, `${event} must be nested`).toBe("nested");
      expect(Object.keys(file.entries[0] as object).sort()).toEqual(["hooks", "matcher"]);
    }
  });

  it("claude-code: a SubagentStop names the subagent's own transcript", () => {
    // `agent_transcript_path` is present only on SubagentStop. Without it a
    // finding points at the parent's transcript, where the reply is not.
    const reply = claudeCodeChat.current({
      hook_event_name: "SubagentStop",
      agent_id: "ab08736697aafa2e3",
      agent_type: "Explore",
      session_id: "s1",
      transcript_path: "/parent.jsonl",
      agent_transcript_path: "/agent.jsonl",
      last_assistant_message: "Found it.",
    });
    expect(reply?.isSubagent).toBe(true);
    expect(reply?.source).toBe("/agent.jsonl");
  });

  it("copilot: Stop carries no reply, so the event stream answers instead", () => {
    // Observed payload keys on Stop: cwd, sessionId, stopReason,
    // stop_hook_active, timestamp, transcriptPath. No reply text anywhere.
    const events = resolve(home, "events.jsonl");
    writeFileSync(
      events,
      jsonl([
        { type: "user.message", data: { content: "a question" } },
        { type: "assistant.message", data: { content: "An earlier turn." } },
        { type: "assistant.message", data: { content: "We leverage a seamless approach." } },
        { type: "assistant.turn_end", data: {} },
      ]),
    );
    const reply = copilotChat.current({
      sessionId: "s1",
      stopReason: "end_turn",
      stop_hook_active: false,
      transcriptPath: events,
    });
    // Last one wins: the reply this stop event is about is the latest.
    expect(reply?.text).toBe("We leverage a seamless approach.");
    expect(reply?.isSubagent).toBe(false);
  });

  it("copilot: a SubagentStop reply still comes straight off the event", () => {
    const reply = copilotChat.current({ sessionId: "s1", response: "Subagent said this." });
    expect(reply?.text).toBe("Subagent said this.");
    expect(reply?.isSubagent).toBe(true);
  });

  it("cursor installs no stop hook, because its CLI dispatches none", () => {
    // Observed: with 12 events registered, including `stop` and
    // `afterAgentResponse`, only sessionStart and sessionEnd fired.
    const events = byId("cursor")!.plan({ prompts: {}, model: "" }).config.map((c) => c.at.join("."));
    expect(events.some((e) => /stop|agentresponse/i.test(e))).toBe(false);
    expect(byId("cursor")!.emitChat).toBeUndefined();
  });
});

/**
 * Mistral Vibe session logs.
 *
 * Location: `$VIBE_HOME/logs/session/session_<ts>_<id>/messages.jsonl`,
 * defaulting to `~/.vibe`. Subagents nest under `agents/<name>_<ts>_<id>/`
 * inside their parent's directory.
 *
 * The transcript is a plain role/content message list, so it carries no
 * working directory and no timestamps. Both live in the sibling `meta.json`,
 * which is why scope is resolved per session rather than per record.
 */
describe("Mistral Vibe transcripts", () => {
  const meta = (cwd: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "823cdc9b",
      parent_session_id: null,
      start_time: "2026-08-17T15:56:29.449527+00:00",
      environment: { working_directory: cwd },
      ...extra,
    });

  function seedSession(cwd: string, records: unknown[], id = "session_20260817_155629_abc"): string {
    const dir = resolve(home, "logs/session", id);
    write(resolve(dir, "meta.json"), meta(cwd));
    write(resolve(dir, "messages.jsonl"), jsonl(records));
    setEnv("VIBE_HOME", home);
    return dir;
  }

  it("reads what the assistant said", async () => {
    const { vibeChat } = await import("../src/chat/vibe.ts");
    seedSession("/work/repo", [
      { role: "user", content: "hi", injected: false, message_id: "1" },
      { role: "assistant", content: "We leverage the cache.", injected: false, message_id: "2" },
    ]);
    const replies = vibeChat.read({ cwd: "/work/repo" });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("We leverage the cache.");
    expect(replies[0]!.isSubagent).toBe(false);
  });

  it("skips a turn that only called a tool", () => {
    // An assistant turn mid-tool-call carries `content: null` and its
    // `tool_calls`. Counting those as replies would report empty prose.
    return import("../src/chat/vibe.ts").then(({ vibeChat }) => {
      seedSession("/work/repo", [
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }], injected: false },
        { role: "tool", content: "ok", tool_call_id: "c1", injected: false },
        { role: "assistant", content: "Done.", injected: false },
      ]);
      const replies = vibeChat.read({ cwd: "/work/repo" });
      expect(replies.map((r) => r.text)).toEqual(["Done."]);
    });
  });

  it("ignores a message Vibe injected, since nobody wrote it", async () => {
    const { vibeChat } = await import("../src/chat/vibe.ts");
    seedSession("/work/repo", [
      { role: "assistant", content: "Real reply.", injected: false },
      { role: "assistant", content: "Injected retry text.", injected: true },
    ]);
    expect(vibeChat.read({ cwd: "/work/repo" }).map((r) => r.text)).toEqual(["Real reply."]);
  });

  it("scopes by the working directory in meta.json, not by the transcript", async () => {
    const { vibeChat } = await import("../src/chat/vibe.ts");
    seedSession("/work/other", [{ role: "assistant", content: "Elsewhere.", injected: false }]);
    expect(vibeChat.read({ cwd: "/work/repo" })).toHaveLength(0);
    expect(vibeChat.read({ cwd: "/work/other" })).toHaveLength(1);
  });

  it("marks a subagent reply, because the style does reach one here", async () => {
    const { vibeChat } = await import("../src/chat/vibe.ts");
    const dir = seedSession("/work/repo", [{ role: "assistant", content: "Parent.", injected: false }]);
    write(resolve(dir, "agents/explore_20260817_163251_cb8/meta.json"), meta("/work/repo"));
    write(
      resolve(dir, "agents/explore_20260817_163251_cb8/messages.jsonl"),
      jsonl([{ role: "assistant", content: "Child.", injected: false }]),
    );
    const replies = vibeChat.read({ cwd: "/work/repo" });
    expect(replies.map((r) => r.text).sort()).toEqual(["Child.", "Parent."]);
    expect(replies.find((r) => r.text === "Child.")!.isSubagent).toBe(true);
    expect(replies.find((r) => r.text === "Parent.")!.isSubagent).toBe(false);
  });

  it("answers a post_agent event from the transcript it names", async () => {
    const { vibeChat } = await import("../src/chat/vibe.ts");
    const dir = seedSession("/work/repo", [
      { role: "assistant", content: "First.", injected: false },
      { role: "assistant", content: "We leverage the cache.", injected: false },
    ]);
    const reply = vibeChat.current({
      hook_event_name: "post_agent",
      session_id: "823cdc9b",
      transcript_path: resolve(dir, "messages.jsonl"),
      cwd: "/work/repo",
    });
    expect(reply?.text).toBe("We leverage the cache.");
  });

  it("says why it cannot run rather than reporting a clean scan", async () => {
    const { vibeChat } = await import("../src/chat/vibe.ts");
    setEnv("VIBE_HOME", resolve(home, "nope"));
    const availability = vibeChat.available();
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.why).toContain("nope");
  });

  it("is in the reader registry", async () => {
    await import("../src/chat/vibe.ts");
    expect(readerIds()).toContain("vibe");
  });
});

/**
 * Reader load.
 *
 * Seven days of transcripts, read on 2026-08-18: thirteen replies drew an
 * explicit complaint from the reader. Every one was 264 words or longer, and
 * four of the thirteen produced no finding at all. Across all thirteen the
 * linter fired 69 times, on em dashes, unglossed terms and long sentences, and
 * not once on the thing the reader actually named.
 *
 * The complaint was always one of two words: too long, or "what EXACTLY do you
 * need from me". So these two rules measure what one reply asks the reader to
 * carry, which no existing rule does.
 *
 * Both are chat-only. A long document is not a fault.
 *
 * Fixtures are hand-authored to the measured thresholds, per the note at the
 * top of this file.
 */
describe("reader load", () => {
  const set = chatRuleSet(compile(loadDefault()));
  const base = compile(loadDefault());
  const fired = (text: string, id: string) =>
    lintText(text, set).findings.some((f) => f.ruleId === id);

  // 260 words of unobjectionable prose: no banned term, no em dash, every
  // sentence short. The only thing wrong with it is that there is too much.
  const long = Array.from({ length: 65 }, (_, i) => `Point ${i} is settled.`).join(" ");

  it("counts the words in a reply", () => {
    expect(long.split(/\s+/).length).toBeGreaterThan(250);
    expect(lintText(long, set).findings.filter((f) => f.ruleId !== "reply-length")).toEqual([]);
  });

  it("fires on a reply past the length the reader stops reading", () => {
    expect(fired(long, "reply-length")).toBe(true);
  });

  it("leaves a short reply alone", () => {
    expect(fired("Two files changed. Nothing needs deciding.", "reply-length")).toBe(false);
  });

  it("does not judge a document by reply length", () => {
    expect(lintText(long, base).findings.some((f) => f.ruleId === "reply-length")).toBe(false);
  });

  // Sixteen separate names in two short lines. Under 250 words, so the only
  // thing wrong with it is how many things the reader has to hold.
  const many = "Set " + Array.from({ length: 16 }, (_, i) => `\`opt-${i}\``).join(", ") + ".";

  it("fires on a reply carrying too many separate names", () => {
    expect(fired(many, "reader-load")).toBe(true);
    expect(fired(many, "reply-length")).toBe(false);
  });

  it("counts distinct names, not repeated ones", () => {
    // The same name twenty times is one thing to learn, not twenty. Density
    // measured the wrong quantity and this is the case that shows it.
    const repeated = "Set " + Array.from({ length: 20 }, () => "\`failOn\`").join(", ") + ".";
    expect(fired(repeated, "reader-load")).toBe(false);
  });

  it("does not count a name against a document", () => {
    expect(lintText(many, base).findings.some((f) => f.ruleId === "reader-load")).toBe(false);
  });

  /**
   * Pace.
   *
   * Measured on 2026-08-19 over the 218 replies the gate judged. Of the four
   * replies the reader stopped on that were long enough to measure, every one
   * ran above the corpus median of 11.6 words a sentence, at 13.5, 14.5, 15.7
   * and 16.6. Three other measures of density said the opposite: those replies
   * carried fewer nominalisations, fewer noun stacks and shorter words than
   * the corpus did. The load was the pace, not the vocabulary.
   */
  describe("pace", () => {
    // Twelve sentences of fifteen words. No banned term, no sentence long
    // enough for `long-sentence`, nothing to point at except that it never
    // lets up.
    const relentless = Array.from(
      { length: 12 },
      (_, i) => `Step ${i} is ` + Array.from({ length: 12 }, () => "done").join(" ") + ".",
    ).join(" ");

    // Twenty sentences of four words. The same subject, paced.
    const paced = Array.from({ length: 20 }, (_, i) => `Step ${i} is done.`).join(" ");

    it("fires on a reply that never lets up", () => {
      expect(fired(relentless, "reply-pace")).toBe(true);
    });

    it("leaves a reply of short sentences alone", () => {
      expect(fired(paced, "reply-pace")).toBe(false);
    });

    it("says nothing about a short reply, which has no pace to judge", () => {
      // Two sentences of twenty words. Over the mean, under the floor, and a
      // two-sentence answer that happens to run long is not a wall of text.
      const brief = Array.from(
        { length: 2 },
        () => Array.from({ length: 20 }, () => "word").join(" ") + ".",
      ).join(" ");
      expect(fired(brief, "reply-pace")).toBe(false);
    });

    it("does not judge a document by its pace", () => {
      expect(lintText(relentless, base).findings.some((f) => f.ruleId === "reply-pace")).toBe(
        false,
      );
    });

    it("names the number, so the finding can be checked", () => {
      const f = lintText(relentless, set).findings.find((x) => x.ruleId === "reply-pace");
      expect(f?.message).toMatch(/words a sentence/);
    });

    it("is a count the judge may waive, like the other two", () => {
      const seen: string[] = [];
      decideChat(
        { text: relentless, isSubagent: false, session: "s", source: "t", line: 1 },
        {
          projectDir: home,
          promptId: "pace-1",
          judge: (_r, findings) => {
            seen.push(...findings.map((x) => x.ruleId));
            return { ok: true };
          },
        },
      );
      expect(seen).toContain("reply-pace");
    });
  });

  /**
   * The ask at the end.
   *
   * Every sentence here was said to a real reader in the three days to
   * 2026-08-19. The first two drew "what does that mean?" and a request to
   * start over; the last two were answered without comment.
   */
  describe("the closing ask", () => {
    const asked = (text: string) => fired(text, "unreadable-ask");

    it("fires on a closing question the reader has to unpack", () => {
      expect(
        asked(
          "The merge code says otherwise.\n\nWant me to look at whether the JSON " +
            "merge has the same by-name behaviour the TOML path documents?",
        ),
      ).toBe(true);
    });

    it("fires on a closing question that runs long", () => {
      expect(
        asked(
          "Is your goal to make the reaction line show the custom emoji as something " +
            "recognizable, or is there something broader you had in mind?",
        ),
      ).toBe(true);
    });

    it("leaves a short ask alone", () => {
      expect(asked("Two files changed.\n\nWhich way do you want to go?")).toBe(false);
      expect(
        asked("Does this look right, or do you want to adjust before I save it?"),
      ).toBe(false);
    });

    it("does not count a leading which or what as a clause", () => {
      expect(asked("Which one, and which rec?")).toBe(false);
    });

    it("says nothing about a reply that ends in a statement", () => {
      const q = "Should I rebase the branch onto main before the release goes out today?";
      expect(asked(q + "\n\nNothing needs deciding.")).toBe(false);
    });

    it("does not judge a document by its closing question", () => {
      const long =
        "Want me to look at whether the JSON merge has the same by-name behaviour " +
        "the TOML path documents?";
      expect(lintText(long, base).findings.some((f) => f.ruleId === "unreadable-ask")).toBe(
        false,
      );
    });
  });
});

/**
 * The judge subprocess.
 *
 * Everything here fails towards the count. A judge that cannot start, cannot
 * finish, or answers with something unreadable must hand the decision back to
 * the number, because a gate that opens when a subprocess dies is the failure
 * this package keeps finding in other people's tools.
 */
describe("the chat judge", () => {
  it("reads a pass and a refusal", () => {
    expect(parseVerdict('{"ok": true}')).toEqual({ ok: true });
    expect(parseVerdict('{"ok": false, "reason": "Lead with the number."}')).toEqual({
      ok: false,
      reason: "Lead with the number.",
    });
  });

  it("finds the JSON inside a fenced block or a sentence", () => {
    expect(parseVerdict('Here you go:\n```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it("defers to the count on anything it cannot read", () => {
    for (const junk of ["", "  ", "no", "{}", '{"ok": "yes"}', "{not json}"]) {
      expect(parseVerdict(junk), JSON.stringify(junk)).toBeUndefined();
    }
  });

  it("defers on a refusal that gives no reason", () => {
    // Worse than no refusal: it holds the turn and says nothing about what to
    // do differently.
    expect(parseVerdict('{"ok": false}')).toBeUndefined();
    expect(parseVerdict('{"ok": false, "reason": "  "}')).toBeUndefined();
  });

  it("will not start a judge from inside a judge", () => {
    // The subprocess runs in the same directory and reads the same settings,
    // so without this its own Stop hook would measure its own reply and start
    // another. Live defect in the Vibe judge, caught only by the tools being
    // disabled there.
    expect(isJudge({ [JUDGE_MARKER]: "1" })).toBe(true);
    const v = runJudge("anything", {
      prompt: "judge this: $ARGUMENTS",
      command: "definitely-not-a-real-binary",
      args: [],
      env: { [JUDGE_MARKER]: "1" },
    });
    expect(v).toBeUndefined();
  });

  it("returns nothing rather than throwing when the binary is absent", () => {
    expect(
      runJudge("anything", {
        prompt: "judge this: $ARGUMENTS",
        command: "definitely-not-a-real-binary",
        args: [],
        env: {},
      }),
    ).toBeUndefined();
  });

  it("refuses a prompt with no slot to put the reply in", () => {
    expect(
      runJudge("anything", { prompt: "no slot here", command: "echo", args: [], env: {} }),
    ).toBeUndefined();
  });

  it("shows the judge what the reader asked, not just what was said", () => {
    // Every exception the ruleset grants is a fact about the question.
    const text = judgeInput(
      { text: "a long answer", isSubagent: false, session: "s", source: "t", line: 1 },
      "walk me through it",
      [{ ruleId: "reply-length", severity: "error", match: "", line: 1, column: 1, lineText: "", message: "400 words of prose, over 250." }],
    );
    expect(text).toContain("walk me through it");
    expect(text).toContain("reply-length");
    expect(text).toContain("a long answer");
  });

  it("says the reader's message was unavailable rather than inventing one", () => {
    const text = judgeInput(
      { text: "x", isSubagent: false, session: "s", source: "t", line: 1 },
      undefined,
      [],
    );
    expect(text).toContain("(not available)");
  });
});

/**
 * What a block leads with.
 *
 * A chat block holds one turn, and `formatReason` shows five findings. Over
 * three days to 2026-08-19 the gate blocked 69 of the 218 replies it judged
 * and 38 of those failed on nothing but an em dash, so ordering by line number
 * put a dash first and pushed the reason the reader would have cared about out
 * of the visible five.
 */
describe("a block leads with what the reader could not follow", () => {
  const f = (ruleId: string, line: number) => ({
    ruleId,
    severity: "error" as const,
    match: "x",
    line,
    column: 1,
    lineText: "",
  });

  it("puts a whole-reply finding above a dash that came first in the text", () => {
    const text = formatReason([f("em-dash", 1), f("reply-length", 12)], "chat");
    expect(text.indexOf("reply-length")).toBeLessThan(text.indexOf("em-dash"));
  });

  it("keeps the dash visible when six findings would hide it", () => {
    const text = formatReason(
      [
        f("em-dash", 1),
        f("em-dash", 2),
        f("em-dash", 3),
        f("em-dash", 4),
        f("em-dash", 5),
        f("unreadable-ask", 20),
      ],
      "chat",
    );
    expect(text).toContain("unreadable-ask");
    expect(text.indexOf("unreadable-ask")).toBeLessThan(text.indexOf("em-dash"));
  });

  it("leaves a document's findings in the order they appear", () => {
    const text = formatReason([f("em-dash", 1), f("reply-length", 12)], "docs");
    expect(text.indexOf("em-dash")).toBeLessThan(text.indexOf("reply-length"));
  });
});

describe("a refusal is held to the rules it enforces", () => {
  const set = chatRuleSet(compile(loadDefault()));

  it("rejects a reason carrying the thing the package bans", () => {
    // Caught live on the first end-to-end run: the judge refused a reply and
    // put an em dash in the refusal. A linter that emits the thing it bans has
    // nothing to say, so an unusable reason falls back to the word count.
    expect(usableReason("The reply never answers it — it repeats one line.", set)).toBe(false);
    expect(usableReason("We leverage a seamless approach.", set)).toBe(false);
  });

  it("keeps a reason that only trips a warning", () => {
    // Not worth trading the most useful sentence the reader will see for a
    // bare word count.
    const wordy =
      "The reader asked for one word and this reply spends its whole length restating " +
      "the question before it gets anywhere near an answer worth reading at all today.";
    expect(usableReason(wordy, set)).toBe(true);
  });

  it("keeps a plain, useful reason", () => {
    expect(usableReason('It should have led with "Yes."', set)).toBe(true);
  });
});


/**
 * A name in a table is still a name.
 *
 * `reader-load` counted backticked spans only, so a reply could put fifteen
 * unfamiliar names in a table and the counter saw none of them. That is not
 * hypothetical: on 2026-08-20 a reply did exactly that and was answered with
 * "I have no idea of anything you just wrote".
 */
describe("reader-load sees a name wherever the reply put it", () => {
  const set = chatRuleSet(compile(loadDefault()), "standard");

  const table = [
    "Here is what I found.",
    "",
    "```",
    "rule                     host-one   host-two",
    "puffery-nouns            deny       deny",
    "promotional-adjectives   deny       deny",
    "evolving-landscape       deny       deny",
    "abstract-landscape       deny       deny",
    "deeply-rooted            deny       deny",
    "reply-pace               deny       deny",
    "reader-load              deny       deny",
    "unreadable-ask           deny       deny",
    "unglossed-term           deny       deny",
    "binary-contrast          deny       deny",
    "weasel-attribution       deny       deny",
    "synonym-cycling          deny       deny",
    "hedging-stacks           deny       deny",
    "```",
  ].join("\n");

  it("counts the names in a fenced table", () => {
    const findings = lintText(table, set).findings.filter((f) => f.ruleId === "reader-load");
    expect(findings.length, "a table of fifteen names cost the counter nothing").toBe(1);
  });

  it("does not count ordinary English as a name", () => {
    // The counter has to stay blind to prose or it fires on every reply. Only
    // identifier-shaped text counts: an internal hyphen or underscore, a flag,
    // a filename, a path.
    const prose = Array.from(
      { length: 40 },
      (_, i) => `This sentence is about the thing and it is number ${i}.`,
    ).join(" ");
    const findings = lintText(prose, set).findings.filter((f) => f.ruleId === "reader-load");
    expect(findings, "plain prose counted as names").toEqual([]);
  });

  it("still counts a backticked name, which is how it always worked", () => {
    const ticked = Array.from({ length: 30 }, (_, i) => `\`name-${i}\``).join(" and ");
    const findings = lintText(ticked, set).findings.filter((f) => f.ruleId === "reader-load");
    expect(findings.length).toBe(1);
  });
});
