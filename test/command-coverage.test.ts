import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { vibe } from "../src/agents/vibe.ts";
import { claudeCode } from "../src/agents/claude-code.ts";
import { decide, extractFromBash } from "../src/adapters/hook.ts";
import { publishingCommands } from "../src/shell.ts";
import { compile, loadDefault } from "../src/rules.ts";
const dirs: string[] = [];
const rules = compile({ ...loadDefault(), failOn: "error" });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("shared shell coverage", () => {
  it("preserves attached network message-file paths", () => {
    const path = String.raw`\\server\share\message.txt`;
    const git = publishingCommands(`git commit -F${path}`, String.raw`C:\repo`);
    const gh = publishingCommands(`gh issue create --body-file=${path}`, String.raw`C:\repo`);
    expect(git[0]!.args[0]!.text).toBe(`-F${path}`);
    expect(gh[0]!.args[0]!.text).toBe(`--body-file=${path}`);
  });
  it("preserves a network directory selected by git", () => {
    const dir = String.raw`\\server\share\repo`;
    const commands = publishingCommands(`git -C ${dir} commit -F message.txt`, String.raw`C:\repo`);
    expect(commands[0]!.cwd).toBe(dir);
  });
  it("still decodes escaped spaces in a POSIX file path", () => {
    const commands = publishingCommands(String.raw`git commit -F /tmp/message\ file.txt`, "/repo");
    expect(commands[0]!.args.map((word) => word.text)).toEqual(["-F", "/tmp/message file.txt"]);
  });
  it("preserves a quoted Windows body-file path", () => {
    const path = String.raw`D:\notes\body file.md`;
    const commands = publishingCommands(`gh pr create --body-file "${path}"`, String.raw`C:\repo`);
    expect(commands[0]!.args.map((word) => word.text)).toEqual(["--body-file", path]);
  });
  it("preserves an unquoted Windows message-file path", () => {
    const path = String.raw`C:\Users\runner\AppData\Local\Temp\message.txt`;
    const commands = publishingCommands(`git commit -F ${path}`, String.raw`C:\repo`);
    expect(commands[0]!.args.map((word) => word.text)).toEqual(["-F", path]);
  });
  it("reads a literal heredoc used as an inline commit message", () => {
    expect(extractFromBash(`git commit -m "$(cat <<'EOF'\nWe leverage this.\nEOF\n)"`)).toContain("We leverage this.");
  });
  it("reads a combined commit flag carrying an attached message", () => {
    expect(extractFromBash('git commit -am"We leverage this."')).toContain("We leverage this.");
  });
  it("runs Vibe model checks through the shared configured checker", () => {
    const plan = vibe.plan({ prompts: { docs: "Check this." }, model: "model-name" });
    const commands = plan.config.flatMap((c) => c.entries).map((e) => (e as { command?: string }).command ?? "");
    expect(commands.some((command) => command.includes("plain-english-judge.mjs"))).toBe(false);
  });
  it("installs no unconditional model hooks", () => {
    const plan = claudeCode.plan({ prompts: { github: "Check this.", issue: "Check this." }, model: "model-name" });
    const entries = plan.config.find((c) => c.at.includes("PreToolUse"))!.entries as { hooks: { type: string }[] }[];
    expect(entries.flatMap((e) => e.hooks).filter((h) => h.type === "prompt")).toEqual([]);
  });
  it("resolves message files against the tool directory and a leading cd", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-command-")); dirs.push(dir);
    mkdirSync(resolve(dir, "nested"));
    writeFileSync(resolve(dir, "nested", "message.txt"), "We leverage this.");
    const event = { tool: "bash" as const, cwd: dir, input: { command: "cd nested && git commit -Fmessage.txt" } };
    expect(decide(event, "github", { projectDir: dir, ruleSet: rules }).decision).toBe("deny");
  });
  it("does not judge a redirected file after cd outside the project", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-command-")); dirs.push(dir);
    const event = { tool: "bash" as const, cwd: dir, input: { command: "cd .. && echo 'We leverage this.' > notes.md" } };
    expect(decide(event, "github", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("applies the document waiver to shell-written Markdown", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-command-")); dirs.push(dir);
    const event = { tool: "bash" as const, cwd: dir, input: { command: "echo 'We leverage this.' > notes.md" } };
    writeFileSync(resolve(dir, ".plain-english-ack-github"), "");
    expect(decide(event, "github", { projectDir: dir, ruleSet: rules }).decision).toBe("deny");
    rmSync(resolve(dir, ".plain-english-ack-github"));
    writeFileSync(resolve(dir, ".plain-english-ack-docs"), "");
    expect(decide(event, "github", { projectDir: dir, ruleSet: rules }).decision).toBe("allow");
  });
  it("reads attached commit messages after git options and whitespace", () => {
    expect(extractFromBash('  git -c user.name=Example commit -m"We leverage this."')).toContain("We leverage this.");
  });
});
