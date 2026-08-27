import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HOOK_RUNNER } from "../src/agents/runner.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(cli: string): { root: string; runner: string } {
  const root = mkdtempSync(resolve(tmpdir(), "plain-english-runner-"));
  roots.push(root);
  const runner = resolve(root, ".codex", "hooks", "plain-english.mjs");
  mkdirSync(resolve(root, ".codex", "hooks"), { recursive: true });
  mkdirSync(resolve(root, "dist"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "plain-english" }));
  writeFileSync(resolve(root, "dist", "cli.js"), cli);
  writeFileSync(runner, HOOK_RUNNER);
  return { root, runner };
}

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const poll = () => {
      if (check()) return done();
      if (Date.now() >= until) return fail(new Error("timed out waiting for process state"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function stopped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
}

describe("the offline hook runner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("stops the CLI and its children when a host terminates it without a terminal", async () => {
    const pidsPath = resolve(tmpdir(), `plain-english-runner-pids-${process.pid}-${Date.now()}.json`);
    const { root, runner } = project(`
      import { writeFileSync } from "node:fs";
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.PLAIN_ENGLISH_TEST_PIDS, JSON.stringify({ cli: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
    `);
    const launcher = spawn(process.execPath, [runner, "hook", "chat", "--agent", "codex"], {
      cwd: root,
      env: { ...process.env, PLAIN_ENGLISH_TEST_PIDS: pidsPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let pids: { cli: number; child: number } | undefined;

    try {
      await waitFor(() => existsSync(pidsPath));
      pids = JSON.parse(readFileSync(pidsPath, "utf8"));
      const ending = exited(launcher);
      launcher.kill("SIGTERM");
      await expect(ending).resolves.toEqual({ code: null, signal: "SIGTERM" });
      await waitFor(() => stopped(pids!.cli) && stopped(pids!.child));
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      for (const pid of pids ? [pids.cli, pids.child] : []) {
        if (!stopped(pid)) process.kill(pid, "SIGKILL");
      }
      rmSync(pidsPath, { force: true });
    }
  });

  it("preserves the CLI exit status", () => {
    const { root, runner } = project("process.exit(23);\n");
    const result = spawnSync(process.execPath, [runner], { cwd: root });
    expect(result.status).toBe(23);
  });

  it("still fails open when no command can be resolved", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plain-english-runner-empty-"));
    roots.push(root);
    const runner = resolve(root, ".codex", "hooks", "plain-english.mjs");
    const emptyPath = resolve(root, "bin");
    mkdirSync(resolve(root, ".codex", "hooks"), { recursive: true });
    mkdirSync(emptyPath);
    writeFileSync(runner, HOOK_RUNNER);

    const result = spawnSync(process.execPath, [runner], {
      cwd: root,
      env: { ...process.env, PATH: emptyPath },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not find the repository package");
  });
});
