import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { geminiChat, geminiHome } from "../src/chat/gemini.ts";
import { cursorChat } from "../src/chat/cursor.ts";
import { chatTurnId } from "../src/chat/turn.ts";
import { init } from "../src/init.ts";
import { byId } from "../src/agents/registry.ts";
import { compile, loadDefault } from "../src/rules.ts";
import { decide, formatReason } from "../src/adapters/hook.ts";
import { lintText } from "../src/lint.ts";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const bad = "The result is ready \u2014 check it.";
const strict = compile({ ...loadDefault(), failOn: "error" });
let root: string;
const restore = new Map<string, string | undefined>();
function setEnv(key: string, value: string) {
  if (!restore.has(key)) restore.set(key, process.env[key]);
  process.env[key] = value;
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(resolve(tmpdir(), "pe-integration-regression-")));
  writeFileSync(resolve(root, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\nfailOn: error\nchat:\n  failOn: error\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of restore) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  restore.clear();
});
function jsonl(records: object[]) { return records.map((record) => JSON.stringify(record)).join("\n") + "\n"; }
it.each([
  ["cursor", ".cursor/hooks.json", "preToolUse"],
  ["gemini", ".gemini/settings.json", "BeforeTool"],
  ["qwen", ".qwen/settings.json", "PreToolUse"],
  ["codex", ".codex/hooks.json", "PreToolUse"],
])("preserves a separately owned package-named hook on %s across reinstallations", (agent, path, event) => {
  const foreign = { name: "plain-english-docs", type: "command", command: "node custom/hooks/plain-english.mjs" };
  const file = resolve(root, path!); mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks: { [event!]: agent === "cursor" ? [foreign] : [{ matcher: "*", hooks: [foreign] }] } }));
  for (let i = 0; i < 2; i++) {
    expect(init({ root, agents: [byId(agent!)!] })).toBe(0);
    const config = JSON.parse(readFileSync(file, "utf8"));
    const entries = agent === "cursor" ? config.hooks[event!] : config.hooks[event!].flatMap((group: { hooks: object[] }) => group.hooks);
    expect(entries.filter((entry: { command: string }) => entry.command === foreign.command)).toEqual([foreign]);
  }
});
function hook(agent: string, payload: object, cwd = root) {
  const env = { ...process.env, PLAIN_ENGLISH_CHAT_JUDGE: "1", PLAIN_ENGLISH_VIBE_JUDGE: "0" };
  delete env["CLAUDE_PROJECT_DIR"];
  const out = spawnSync(process.execPath, [CLI, "hook", "chat", "--agent", agent], {
    cwd, env, input: JSON.stringify(payload), encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  const response = out.stdout ? JSON.parse(out.stdout) : {};
  return Boolean(response.followup_message || ["block", "deny", "continue"].includes(response.decision));
}

describe("native chat turn regressions through the built CLI", () => {
  it("checks both Cursor generations and bounds a generation-changing retry", () => {
    const transcript = resolve(root, "cursor.jsonl");
    writeFileSync(transcript, jsonl([{ role: "assistant", message: { content: [{ type: "text", text: bad }] } }]));
    const other = resolve(root, "process-directory"); mkdirSync(other);
    const payload = { workspace_roots: [root], conversation_id: root, generation_id: "first", loop_count: 0,
      hook_event_name: "stop", transcript_path: transcript };
    expect(hook("cursor", payload, other)).toBe(true);
    expect(hook("cursor", { ...payload, generation_id: "rewrite", loop_count: 1 }, other)).toBe(false);
    expect(hook("cursor", { ...payload, generation_id: "second" }, other)).toBe(true);
    expect(hook("cursor", { ...payload, conversation_id: "another-session", generation_id: "second" }, other)).toBe(true);
  });

  it.each(["cursor", "gemini", "copilot", "vibe"])("checks identical repeated %s requests using explicit user records", (agent) => {
    const transcript = resolve(root, agent + ".jsonl");
    const records = (n: number): object[] => agent === "cursor" ? [
      { role: "user", id: `user-${n}`, message: { content: "Repeat the requested sentence." } },
      { role: "assistant", message: { content: [{ type: "text", text: bad }] } },
    ] : agent === "gemini" ? [
      { type: "user", id: `user-${n}`, content: "Repeat the requested sentence." },
      { type: "gemini", id: `reply-${n}`, content: bad },
    ] : agent === "copilot" ? [
      { type: "user.message", data: { content: "Repeat the requested sentence." } },
      { type: "assistant.message", data: { content: bad } },
    ] : [
      { role: "user", message_id: `user-${n}`, injected: false, content: "Repeat the requested sentence." },
      { role: "assistant", content: bad },
    ];
    writeFileSync(transcript, jsonl(records(1)));
    const payload = agent === "cursor" ? { workspace_roots: [root], conversation_id: root, agent_transcript_path: transcript, loop_count: 0 } :
      { cwd: root, session_id: root, transcript_path: transcript, prompt_response: bad, stop_hook_active: false };
    expect(hook(agent, payload)).toBe(true);
    appendFileSync(transcript, jsonl(records(2)));
    expect(hook(agent, payload)).toBe(true);
    expect(hook(agent, { ...payload, stop_hook_active: true, loop_count: 1 })).toBe(false);
  });

  it.each(["codex", "qwen"])("keeps %s native identities working", (agent) => {
    const payload = { cwd: root, session_id: root, last_assistant_message: bad };
    const turn = agent === "codex" ? "turn_id" : "prompt_id";
    expect(hook(agent, { ...payload, [turn]: "first" })).toBe(true);
    expect(hook(agent, { ...payload, [turn]: "second" })).toBe(true);
    expect(hook(agent, { ...payload, session_id: "another", [turn]: "second" })).toBe(true);
  });

  it("keeps a Cursor continuation's active identity across new generation IDs", () => {
    const reply = { text: bad, session: root, source: "", line: 1, isSubagent: false };
    const first = chatTurnId({ conversation_id: root, generation_id: "first", loop_count: 0 }, cursorChat, reply, root);
    expect(chatTurnId({ conversation_id: root, generation_id: "rewrite", loop_count: 1 }, cursorChat, reply, root)).toBe(first);
    expect(chatTurnId({ conversation_id: root, generation_id: "second", loop_count: 0 }, cursorChat, reply, root)).not.toBe(first);
  });
});

describe("Gemini logical history", () => {
  function setup(records: object[]) {
    setEnv("GEMINI_CLI_HOME", root);
    const dir = resolve(root, ".gemini/tmp/project/chats"); mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(root, ".gemini/projects.json"), JSON.stringify({ projects: { [root]: "project" } }));
    const path = resolve(dir, "session.jsonl");
    writeFileSync(path, jsonl([{ sessionId: "session", projectHash: "project" }, ...records]));
    return path;
  }
  it("updates messages and removes rewound responses from scans and Stop fallback", () => {
    const path = setup([
      { id: "user", type: "user", content: "Explain the result." },
      { id: "one", type: "gemini", content: "Old response." },
      { id: "one", type: "gemini", content: "The corrected response." },
      { id: "two", type: "gemini", content: bad },
      { $rewindTo: "two" },
    ]);
    expect(geminiChat.read({ cwd: root }).map((r) => r.text)).toEqual(["The corrected response."]);
    expect(geminiChat.current({ transcript_path: path })?.text).toBe("The corrected response.");
    expect(geminiChat.turnId?.({ transcript_path: path })).toContain(":user");
  });
  it("uses retained legacy sessions and whole-history snapshots", () => {
    const path = setup([{ id: "old", type: "gemini", content: bad },
      { $set: { messages: [{ id: "snapshot", type: "gemini", content: "The snapshot response." }] } }]);
    const legacy = resolve(path, "..", "legacy.json");
    writeFileSync(legacy, JSON.stringify({ sessionId: "legacy", projectHash: "project", messages: [
      { id: "legacy-reply", type: "gemini", content: "The legacy response." },
    ] }, null, 2));
    expect(geminiChat.read({ cwd: root }).map((r) => r.text).sort()).toEqual(["The legacy response.", "The snapshot response."]);
    expect(geminiChat.current({ transcript_path: legacy })?.session).toBe("legacy");
  });
  it("does not let hook context or rewound users create a new explicit turn", () => {
    const path = setup([{ id: "first", type: "user", content: "Explain the result." },
      { id: "context", type: "user", content: "<hook_context>Rewrite the answer.</hook_context>" },
      { id: "removed", type: "user", content: "Another question." }, { $rewindTo: "removed" }]);
    expect(geminiChat.turnId?.({ transcript_path: path })).toContain(":first");
    appendFileSync(path, JSON.stringify({ $rewindTo: "unknown" }) + "\n");
    expect(geminiChat.turnId?.({ transcript_path: path })).toBeUndefined();
  });
  it("matches native home semantics even when an override ends in .gemini", () => {
    setEnv("GEMINI_CLI_HOME", resolve(root, ".gemini"));
    expect(geminiHome()).toBe(resolve(root, ".gemini/.gemini"));
  });
});

describe("Cursor project scope", () => {
  it("excludes a sibling prefix and prefers exact session metadata", () => {
    setEnv("CURSOR_HOME", resolve(root, "cursor"));
    // Logical project paths need not exist. Keep the folder-name fixture valid
    // on Windows too, where a physical temporary path contains a drive colon.
    const repo = "/audit/repo";
    const writeTranscript = (cwd: string, id: string, text: string) => {
      const name = cwd.replace(/^\//, "").replace(/[/.]/g, "-");
      const path = resolve(root, "cursor/projects", name, "agent-transcripts", id);
      mkdirSync(path, { recursive: true });
      writeFileSync(resolve(path, id + ".jsonl"), jsonl([{ role: "assistant", message: { content: [{ type: "text", text }] } }]));
    };
    writeTranscript(repo, "inside", "Inside the requested repository.");
    writeTranscript(repo + "-other", "sibling", "From the sibling repository.");
    const meta = resolve(root, "cursor/chats/hash/sibling"); mkdirSync(meta, { recursive: true });
    writeFileSync(resolve(meta, "meta.json"), JSON.stringify({ cwd: repo + "-other" }));
    expect(cursorChat.read({ cwd: repo }).map((r) => r.text)).toEqual(["Inside the requested repository."]);
    writeFileSync(resolve(meta, "meta.json"), JSON.stringify({ cwd: repo + "/child" }));
    expect(cursorChat.read({ cwd: repo })).toHaveLength(2);
  });
});

describe("Gemini guidance installation", () => {
  it.each([undefined, "TEAM.md", ["TEAM.md", "GEMINI.md"]])("preserves configured filenames: %j", (filenames) => {
    const dir = resolve(root, ".gemini"); mkdirSync(dir);
    const settings = resolve(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ context: { fileName: filenames, other: "kept" }, model: { name: "kept" } }));
    init({ root, agents: [byId("gemini")!], ruleSet: strict });
    const first = readFileSync(settings, "utf8");
    const actual = JSON.parse(first);
    expect(actual.context.fileName).toEqual(filenames === undefined ? ["GEMINI.md", "AGENTS.md"] :
      Array.isArray(filenames) ? [...filenames, "AGENTS.md"] : [filenames, "AGENTS.md"]);
    expect(actual.context.other).toBe("kept");
    expect(actual.model.name).toBe("kept");
    init({ root, agents: [byId("gemini")!], ruleSet: strict });
    expect(readFileSync(settings, "utf8")).toBe(first);
  });
});

describe("effective refusal remedies", () => {
  it("offers no document-only remedy for chat or publishing text", () => {
    const finding = lintText("We leverage this.", strict).findings.find((f) => f.ruleId === "leverage")!;
    for (const channel of ["chat", "github", "issue"] as const) {
      const reason = formatReason([finding], channel, undefined, "warn");
      expect(reason).not.toContain("disable-next-line");
      expect(reason).not.toContain("`exclude`");
      expect(reason).toContain("severity: off");
      expect(reason).not.toContain("severity: warn");
    }
  });
  it("permits a downgraded finding only below the effective threshold", () => {
    const event = { tool: "write" as const, cwd: root, input: { filePath: "notes.md", content: "We leverage this." } };
    const warning = compile({ ...loadDefault(), failOn: "error", rules: loadDefault().rules.map((r) => r.id === "leverage" ? { ...r, severity: "warn" } : r) });
    expect(decide(event, "docs", { projectDir: root, ruleSet: warning }).decision).toBe("allow");
    const blocked = decide(event, "docs", { projectDir: root, ruleSet: { ...warning, failOn: "warn" } });
    expect(blocked.decision).toBe("deny");
    expect(blocked.reason).toContain("severity: off");
  });
});
