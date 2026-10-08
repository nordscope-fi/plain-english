import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const dirs: string[] = [];
const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scenario(agent: string, tool: string, failOn: "never" | "error") {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-advice-")); dirs.push(dir);
  const bin = resolve(dir, "bin"); mkdirSync(bin);
  const calls = resolve(dir, "calls");
  for (const command of ["claude", "vibe"]) {
    const path = resolve(bin, command);
    writeFileSync(path, `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\nprintf '%s' '{"ok":false,"reason":"Lead with the point."}'\n`);
    chmodSync(path, 0o755);
  }
  writeFileSync(resolve(dir, ".plain-english.yml"), `version: 1\nextends: default\nmodelChecks: true\nfailOn: ${failOn}\n`);
  const payload = JSON.stringify({ cwd: dir, tool_name: tool, tool_input: { command: 'git commit -m "The cache holds results."' } });
  const run = (phase: string) => execFileSync(process.execPath, [CLI, "hook", "github", "--agent", agent, "--event", phase], {
    cwd: dir, input: payload, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: bin + ":" + process.env.PATH, PLAIN_ENGLISH_CHAT_JUDGE: "0", PLAIN_ENGLISH_VIBE_JUDGE: "0" },
  });
  return { calls, run };
}

const agents = [["cursor", "Shell"], ["vibe", "bash"], ["gemini", "run_shell_command"], ["copilot", "Bash"]] as const;
it.skipIf(process.platform === "win32").each(
  (["warn", "error"] as const).flatMap((threshold) =>
    (["missing", "failed", "passing", "rejecting"] as const).map((outcome) => [threshold, outcome] as const)),
)("keeps %s document enforcement correct with a %s model check", (threshold, outcome) => {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-model-outcome-")); dirs.push(dir);
  const bin = resolve(dir, "bin"); mkdirSync(bin);
  const calls = resolve(dir, "calls");
  if (outcome !== "missing") {
    const verdict = outcome === "rejecting" ? '{"ok":false,"reason":"Lead with the point."}' : '{"ok":true}';
    const fake = resolve(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\nprintf '%s' '${verdict}'\nexit ${outcome === "failed" ? 1 : 0}\n`);
    chmodSync(fake, 0o755);
  }
  const configure = (settings: string) => writeFileSync(resolve(dir, ".plain-english.yml"),
    `version: 1\nextends: default\nfailOn: ${threshold}\n${settings}\n`);
  const run = (path: string, text = "The cache holds results.") => {
    const out = spawnSync(process.execPath, [CLI, "hook", "docs", "--agent", "codex"], {
      cwd: dir, encoding: "utf8", input: JSON.stringify({ cwd: dir, tool_name: "Write", tool_input: { file_path: path, content: text } }),
      // The only available model executable is the stand-in created above.
      env: { ...process.env, PATH: bin, PLAIN_ENGLISH_CHAT_JUDGE: "0", PLAIN_ENGLISH_VIBE_JUDGE: "0" },
    });
    expect(out.status, out.stderr).toBe(0);
    return out.stdout;
  };
  configure("modelChecks: true");
  expect(run("notes.md").includes('"permissionDecision":"deny"')).toBe(outcome === "rejecting");
  expect(existsSync(calls)).toBe(outcome !== "missing");
  if (outcome === "missing" || outcome === "failed") {
    expect(run("notes.md", "We leverage this approach.")).toContain('"permissionDecision":"deny"');
  }
  for (const [settings, path] of [
    ["modelChecks: true\nexclude: [secret.md]", "secret.md"],
    ["modelChecks: true", resolve(dir, "..", "outside.md")],
    ["modelChecks: false", "notes.md"],
    ["", "notes.md"],
  ]) {
    rmSync(calls, { force: true }); configure(settings!);
    expect(run(path!)).toBe("");
    expect(existsSync(calls)).toBe(false);
  }
});

it.skipIf(process.platform === "win32").each(agents)("delivers %s model-only advice after the tool, with one model request", (agent, tool) => {
  const { calls, run } = scenario(agent, tool, "never");
  expect(run("pre")).toBe("");
  expect(existsSync(calls)).toBe(false);
  expect(run("post")).toContain("Lead with the point.");
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});

it.skipIf(process.platform === "win32").each(agents)("enforces %s findings before the tool without repeating the model request", (agent, tool) => {
  const { calls, run } = scenario(agent, tool, "error");
  expect(run("pre")).toContain("Lead with the point.");
  expect(run("post")).toBe("");
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});

it("reports an unavailable hook check when project configuration cannot be read", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-advice-")); dirs.push(dir);
  writeFileSync(resolve(dir, ".plain-english.yml"), "version: invalid\n");
  const result = spawnSync(process.execPath, [CLI, "hook", "docs", "--agent", "claude-code"], {
    cwd: dir, input: JSON.stringify({ cwd: dir, tool_name: "Write", tool_input: { file_path: "notes.md", content: "The cache holds results." } }),
    encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("check unavailable");
});
