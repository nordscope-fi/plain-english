import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decide, toHookOutput } from "../src/adapters/claude-hook.ts";
import { compile, loadDefault, type RuleSet } from "../src/rules.ts";
import { initClaudeCode } from "../src/init.ts";
import { readFileSync } from "node:fs";

const EM = "—";
const advisory: RuleSet = compile({ ...loadDefault(), failOn: "never" });
const strict: RuleSet = compile({ ...loadDefault(), failOn: "error" });

function docsWrite(dir: string, content: string) {
  return {
    tool_name: "Write",
    tool_input: { file_path: resolve(dir, "x.md"), content },
  };
}

describe("advisory is the default", () => {
  it("the built-in ruleset does not block", () => {
    expect(loadDefault().failOn).toBe("never");
  });

  it("asks instead of denying", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-dec-"));
    const d = decide(docsWrite(dir, `a ${EM} b`), "docs", {
      projectDir: dir,
      ruleSet: advisory,
    });
    expect(d.allow).toBe(false);
    expect(d.decision).toBe("ask");
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits permissionDecision ask in the hook payload", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-dec-"));
    const out = toHookOutput(
      decide(docsWrite(dir, `a ${EM} b`), "docs", { projectDir: dir, ruleSet: advisory }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(EM);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("strict mode is opt-in", () => {
  it("denies when failOn is error", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-dec-"));
    const d = decide(docsWrite(dir, `a ${EM} b`), "docs", {
      projectDir: dir,
      ruleSet: strict,
    });
    expect(d.decision).toBe("deny");
    expect(JSON.parse(toHookOutput(d)).hookSpecificOutput.permissionDecision).toBe("deny");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("clean text stays out of the way", () => {
  it("emits nothing at all", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-dec-"));
    const d = decide(docsWrite(dir, "The cache holds parsed results."), "docs", {
      projectDir: dir,
      ruleSet: advisory,
    });
    expect(d.decision).toBe("allow");
    expect(toHookOutput(d)).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("init emits permission-rule scoping", () => {
  it("scopes the docs hook to markdown with an if rule", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-init-if-"));
    initClaudeCode({ root: dir });
    const settings = JSON.parse(readFileSync(resolve(dir, ".claude/settings.json"), "utf8"));
    const docs = settings.hooks.PreToolUse.find((b: { matcher: string }) =>
      b.matcher.includes("Write"),
    );
    const cmd = docs.hooks.find((h: { type: string }) => h.type === "command");
    expect(cmd.if, "docs hook is not scoped, so it fires on every source file").toContain(
      "Write(*.md)",
    );

    // Bash and issue channels are not path-scoped: there is no file to scope on.
    const bash = settings.hooks.PreToolUse.find((b: { matcher: string }) => b.matcher === "Bash");
    expect(bash.hooks.find((h: { type: string }) => h.type === "command").if).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a starter config that names the default", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-init-cfg-"));
    initClaudeCode({ root: dir });
    const cfg = readFileSync(resolve(dir, ".plain-english.yml"), "utf8");
    expect(cfg).toContain("failOn: never");
    rmSync(dir, { recursive: true, force: true });
  });
});
