import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * ADR-006: when the Claude Code mod starts the CLI with
 * `PLAIN_ENGLISH_MODEL_ROUTE=host`, a model question comes back to the mod as a
 * request instead of starting `claude -p`, and the mod's answer is replayed in.
 * These run the built CLI with a stub `claude` on PATH that records whether it
 * ran, because the point of the route is that it never does.
 */
const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
const CLEAN_LINE = "The cache holds parsed results for an hour.\n";

let dir: string;
let binDir: string;
let sentinel: string;

interface Answer { key: string; text?: string; unavailable?: string; usage?: Record<string, number> }

function payload(content: string, model?: { deadline?: number; answers: Answer[] }): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    cwd: dir,
    tool_input: { file_path: resolve(dir, "note.md"), content },
    ...(model ? { plainEnglishModel: model } : {}),
  });
}

function runHook(input: string, opts: { channel?: string; env?: NodeJS.ProcessEnv } = {}): { stdout: string; stderr: string; called: boolean } {
  rmSync(sentinel, { force: true });
  const ran = spawnSync(process.execPath, [CLI, "hook", opts.channel ?? "docs", "--agent", "claude-code"], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: { ...process.env, PLAIN_ENGLISH_CHAT_JUDGE: "0", PLAIN_ENGLISH_MODEL_ROUTE: "host", PATH: `${binDir}:${process.env.PATH}`, NO_COLOR: "1", ...opts.env },
  });
  expect(ran.status).toBe(0);
  let called = false;
  try { statSync(sentinel); called = true; } catch { /* never ran */ }
  return { stdout: ran.stdout, stderr: ran.stderr, called };
}

function request(stdout: string): { key: string; prompt: string; timeoutMs: number; deadline: number } {
  const parsed = JSON.parse(stdout) as { plainEnglishModelRequest?: { key: string; prompt: string; timeoutMs: number; deadline: number } };
  if (!parsed.plainEnglishModelRequest) throw new Error(`no model request in ${stdout}`);
  return parsed.plainEnglishModelRequest;
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "pe-host-route-"));
  binDir = mkdtempSync(resolve(tmpdir(), "pe-host-bin-"));
  sentinel = resolve(binDir, "called");
  const stub = resolve(binDir, "claude");
  writeFileSync(stub, `#!/bin/sh\ntouch "${sentinel}"\nprintf '%s' '{"ok": true}'\n`, "utf8");
  chmodSync(stub, 0o755);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(resolve(dir, ".plain-english.yml"), { force: true });
});

describe("the host model route for write checks", () => {
  it("hands the question back instead of starting claude", () => {
    const { stdout, called } = runHook(payload(CLEAN_LINE));
    expect(called).toBe(false);
    const asked = request(stdout);
    expect(asked.key).toMatch(/^[a-f0-9]{64}$/);
    expect(asked.prompt).toContain("The cache holds parsed results for an hour.");
    expect(asked.prompt).not.toContain("$ARGUMENTS");
    expect(asked.timeoutMs).toBeGreaterThan(0);
    expect(asked.deadline).toBeGreaterThan(Date.now());
  });

  it("replays a refusal from the mod's answer into the decision", () => {
    const asked = request(runHook(payload(CLEAN_LINE)).stdout);
    const { stdout, called } = runHook(payload(CLEAN_LINE, { deadline: asked.deadline, answers: [
      { key: asked.key, text: '{"ok": false, "reason": "Say how long the results stay valid."}' },
    ] }));
    expect(called).toBe(false);
    expect(stdout).toContain("Say how long the results stay valid.");
    expect(stdout).toContain('"permissionDecision":"ask"');
  });

  it("asks again when an answer belongs to a different question", () => {
    const asked = request(runHook(payload(CLEAN_LINE)).stdout);
    const again = request(runHook(payload(CLEAN_LINE, { deadline: asked.deadline, answers: [
      { key: "0".repeat(64), text: '{"ok": false, "reason": "Wrong question."}' },
    ] })).stdout);
    expect(again.key).toBe(asked.key);
  });

  it("lets the pattern result stand when the mod got no answer, and says so", () => {
    const asked = request(runHook(payload(CLEAN_LINE)).stdout);
    const { stdout, stderr } = runHook(payload(CLEAN_LINE, { deadline: asked.deadline, answers: [{ key: asked.key, unavailable: "timed out" }] }));
    expect(stdout).toBe("");
    expect(stderr).toContain("plain-english: extra model check timed out; pattern checks still apply.");
  });

  it("asks nothing once the deadline the first run fixed has passed", () => {
    const { stdout, called } = runHook(payload(CLEAN_LINE, { deadline: Date.now() - 1, answers: [] }));
    expect(called).toBe(false);
    expect(stdout).toBe("");
  });

  it("records usage for each answer once, though every run replays all of them", () => {
    const receipts = resolve(dir, "receipts.jsonl");
    rmSync(receipts, { force: true });
    const env = { PLAIN_ENGLISH_JUDGE_RECEIPTS: receipts };
    const asked = request(runHook(payload(CLEAN_LINE), { env }).stdout);
    const answers: Answer[] = [{ key: asked.key, text: '{"ok": true}', usage: { input_tokens: 900, output_tokens: 4 } }];
    runHook(payload(CLEAN_LINE, { deadline: asked.deadline, answers }), { env });
    // A later run replays the first answer, which is no longer the newest.
    runHook(payload(CLEAN_LINE, { deadline: asked.deadline, answers: [...answers, { key: "f".repeat(64), text: '{"ok": true}' }] }), { env });
    const finished = readFileSync(receipts, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((receipt) => receipt["phase"] === "finished");
    expect(finished.map((receipt) => receipt["usage"])).toEqual([{ input_tokens: 900, output_tokens: 4 }]);
  });
});

describe("the host model route for reply checks", () => {
  const LONG = "The cache keeps each parsed file for one hour before it reads the disk again. ".repeat(24);
  const stop = (model?: { deadline?: number; answers: Answer[] }) => JSON.stringify({
    hook_event_name: "Stop", session_id: "host-route", cwd: dir, stop_hook_active: false,
    last_assistant_message: LONG, ...(model ? { plainEnglishModel: model } : {}),
  });

  it("asks before it saves any turn state, so a stopped run leaves nothing behind", () => {
    const state = mkdtempSync(resolve(tmpdir(), "pe-host-state-"));
    try {
      const env = { TMPDIR: state };
      const first = request(runHook(stop(), { channel: "chat", env }).stdout);
      expect(readdirSync(state)).toEqual([]);
      const refuse = '{"ok": false, "reason": "Lead with the cache lifetime."}';
      let answers: Answer[] = [{ key: first.key, text: refuse }];
      let out = runHook(stop({ deadline: first.deadline, answers }), { channel: "chat", env }).stdout;
      // A refusal from the readable check is final; a pass would go on to the
      // length check. Either way a second question must also leave no state.
      if (out.includes("plainEnglishModelRequest")) {
        const second = request(out);
        expect(readdirSync(state)).toEqual([]);
        answers = [{ key: first.key, text: '{"ok": true}' }, { key: second.key, text: refuse }];
        out = runHook(stop({ deadline: first.deadline, answers }), { channel: "chat", env }).stdout;
      }
      expect(out).toContain("Lead with the cache lifetime.");
      expect(readdirSync(state).length).toBeGreaterThan(0);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
