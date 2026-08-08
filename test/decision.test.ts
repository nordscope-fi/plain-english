import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ACK_WINDOW_MS, ackPath, decide, hasAck } from "../src/adapters/hook.ts";
import { claudeCode } from "../src/agents/claude-code.ts";
import { compile, loadDefault, type RuleSet } from "../src/rules.ts";
import { init } from "../src/init.ts";
import { readFileSync } from "node:fs";

const EM = "—";
const advisory: RuleSet = compile({ ...loadDefault(), failOn: "never" });
const strict: RuleSet = compile({ ...loadDefault(), failOn: "error" });

/** A Claude Code payload, parsed the way the CLI parses one. */
function docsWrite(dir: string, content: string) {
  return claudeCode.parse({
    tool_name: "Write",
    tool_input: { file_path: resolve(dir, "x.md"), content },
  });
}

const emit = (d: ReturnType<typeof decide>) => claudeCode.emit(d).stdout;

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
    const out = emit(decide(docsWrite(dir, `a ${EM} b`), "docs", { projectDir: dir, ruleSet: advisory }));
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
    expect(JSON.parse(emit(d)).hookSpecificOutput.permissionDecision).toBe("deny");
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
    expect(emit(d)).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("init emits permission-rule scoping", () => {
  it("scopes the docs hook to markdown with an if rule", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-init-if-"));
    init({ root: dir });
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
    init({ root: dir });
    const cfg = readFileSync(resolve(dir, ".plain-english.yml"), "utf8");
    expect(cfg).toContain("failOn: never");
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The refusal message offered an ack file as the last-resort hatch for three
 * releases while nothing read it, so the advice was inert and the only real
 * escape was editing config.
 *
 * It moved out of `.claude/` in 0.4.0, because the message tells a human to
 * `touch` it and `touch` will not create a missing parent directory. The old
 * location is still honoured: somebody who learned the old path should not
 * find it stopped working because the tool grew support for another agent.
 */
describe("the ack file waives a finding", () => {
  const ack = (dir: string) => ackPath("docs", dir);
  const legacyAck = (dir: string) => resolve(dir, ".claude", ".docs-plain-english-ack");

  it("a fresh ack allows the write", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-"));
    writeFileSync(ack(dir), "");
    const d = decide(docsWrite(dir, `a ${EM} b`), "docs", {
      projectDir: dir,
      ruleSet: advisory,
    });
    expect(d.allow).toBe(true);
    expect(d.decision).toBe("allow");
    // The findings are still reported; only the refusal is waived.
    expect(d.findings.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("needs no directory to exist, because the message says to touch it", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-flat-"));
    expect(resolve(ack(dir), "..")).toBe(resolve(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  it("still honours the pre-0.4.0 location", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-legacy-"));
    mkdirSync(resolve(dir, ".claude"), { recursive: true });
    writeFileSync(legacyAck(dir), "");
    expect(hasAck("docs", dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("an expired ack does not", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-old-"));
    writeFileSync(ack(dir), "");
    const stale = new Date(Date.now() - ACK_WINDOW_MS - 1000);
    utimesSync(ack(dir), stale, stale);
    const d = decide(docsWrite(dir, `a ${EM} b`), "docs", {
      projectDir: dir,
      ruleSet: advisory,
    });
    expect(d.allow).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("waives only the channel it names", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-chan-"));
    writeFileSync(ack(dir), "");
    expect(hasAck("docs", dir)).toBe(true);
    expect(hasAck("github", dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing ack waives nothing", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-none-"));
    expect(hasAck("docs", dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("strict mode is waivable too", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-ack-strict-"));
    writeFileSync(ack(dir), "");
    const d = decide(docsWrite(dir, `a ${EM} b`), "docs", {
      projectDir: dir,
      ruleSet: strict,
    });
    expect(d.allow).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
