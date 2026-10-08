import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { antigravity } from "../src/agents/antigravity.ts";
import { decide } from "../src/adapters/hook.ts";
import { init } from "../src/init.ts";
import { compile, loadDefault } from "../src/rules.ts";
import { resolveProfile } from "../src/agents/registry.ts";
import { antigravityChat } from "../src/chat/antigravity.ts";
import { readAll } from "../src/chat/registry.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), "pe-antigravity-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const bad = "We leverage this.";
const strict = compile({ ...loadDefault(), failOn: "error" });
const advisory = compile({ ...loadDefault(), failOn: "never" });
const SQLite = (() => {
  try { return createRequire(import.meta.url)("node:sqlite").DatabaseSync; }
  catch { return undefined; }
})();

function call(name: string, args: Record<string, unknown>) {
  return { conversationId: "synthetic", workspacePaths: [root], toolCall: { name, args } };
}

describe("Antigravity native tool hooks", () => {
  it("launches generated tool and chat hooks from the native configuration directory", () => {
    const repository = resolve(".");
    init({ root, agents: [antigravity] });
    mkdirSync(resolve(root, "node_modules"));
    symlinkSync(repository, resolve(root, "node_modules/plain-english"), "junction");
    writeFileSync(resolve(root, ".plain-english.yml"), "version: 1\nextends: default\nfailOn: error\nchat:\n  failOn: error\n");
    const transcriptPath = resolve(root, "transcript_full.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: bad }));
    const hooks = JSON.parse(readFileSync(resolve(root, ".agents/hooks.json"), "utf8"));
    for (const [command, payload, expected] of [
      [hooks["plain-english-docs"].PreToolUse[0].hooks[0].command, call("write_to_file", { TargetFile: resolve(root, "doc.md"), CodeContent: bad }), "deny"],
      [hooks["plain-english-chat"].Stop[0].command, { conversationId: "generated-runner", workspacePaths: [root], transcriptPath, fullyIdle: true }, "continue"],
    ] as const) {
      const result = spawnSync(command, {
        cwd: resolve(root, ".agents"), input: JSON.stringify(payload), encoding: "utf8", shell: true,
        env: { ...process.env, PLAIN_ENGLISH_CHAT_JUDGE: "1" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision).toBe(expected);
    }
  });

  it.skipIf(process.platform === "win32")("runs docs and chat checks without requiring a second agent's credentials", () => {
    const bin = resolve(root, "bin");
    mkdirSync(bin);
    const marker = resolve(root, "judge-called");
    writeFileSync(resolve(bin, "claude"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); console.log('{"ok":true}');`, { mode: 0o755 });
    const env = { ...process.env, PATH: bin + delimiter + process.env["PATH"] };
    delete env["PLAIN_ENGLISH_CHAT_JUDGE"];
    writeFileSync(resolve(root, ".plain-english.yml"), "version: 1\nextends: default\nfailOn: error\nchat:\n  failOn: error\n");
    const path = resolve(root, "transcript_full.jsonl");
    writeFileSync(path, JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "The cache expires hourly. ".repeat(100) }));
    const cli = resolve("dist/cli.js");
    for (const [channel, payload] of [
      ["docs", call("write_to_file", { TargetFile: resolve(root, "clean.md"), CodeContent: "The cache expires hourly." })],
      ["chat", { conversationId: "no-judge", workspacePaths: [root], transcriptPath: path, fullyIdle: true }],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, "hook", channel, "--agent", "antigravity"], {
        cwd: root, input: JSON.stringify(payload), encoding: "utf8", env,
      });
      expect(result.status).toBe(0);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("reads only replacement text from both edit tools", () => {
    for (const [name, args] of [
      ["replace_file_content", { TargetContent: bad, ReplacementContent: "The cache expires." }],
      ["multi_replace_file_content", { ReplacementChunks: [
        { TargetContent: bad, ReplacementContent: "The cache expires." },
        { TargetContent: "Old text", ReplacementContent: "It retries once." },
      ] }],
    ] as const) {
      const event = antigravity.parse(call(name, { TargetFile: resolve(root, "doc.md"), ...args }));
      expect(decide(event, "docs", { projectDir: root, ruleSet: strict }).allow).toBe(true);
    }
    const edited = antigravity.parse(call("multi_replace_file_content", {
      TargetFile: resolve(root, "doc.md"), ReplacementChunks: [
        { ReplacementContent: "The cache expires." }, { ReplacementContent: bad },
      ],
    }));
    expect(decide(edited, "docs", { projectDir: root, ruleSet: strict }).allow).toBe(false);
  });

  it("uses the shell working directory and checks commit text", () => {
    const event = antigravity.parse(call("run_command", { Cwd: resolve(root, "sub"), CommandLine: `git commit -m '${bad}'` }));
    expect(event.cwd).toBe(resolve(root, "sub"));
    const decision = decide(event, "github", { projectDir: root, ruleSet: strict });
    expect(JSON.parse(antigravity.emit(decision, "pre").stdout).decision).toBe("deny");
  });

  it("asks for an advisory write and denies a strict write", () => {
    const event = antigravity.parse(call("write_to_file", { TargetFile: resolve(root, "doc.md"), CodeContent: bad }));
    for (const [ruleSet, expected] of [[advisory, "ask"], [strict, "deny"]] as const) {
      const decision = decide(event, "docs", { projectDir: root, ruleSet });
      const output = JSON.parse(antigravity.emit(decision, "pre").stdout);
      expect(output.decision).toBe(expected);
      expect(output.reason).toContain("leverage");
    }
  });

  it("checks issue fields and detects its own envelope", () => {
    const payload = call("mcp_linear_save_issue", { title: bad, description: "The cache expires." });
    expect(resolveProfile(undefined, payload, {}).id).toBe("antigravity");
    expect(decide(antigravity.parse(payload), "issue", { projectDir: root, ruleSet: strict }).allow).toBe(false);
  });

  it("checks native MCP issue and comment arguments without linting unrelated calls", () => {
    for (const [ToolName, Arguments] of [
      ["save_issue", { title: bad, description: "The cache expires." }],
      ["save_comment", { body: bad }],
      ["mcp_linear_save_issue", { title: "A title", description: bad }],
    ] as const) {
      const payload = call("call_mcp_tool", { ServerName: "audit", ToolName, Arguments });
      const decision = decide(antigravity.parse(payload), "issue", { projectDir: root, ruleSet: strict });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain("leverage");
    }
    for (const ToolName of ["search_issues", "save_file", "save_issue_preview"]) {
      const payload = call("call_mcp_tool", { ServerName: "audit", ToolName, Arguments: { title: bad } });
      expect(decide(antigravity.parse(payload), "issue", { projectDir: root, ruleSet: strict }).allow).toBe(true);
    }
    const issueHooks = antigravity.plan({ prompts: {}, model: "audit" }).config.find((entry) => entry.at[0] === "plain-english-issue");
    expect(new RegExp(issueHooks!.entries[0]!.matcher).test("call_mcp_tool")).toBe(true);
  });

  it("preserves other named hooks and remains unchanged on a second installation", () => {
    mkdirSync(resolve(root, ".agents"));
    const path = resolve(root, ".agents/hooks.json");
    const foreign = { PreToolUse: [{ matcher: "run_command", hooks: [{ command: "./other-check.sh" }] }] };
    writeFileSync(path, JSON.stringify({ "other-check": foreign }));
    init({ root, agents: [antigravity] });
    const first = readFileSync(path, "utf8");
    expect(JSON.parse(first)["other-check"]).toEqual(foreign);
    expect(JSON.parse(first)["plain-english-docs"].PreToolUse[0].hooks[0].command).toContain("--agent antigravity");
    init({ root, agents: [antigravity] });
    expect(readFileSync(path, "utf8")).toBe(first);
  });
});

describe("Antigravity native transcripts", () => {
  function transcript(records: Record<string, unknown>[]) {
    const path = resolve(root, "transcript_full.jsonl");
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n{partial");
    return { transcriptPath: path, conversationId: "conversation", fullyIdle: true, terminationReason: "NO_TOOL_CALL" };
  }
  const ask = (index: number) => ({ step_index: index, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: "Repeat the same request." });
  const reply = (index: number, content: string) => ({ step_index: index, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content });

  it("reads the latest completed step without thoughts, tools, injected messages, or partial records", () => {
    const payload = transcript([
      ask(0), reply(1, "Old response."), reply(1, "Corrected response."),
      { ...reply(2, "Hidden reasoning."), type: "THINKING" },
      { ...reply(3, "Injected feedback."), source: "SYSTEM" },
      { ...reply(4, "Tool result."), type: "RUN_COMMAND" },
      { ...reply(5, "Partial response."), status: "RUNNING" },
    ]);
    expect(antigravityChat.current(payload)?.text).toBe("Corrected response.");
    expect(antigravityChat.lastAsk!(payload)).toBe("Repeat the same request.");
  });

  it("keeps retries in the same turn but repeated user requests in distinct turns", () => {
    const first = transcript([ask(0), reply(1, "First reply.")]);
    expect(antigravityChat.turnId!(first)).toBe("conversation:0");
    const retry = transcript([ask(0), reply(1, "First reply."), { step_index: 2, type: "EPHEMERAL_MESSAGE", source: "SYSTEM", content: "Rewrite." }, reply(3, "Retry reply.")]);
    expect(antigravityChat.turnId!(retry)).toBe("conversation:0");
    const next = transcript([ask(0), reply(1, "First reply."), ask(4)]);
    expect(antigravityChat.turnId!(next)).toBe("conversation:4");
    expect(antigravityChat.current(next)).toBeNull();
  });

  it("does not restart a busy, cancelled, or failed execution", () => {
    const payload = transcript([ask(0), reply(1, "A reply.")]);
    expect(antigravityChat.current({ ...payload, fullyIdle: false })).toBeNull();
    expect(antigravityChat.current({ ...payload, error: "Execution failed." })).toBeNull();
    expect(antigravityChat.current({ ...payload, terminationReason: "MAX_STEPS_EXCEEDED" })).toBeNull();
  });

  it("reports a missing history index rather than claiming an empty clean history", () => {
    const previous = process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"];
    process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"] = root;
    try {
      const [result] = readAll([antigravityChat], {});
      expect(result?.unavailable).toContain("no Antigravity conversation index");
    } finally {
      if (previous === undefined) delete process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"];
      else process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"] = previous;
    }
  });

  it.skipIf(!SQLite)("reads the active database log, scopes by path segments, and counts each transcript once", () => {
    const previous = process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"];
    process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"] = root;
    const db = new SQLite(resolve(root, "conversation_summaries.db"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)");
      const wanted = resolve(root, "repo");
      const insert = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)");
      for (const [session, cwd, parent] of [
        ["main", wanted, ""], ["child", resolve(wanted, "sub"), "main"], ["neighbor", wanted + "-other", ""],
      ]) {
        insert.run(session, JSON.stringify([pathToFileURL(cwd!).href]), parent, parent ? 1 : 0);
        const dir = resolve(root, "brain", session!, ".system_generated", "logs");
        mkdirSync(dir, { recursive: true });
        const records = [ask(0), reply(1, `${session} reply.`)];
        for (const name of ["transcript.jsonl", "transcript_full.jsonl"]) {
          writeFileSync(resolve(dir, name), records.map((record) => JSON.stringify(record)).join("\n"));
        }
      }
      expect(antigravityChat.available()).toEqual({ ok: true });
      const found = antigravityChat.read({ cwd: wanted });
      expect(found.map((item) => item.session).sort()).toEqual(["child", "main"]);
      expect(found.find((item) => item.session === "child")?.isSubagent).toBe(true);
      expect(found.find((item) => item.session === "main")?.isSubagent).toBe(false);
    } finally {
      db.close();
      if (previous === undefined) delete process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"];
      else process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"] = previous;
    }
  });
});
