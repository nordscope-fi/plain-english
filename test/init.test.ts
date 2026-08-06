import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initClaudeCode, mergeSettings } from "../src/init.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "plain-english-init-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settings(): Record<string, any> {
  return JSON.parse(readFileSync(resolve(root, ".claude/settings.json"), "utf8"));
}

/** A settings file that already carries unrelated hooks, as a real repo would. */
function seedExistingSettings(): void {
  mkdirSync(resolve(root, ".claude"), { recursive: true });
  writeFileSync(
    resolve(root, ".claude/settings.json"),
    JSON.stringify(
      {
        model: "claude-sonnet-5",
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/ticket-gate.sh" }],
            },
            {
              matcher: "Write|Edit",
              hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/other-guard.sh" }],
            },
          ],
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "./post.sh" }] }],
        },
      },
      null,
      2,
    ),
  );
}

describe("init", () => {
  it("creates hooks, settings and a starter config in an empty repo", () => {
    expect(initClaudeCode({ root })).toBe(0);
    const s = settings();
    expect(s["hooks"].PreToolUse).toHaveLength(3);
    for (const f of [
      ".claude/hooks/plain-english-docs.sh",
      ".claude/hooks/plain-english-github.sh",
      ".claude/hooks/plain-english-issue.sh",
      ".plain-english.yml",
    ]) {
      expect(statSync(resolve(root, f)).isFile(), `${f} missing`).toBe(true);
    }
  });

  it("makes the shims executable", () => {
    initClaudeCode({ root });
    const path = resolve(root, ".claude/hooks/plain-english-docs.sh");

    // NTFS has no POSIX permission bits, and Node's chmod on Windows only
    // touches the read-only flag, so the exec bit is always 0 there. The shim
    // is a shell script that Windows runs through a shell regardless.
    if (process.platform === "win32") {
      expect(statSync(path).isFile()).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("plain-english hook docs");
      return;
    }

    expect(statSync(path).mode & 0o111, "shim is not executable").toBeGreaterThan(0);
  });

  it("preserves unrelated hooks under a matcher it also uses", () => {
    seedExistingSettings();
    initClaudeCode({ root });
    const s = settings();

    const bash = s["hooks"].PreToolUse.find((b: any) => b.matcher === "Bash");
    const commands = bash.hooks.map((h: any) => h.command ?? "").join(" ");
    expect(commands, "the pre-existing gate was dropped").toContain("ticket-gate.sh");
    expect(commands).toContain("plain-english-github.sh");
  });

  it("preserves unrelated top-level keys and other hook events", () => {
    seedExistingSettings();
    initClaudeCode({ root });
    const s = settings();
    expect(s["model"]).toBe("claude-sonnet-5");
    expect(s["permissions"].allow).toEqual(["Bash(npm test)"]);
    expect(s["hooks"].PostToolUse).toHaveLength(1);
  });

  it("is idempotent", () => {
    seedExistingSettings();
    initClaudeCode({ root });
    const first = readFileSync(resolve(root, ".claude/settings.json"), "utf8");
    initClaudeCode({ root });
    const second = readFileSync(resolve(root, ".claude/settings.json"), "utf8");
    expect(second).toBe(first);
  });

  it("replaces its own entries on re-run instead of stacking them", () => {
    initClaudeCode({ root });
    initClaudeCode({ root });
    initClaudeCode({ root });
    const s = settings();
    const bash = s["hooks"].PreToolUse.find((b: any) => b.matcher === "Bash");
    expect(bash.hooks.filter((h: any) => h.type === "command")).toHaveLength(1);
    expect(bash.hooks.filter((h: any) => h.type === "prompt")).toHaveLength(1);
  });

  it("does not overwrite an existing project config", () => {
    writeFileSync(resolve(root, ".plain-english.yml"), "version: 1\nextends: default\nallow: [mine]\n");
    initClaudeCode({ root });
    expect(readFileSync(resolve(root, ".plain-english.yml"), "utf8")).toContain("mine");
  });

  it("refuses to touch a settings file that is not valid JSON", () => {
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(resolve(root, ".claude/settings.json"), "{ not json");
    expect(initClaudeCode({ root })).toBe(2);
    expect(readFileSync(resolve(root, ".claude/settings.json"), "utf8")).toBe("{ not json");
  });

  it("writes nothing on a dry run", () => {
    expect(initClaudeCode({ root, dryRun: true })).toBe(0);
    expect(() => statSync(resolve(root, ".claude/settings.json"))).toThrow();
    expect(() => statSync(resolve(root, ".plain-english.yml"))).toThrow();
  });

  it("substitutes the project directory into the prompt", () => {
    initClaudeCode({ root });
    const s = settings();
    const docs = s["hooks"].PreToolUse.find((b: any) => b.matcher.includes("Write"));
    const prompt = docs.hooks.find((h: any) => h.type === "prompt").prompt;
    expect(prompt).toContain(root);
    expect(prompt).not.toContain("{{PROJECT_DIR}}");
  });
});

describe("mergeSettings", () => {
  it("appends a new matcher without disturbing existing ones", () => {
    const existing = {
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "a.sh" }] }] },
    };
    const { settings: out, added } = mergeSettings(existing, [
      { matcher: "Bash", hooks: [{ type: "command", command: "plain-english x" }] },
    ]);
    expect(out.hooks!.PreToolUse).toHaveLength(2);
    expect(added).toEqual(["Bash"]);
    expect(out.hooks!.PreToolUse![0]!.matcher).toBe("Read");
  });

  it("works on a settings object with no hooks at all", () => {
    const { settings: out } = mergeSettings({ model: "x" }, [
      { matcher: "Bash", hooks: [{ type: "command", command: "plain-english x" }] },
    ]);
    expect(out["model"]).toBe("x");
    expect(out.hooks!.PreToolUse).toHaveLength(1);
  });
});
