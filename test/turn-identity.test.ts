import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { codexChat } from "../src/chat/codex.ts";
import { copilotChat } from "../src/chat/copilot.ts";
import { cursorChat } from "../src/chat/cursor.ts";
import { vibeChat } from "../src/chat/vibe.ts";
import { geminiChat } from "../src/chat/gemini.ts";
import { qwenChat } from "../src/chat/qwen.ts";
import { claudeCodeChat } from "../src/chat/claude-code.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("distinguishes new Claude user turns while retaining retries", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-turn-")); dirs.push(dir);
  const path = resolve(dir, "transcript.jsonl");
  const records = [ { type: "user", uuid: "first", message: { content: "Explain the cache." } } ];
  const save = () => writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n"));
  save();
  const payload = { transcript_path: path, session_id: "same-session" };
  const first = claudeCodeChat.turnId?.(payload);
  expect(first).toContain("first");
  records.push({ type: "assistant", uuid: "reply", message: { content: "A reply." } }); save();
  expect(claudeCodeChat.turnId?.(payload)).toBe(first);
  records.push({ type: "user", uuid: "second", message: { content: "Explain the next step." } }); save();
  expect(claudeCodeChat.turnId?.(payload)).not.toBe(first);
});

it.each([
  [codexChat, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Explain." }] } }],
  [copilotChat, { type: "user.message", data: { content: "Explain." } }],
  [cursorChat, { role: "user", message: { content: [{ type: "text", text: "Explain." }] } }],
  [vibeChat, { role: "user", content: "Explain." }],
  [geminiChat, { type: "user", content: "Explain." }],
  [qwenChat, { type: "user", message: { parts: [{ text: "Explain." }] } }],
] as const)("recovers %s turn identity from its user records", (reader, human) => {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-turn-")); dirs.push(dir);
  const path = resolve(dir, "transcript.jsonl");
  writeFileSync(path, JSON.stringify({ ...human, id: "first" }) + "\n");
  const payload = { transcript_path: path, transcriptPath: path };
  const first = reader.turnId?.(payload);
  expect(first).toContain("first");
  writeFileSync(path, JSON.stringify({ ...human, id: "second" }) + "\n", { flag: "a" });
  expect(reader.turnId?.(payload)).not.toBe(first);
});
