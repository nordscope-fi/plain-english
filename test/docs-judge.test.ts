import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  writeFileSync(path, `#!/bin/sh\n: > "${sentinel}"\nprintf '%s' '${verdict}'\n`, "utf8");
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

function runHook(input: string, opts: { withClaude: boolean }): { stdout: string; called: boolean } {
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
  const stdout = execFileSync(process.execPath, [CLI, "hook", "docs", "--agent", "claude-code"], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: { ...process.env, PATH, NO_COLOR: "1" },
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
beforeEach(() => stubClaude('{"ok": true}'));

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

  it("keeps the payload slot and the project-dir placeholder the hook resolves", () => {
    const prompt = renderPrompts(compile(loadDefault()))["docs"];
    expect(prompt).toContain("$ARGUMENTS");
    expect(prompt).toContain("{{PROJECT_DIR}}");
  });
});
