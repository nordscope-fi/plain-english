import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DOCS_MAX_JUDGE_BYTES, overDocsJudgeLimit } from "../src/adapters/judge.ts";
import { renderPrompts } from "../src/render.ts";
import { compile, loadDefault } from "../src/rules.ts";

/**
 * The docs semantic gate, run through the built CLI.
 *
 * The gate used to be a harness `prompt` hook that sent the whole file to a
 * model, so a large markdown file failed with `Prompt is too long` and the
 * write surfaced as a permission prompt. It is now the `hook docs`
 * command, which reads the payload first and declines the model call when it is
 * over the size threshold. These run the real binary with a stub `claude` on
 * PATH, because a unit test that never spawns the child proved nothing about the
 * thing that overflowed.
 */
const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

// Clean text, repeated. No banned term, so the deterministic pass allows and the
// judge is what decides. One line is well under the threshold; 6000 copies are
// over it.
const CLEAN_LINE = "The cache holds parsed results for an hour.\n";

let dir: string;
let binDir: string;
let sentinel: string;

/** A fake `claude` that records it ran and prints one verdict. */
function stubClaude(verdict: string): void {
  const path = resolve(binDir, "claude");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${sentinel}"\nprintf '%s' '${verdict}'\n`, "utf8");
  chmodSync(path, 0o755);
}

function payload(content: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    cwd: dir,
    tool_input: { file_path: resolve(dir, "note.md"), content },
  });
}

function runHook(input: string, opts: { withClaude: boolean; agent?: string; channel?: string; extraEnv?: NodeJS.ProcessEnv; event?: string }): { stdout: string; called: boolean } {
  try {
    rmSync(sentinel);
  } catch {
    /* absent is the starting state */
  }
  // A controlled PATH, so the test never spawns the machine's real `claude`.
  // Absent means the one directory holding the stub is left out.
  const PATH = opts.withClaude ? `${binDir}:${process.env.PATH}` : binDir;
  const withClaudeStubRemoved = !opts.withClaude;
  if (withClaudeStubRemoved) {
    try {
      rmSync(resolve(binDir, "claude"));
    } catch {
      /* already gone */
    }
  }
  const stdout = execFileSync(process.execPath, [CLI, "hook", opts.channel ?? "docs", "--agent", opts.agent ?? "claude-code", ...(opts.event ? ["--event", opts.event] : [])], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: { ...process.env, PLAIN_ENGLISH_VIBE_JUDGE: "0", ...opts.extraEnv, PATH, NO_COLOR: "1" },
  });
  let called = false;
  try {
    statSync(sentinel);
    called = true;
  } catch {
    /* never ran */
  }
  return { stdout, called };
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "pe-docs-judge-"));
  binDir = mkdtempSync(resolve(tmpdir(), "pe-docs-bin-"));
  sentinel = resolve(binDir, "called");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(resolve(dir, ".plain-english.yml"), { force: true });
  stubClaude('{"ok": true}');
});

describe("the docs command hook judges below the size threshold and skips above it", () => {
  it("passes a large file on its size alone, with no model call", () => {
    stubClaude('{"ok": false, "reason": "Lead with the point."}');
    const big = CLEAN_LINE.repeat(6000); // over 256 KB
    const { stdout, called } = runHook(payload(big), { withClaude: true });
    expect(called).toBe(false);
    expect(stdout).toBe("");
  });

  // The judge spawns a bare-named `claude` with no shell, which Windows cannot
  // resolve to a script. The real judge fails open there for the same reason,
  // exactly as the chat judge does, so the cases that need the judge to have
  // run are POSIX-only.
  const judgeRuns = it.skipIf(process.platform === "win32");

  judgeRuns("judges a small file, and a refusal reaches the write as a reason", () => {
    stubClaude('{"ok": false, "reason": "Lead with the point."}');
    const { stdout, called } = runHook(payload(CLEAN_LINE), { withClaude: true });
    expect(called).toBe(true);
    expect(stdout).toContain("Lead with the point.");
  });

  judgeRuns("does not request a model when the project chooses local-only checks", () => {
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\n");
    const { stdout, called } = runHook(payload(CLEAN_LINE), { withClaude: true });
    expect(called).toBe(false);
    expect(stdout).toBe("");
  });

  judgeRuns("does not disclose an excluded document to the model", () => {
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nexclude: [note.md]\n");
    const { stdout, called } = runHook(payload(CLEAN_LINE), { withClaude: true });
    expect(called).toBe(false);
    expect(stdout).toBe("");
  });

  judgeRuns("keeps outside-project and reference files out of model requests", () => {
    for (const filePath of [resolve(dir, "..", "outside.md"), resolve(dir, "CLAUDE.md"), resolve(dir, "docs", "writing-style.md")]) {
      const input = JSON.parse(payload(CLEAN_LINE));
      input.tool_input.file_path = filePath;
      expect(runHook(JSON.stringify(input), { withClaude: true }).called, filePath).toBe(false);
    }
  });

  judgeRuns("discloses only the eligible file in a mixed patch", () => {
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nexclude: [secret.md]\n");
    const input = JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir,
      tool_input: { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: note.md\n+" + CLEAN_LINE.trim() + "\n*** Add File: secret.md\n+PRIVATE_CONTENT_DO_NOT_DISCLOSE\n*** End Patch\nPATCH" },
    });
    expect(runHook(input, { withClaude: true }).called).toBe(true);
    const request = readFileSync(sentinel, "utf8");
    expect(request).toContain(CLEAN_LINE.trim());
    expect(request).not.toContain("PRIVATE_CONTENT_DO_NOT_DISCLOSE");
    expect(request).not.toContain("secret.md");
  });

  judgeRuns("uses project-relative document names without disclosing the project directory", () => {
    expect(runHook(payload(CLEAN_LINE), { withClaude: true }).called).toBe(true);
    const request = readFileSync(sentinel, "utf8");
    expect(request).toContain('"path":"note.md"');
    expect(request).not.toContain(dir);
    expect(request).not.toContain('"cwd":');
  });

  judgeRuns("disables tools and saved background conversations", () => {
    expect(runHook(payload(CLEAN_LINE), { withClaude: true }).called).toBe(true);
    const request = readFileSync(sentinel, "utf8").split("\n");
    expect(request).toContain("--no-session-persistence");
    expect(request).toContain("--safe-mode");
    expect(request).toContain("--tools");
    expect(request[request.indexOf("--tools") + 1]).toBe("");
  });

  judgeRuns("does not invoke Claude for another agent's chat unless explicitly enabled", () => {
    const text = Array.from({ length: 65 }, (_, i) => `Point ${i} is settled.`).join(" ");
    const input = JSON.stringify({ hook_event_name: "Stop", cwd: dir, last_assistant_message: text, turn_id: "model-default-other-agent" });
    const local = runHook(input, { withClaude: true, agent: "codex", channel: "chat" });
    expect(local.called).toBe(false);
    expect(local.stdout).toContain("reply-length");
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: true\n");
    const optedIn = runHook(input, { withClaude: true, agent: "codex", channel: "chat" });
    expect(optedIn.called).toBe(true);
    expect(optedIn.stdout).toBe("");
  });

  judgeRuns("routes GitHub semantic checks through the runtime local-only setting", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse", cwd: dir, tool_name: "Bash",
      tool_input: { command: 'git commit -m "Fix the cache expiry"' },
    });
    expect(runHook(input, { withClaude: true, channel: "github" }).called).toBe(true);
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\n");
    expect(runHook(input, { withClaude: true, channel: "github" }).called).toBe(false);
  });

  judgeRuns("keeps Vibe's model checks opt-in and lets false override its environment", () => {
    const fake = readFileSync(resolve(binDir, "claude"), "utf8");
    writeFileSync(resolve(binDir, "vibe"), fake + `\nprintf 'VIBE_INCLUDE_PROJECT_CONTEXT=%s\\n' "$VIBE_INCLUDE_PROJECT_CONTEXT" >> "${sentinel}"\nprintf 'VIBE_SYSTEM_PROMPT_ID=%s\\n' "$VIBE_SYSTEM_PROMPT_ID" >> "${sentinel}"\n`);
    chmodSync(resolve(binDir, "vibe"), 0o755);
    expect(runHook(payload(CLEAN_LINE), { withClaude: true, agent: "vibe", event: "post" }).called).toBe(false);
    const optIn = { withClaude: true, agent: "vibe", event: "post", extraEnv: { PLAIN_ENGLISH_VIBE_JUDGE: "1" } };
    expect(runHook(payload(CLEAN_LINE), optIn).called).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toContain("VIBE_INCLUDE_PROJECT_CONTEXT=false");
    expect(readFileSync(sentinel, "utf8")).toContain("VIBE_SYSTEM_PROMPT_ID=minimal");
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\n");
    expect(runHook(payload(CLEAN_LINE), optIn).called).toBe(false);
  });

  judgeRuns("does not restore automatic model calls when configuration cannot be loaded", () => {
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\nchat:\n  failOn: invalid\n");
    const { called } = runHook(payload(CLEAN_LINE), { withClaude: true });
    expect(called).toBe(false);
  });

  judgeRuns("keeps invalid chat configuration from restoring automatic model calls", () => {
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\nchat:\n  failOn: invalid\n");
    const text = Array.from({ length: 65 }, (_, i) => `Point ${i} is settled.`).join(" ");
    const input = JSON.stringify({ hook_event_name: "Stop", cwd: dir, last_assistant_message: text, prompt_id: "invalid-config-turn" });
    const result = runHook(input, { withClaude: true, channel: "chat" });
    expect(result.called).toBe(false);
    expect(result.stdout).not.toContain('"decision":"block"');
  });

  judgeRuns("lets a small file through when the judge passes it", () => {
    stubClaude('{"ok": true}');
    const { stdout, called } = runHook(payload(CLEAN_LINE), { withClaude: true });
    expect(called).toBe(true);
    expect(stdout).toBe("");
  });

  it("fails open when claude is absent, and the deterministic pass still catches a banned term", () => {
    const clean = runHook(payload(CLEAN_LINE), { withClaude: false });
    expect(clean.stdout).toBe("");
    const banned = runHook(payload("We leverage a seamless paradigm shift.\n"), {
      withClaude: false,
    });
    expect(banned.stdout).toContain("leverage");
  });
});

describe("the docs size guard and the prompt it fills", () => {
  it("skips only above the threshold, not at it", () => {
    expect(overDocsJudgeLimit("a".repeat(DOCS_MAX_JUDGE_BYTES))).toBe(false);
    expect(overDocsJudgeLimit("a".repeat(DOCS_MAX_JUDGE_BYTES + 1))).toBe(true);
  });

  it("keeps raw-input templates compatible with native Vibe checks", () => {
    const prompts = renderPrompts(compile(loadDefault()));
    expect(prompts.docs).toContain("tool_input.file_path");
    expect(prompts.github).toContain("tool_input.command");
    expect(prompts.issue).toContain("tool_input.title");
  });

  it("publishing prompts judge extracted text without reading tool arguments", () => {
    const prompts = renderPrompts(compile(loadDefault()), "prose");
    for (const channel of ["github", "issue"]) {
      expect(prompts[channel]).toContain("texts");
      expect(prompts[channel]).not.toContain("tool_input");
    }
  });

  it("keeps the payload slot and the project-dir placeholder the hook resolves", () => {
    const prompt = renderPrompts(compile(loadDefault()), "prose")["docs"];
    expect(prompt).toContain("$ARGUMENTS");
    expect(prompt).toContain("files");
    expect(prompt).toContain("changedRanges");
    expect(prompt).not.toContain("tool_input.file_path");
    expect(prompt).toContain("project-relative path");
    expect(prompt).not.toContain("{{PROJECT_DIR}}");
  });
});
