import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decide, formatReason, scopedDocsFiles } from "../src/adapters/hook.ts";
import { codex } from "../src/agents/codex.ts";
import { claudeCode } from "../src/agents/claude-code.ts";
import { lintText } from "../src/lint.ts";
import { compile, loadDefault } from "../src/rules.ts";

const dirs: string[] = [];
const rules = compile({ ...loadDefault(), failOn: "error" });
function edit(before: string, oldString: string, newString: string) {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-context-"));
  dirs.push(dir);
  const file = resolve(dir, "notes.md");
  writeFileSync(file, before);
  return decide(claudeCode.parse({ cwd: dir, tool_name: "Edit", tool_input: {
    file_path: file, old_string: oldString, new_string: newString,
  } }), "docs", { projectDir: dir, ruleSet: rules });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("edits keep their document context", () => {
  it("skips oversized documents before preparing a model request", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const event = claudeCode.parse({ cwd: dir, tool_name: "Write", tool_input: {
      file_path: "notes.md", content: "The cache holds parsed results for an hour.\n".repeat(6000),
    } });
    expect(scopedDocsFiles(event, rules, dir)).toHaveLength(0);
  });
  it("resolves a relative edit against the tool directory", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const nested = resolve(dir, "nested"); mkdirSync(nested);
    writeFileSync(resolve(nested, "notes.md"), "```text\nold\n```\n");
    const event = claudeCode.parse({ cwd: nested, tool_name: "Edit", tool_input: { file_path: "notes.md", old_string: "old", new_string: "We leverage this." } });
    expect(decide(event, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("respects a directory change before a shell patch", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const event = { tool: "bash" as const, cwd: dir, input: { command: "cd .. && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: notes.md\n+We leverage this.\n*** End Patch\nPATCH\n" } };
    expect(decide(event, "github", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("keeps context for a patch passed through the shell", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "```text\nold\n```\n");
    const event = { tool: "bash" as const, cwd: dir, input: { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: notes.md\n@@\n-old\n+We leverage this.\n*** End Patch\nPATCH\n" } };
    expect(decide(event, "github", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("keeps the completed document context for post-tool checks", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "The cache holds results.\n\n```text\nWe leverage this.\n```\n");
    const event = claudeCode.parse({ cwd: dir, tool_name: "Edit", tool_input: { file_path: "notes.md", old_string: "placeholder", new_string: "We leverage this." } });
    expect(scopedDocsFiles(event, rules, dir, { alreadyApplied: true })).toEqual([]);
  });
  it("suggests an exception that includes the required reason", () => {
    const finding = lintText("We leverage this.", rules).findings.find((f) => f.ruleId === "leverage")!;
    const comment = formatReason([finding], "docs").match(/<!-- plain-english-disable-next-line[^\n]+-->/)![0];
    expect(lintText(comment + "\nWe leverage this.", rules).findings).toEqual([]);
  });
  it("does not send an edit inside an existing code example to a model", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "The cache holds results.\n\n```text\nplaceholder\n```\n");
    const event = claudeCode.parse({ cwd: dir, tool_name: "Edit", tool_input: { file_path: "notes.md", old_string: "placeholder", new_string: "We leverage this." } });
    expect(scopedDocsFiles(event, rules, dir)).toEqual([]);
  });
  it("does not send a deletion-only edit to a model", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "The cache holds results.\n\nRemove this.");
    const event = claudeCode.parse({ cwd: dir, tool_name: "Edit", tool_input: { file_path: "notes.md", old_string: "Remove this.", new_string: "" } });
    expect(scopedDocsFiles(event, rules, dir)).toEqual([]);
  });
  it("does not send a waived document to a model", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const event = claudeCode.parse({ cwd: dir, tool_name: "Write", tool_input: { file_path: "notes.md", content: "<!-- plain-english-disable-file: approved quotation -->\nWe leverage this." } });
    expect(scopedDocsFiles(event, rules, dir)).toEqual([]);
  });
  it("checks only additions when the patch source cannot be read", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const parsed = codex.parse({ cwd: dir, tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: missing.md\n@@\n We leverage this.\n-old\n+The cache holds results.\n*** End Patch" } });
    expect(decide(parsed, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("keeps context for a unified diff", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "```text\nold\n```\n");
    const parsed = codex.parse({ cwd: dir, tool_name: "apply_patch", tool_input: { patch: "--- a/notes.md\n+++ b/notes.md\n@@ -2,1 +2,1 @@\n-old\n+We leverage this.\n" } });
    expect(decide(parsed, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("keeps context for the final patch line without a trailing newline", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "Recovery point objective (RPO) limits data loss.\n\nOld text.");
    const parsed = codex.parse({ cwd: dir, tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: notes.md\n@@\n-Old text.\n+The RPO limits data loss.\n*** End Patch" } });
    expect(decide(parsed, "docs", { projectDir: dir, ruleSet: rules }).findings.filter((f) => f.ruleId === "unglossed-term")).toEqual([]);
  });
  it("keeps a patch replacement inside an existing code fence", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.md"), "```text\nold\n```\n");
    const parsed = codex.parse({ cwd: dir, tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: notes.md\n@@\n-old\n+We leverage this.\n*** End Patch" } });
    expect(decide(parsed, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("checks all content when a move newly makes a file Markdown", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    writeFileSync(resolve(dir, "notes.txt"), "We leverage this.\n");
    const parsed = codex.parse({ cwd: dir, tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: notes.txt\n*** Move to: notes.md\n*** End Patch" } });
    expect(decide(parsed, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("deny");
  });
  it("checks a patch move by its destination", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    // Use the actual envelope parser, whose move changes the target file type.
    const parsed = codex.parse({ cwd: dir, tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: notes.ts\n*** Move to: notes.md\n-old\n+We leverage this.\n*** End Patch" } });
    expect(decide(parsed, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("deny");
  });
  it("ignores an in-project symlink whose destination is outside", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const other = mkdtempSync(resolve(tmpdir(), "pe-outside-")); dirs.push(other);
    writeFileSync(resolve(other, "notes.md"), "Old text.");
    symlinkSync(other, resolve(dir, "linked"));
    const event = claudeCode.parse({ cwd: dir, tool_name: "Write", tool_input: {
      file_path: "linked/notes.md", content: "We leverage this.",
    } });
    expect(decide(event, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("ignores relative traversal outside the project", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-context-")); dirs.push(dir);
    const event = claudeCode.parse({ cwd: dir, tool_name: "Write", tool_input: {
      file_path: "../elsewhere.md", content: "We leverage this.",
    } });
    expect(decide(event, "docs", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("uses an abbreviation explained earlier in the document", () => {
    expect(lintText("The RPO limits data loss.", rules).findings.map((f) => f.ruleId)).toContain("unglossed-term");
    const result = edit("Recovery point objective (RPO) limits data loss.\n\nOld text.\n", "Old text.", "The RPO limits data loss.");
    expect(result.findings.filter((f) => f.ruleId === "unglossed-term")).toEqual([]);
  });
  it("does not gate unrelated older prose", () => {
    expect(edit("We leverage this.\n\nOld text.\n", "Old text.", "The cache holds results.").decision).toBe("allow");
  });
  it("still refuses newly added prose outside the fence", () => {
    expect(edit("```text\nExample.\n```\n\nOld text.\n", "Old text.", "We leverage this.").decision).toBe("deny");
  });
  it("does not judge a replacement inside an existing code fence", () => {
    expect(edit("# Notes\n\n```text\nold\n```\n", "old", "We leverage this.").decision).toBe("allow");
  });
});
