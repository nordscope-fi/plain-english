import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compile, loadDefault } from "../src/rules.ts";
import { agentIds } from "../src/agents/registry.ts";

/**
 * End-to-end exit codes, run through the built CLI.
 *
 * These exist because the advisory default shipped broken: `failOn` is a
 * severity THRESHOLD, so setting the default to "warn" made it the strictest
 * setting and a clean-directory run exited 1. Every unit test passed, because
 * none of them ran the binary.
 */
const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
let dir: string;

function run(args: string[], config?: string): number {
  if (config !== undefined) writeFileSync(resolve(dir, ".plain-english.yml"), config);
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: dir, stdio: "pipe" });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

/** Same run, but the text. NO_COLOR keeps the escape codes out of assertions. */
function stdout(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "pe-exit-"));
  writeFileSync(resolve(dir, "blocking.md"), "We leverage a seamless paradigm shift.\n");
  writeFileSync(resolve(dir, "warning.md"), "The job silently rewrote the config.\n");
  writeFileSync(resolve(dir, "clean.md"), "The cache holds parsed results for an hour.\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("exit codes with no config", () => {
  it("clean text exits 0", () => {
    expect(run(["lint", "clean.md"])).toBe(0);
  });

  it("blocking findings still exit 0, because the default is advisory", () => {
    expect(run(["lint", "blocking.md"])).toBe(0);
  });

  it("warnings exit 0", () => {
    expect(run(["lint", "warning.md"])).toBe(0);
  });
});

describe("blocking is opt-in", () => {
  const advisory = "version: 1\nextends: default\n";

  it("--fail-on error exits 1 on a blocking finding", () => {
    expect(run(["lint", "blocking.md", "--fail-on", "error"], advisory)).toBe(1);
  });

  it("--fail-on error exits 0 on a warning only", () => {
    expect(run(["lint", "warning.md", "--fail-on", "error"], advisory)).toBe(0);
  });

  it("--fail-on warn exits 1 on a warning", () => {
    expect(run(["lint", "warning.md", "--fail-on", "warn"], advisory)).toBe(1);
  });

  it("--fail-on never exits 0 on a blocking finding", () => {
    expect(run(["lint", "blocking.md", "--fail-on", "never"], advisory)).toBe(0);
  });
});

describe("config sets the threshold", () => {
  it("failOn error in config exits 1 without any flag", () => {
    expect(run(["lint", "blocking.md"], "version: 1\nextends: default\nfailOn: error\n")).toBe(1);
  });

  it("an explicit flag overrides the config", () => {
    const strict = "version: 1\nextends: default\nfailOn: error\n";
    expect(run(["lint", "blocking.md", "--fail-on", "never"], strict)).toBe(0);
  });

  it("failOn never in config exits 0", () => {
    expect(run(["lint", "blocking.md"], "version: 1\nextends: default\nfailOn: never\n")).toBe(0);
  });

  it("an invalid failOn is a config error, exit 2", () => {
    expect(run(["lint", "clean.md"], "version: 1\nextends: default\nfailOn: sometimes\n")).toBe(2);
  });
});

describe("other commands", () => {
  it("--version exits 0", () => {
    expect(run(["--version"])).toBe(0);
  });
  it("doctor exits 0", () => {
    expect(run(["doctor"], "version: 1\nextends: default\n")).toBe(0);
  });
  it("a missing path exits 2", () => {
    expect(run(["lint", "nope.md"])).toBe(2);
  });
  it("an unknown command exits 2", () => {
    expect(run(["frobnicate"])).toBe(2);
  });
});

/**
 * `explain` reached `set.rules` only, so the nine sentence shapes and the two
 * readability rules were unreachable from the CLI while the README said they
 * were listed. Every id in the ruleset must resolve.
 */
describe("explain reaches every collection", () => {
  it("lists all three groups", () => {
    const out = stdout(["explain"]);
    expect(out).toContain("Words and punctuation");
    expect(out).toContain("Readability");
    expect(out).toContain("Sentence shapes");
  });

  it("names every id in the ruleset", () => {
    const out = stdout(["explain"]);
    const set = compile(loadDefault());
    const ids = [
      ...set.rules.map((r) => r.id),
      ...set.readability.map((r) => r.id),
      ...set.structures.map((s) => s.id),
    ];
    expect(ids.length).toBe(52);
    for (const id of ids) expect(out).toContain(id);
  });

  it("explains a readability rule", () => {
    expect(run(["explain", "unglossed-term"])).toBe(0);
    expect(stdout(["explain", "unglossed-term"])).toContain("kind:");
  });

  it("explains a sentence shape", () => {
    expect(run(["explain", "binary-contrast"])).toBe(0);
    expect(stdout(["explain", "binary-contrast"])).toContain("sentence shape");
  });

  it("still explains a word rule", () => {
    expect(stdout(["explain", "leverage"])).toContain("match:");
  });

  it("an unknown id still exits 2", () => {
    expect(run(["explain", "no-such-rule"])).toBe(2);
  });
});


/**
 * `doctor` has to recognise an install it just performed.
 *
 * It decided ownership by looking for `--agent <id>` inside the config file.
 * That holds for Codex and Vibe, which put the whole command inline, and fails
 * for Claude Code, which writes shim scripts and references only their paths
 * from `.claude/settings.json`. The flag lives in the shim.
 *
 * So the default agent reported "(no plain-english entry)" immediately after a
 * successful `init`, in every release up to 0.11.0. That is the inverse of what
 * this command is for: the comment on `agentReport` says it exists to catch a
 * config that looks perfect while nothing runs, and it produced a config that
 * runs perfectly and looks broken.
 *
 * Run through the built CLI on a real install, because that is what it took to
 * see it. Nothing shorter reproduces it.
 */
describe("doctor recognises an install it just wrote", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(resolve(tmpdir(), "pe-doctor-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function installAndReport(agent: string): string {
    const at = mkdtempSync(resolve(home, `${agent}-`));
    execFileSync(process.execPath, [CLI, "init", "--agent", agent, "--root", at], {
      stdio: "pipe",
    });
    const out = execFileSync(process.execPath, [CLI, "doctor"], {
      cwd: at,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    // The agent's own line, from the `agents` block.
    return out
      .split("\n")
      .filter((l) => l.trim().startsWith(agent + " "))
      .join("\n");
  }

  for (const agent of agentIds()) {
    it(`${agent}: no "(no plain-english entry)" right after init`, () => {
      const line = installAndReport(agent);
      expect(line, `${agent} reported nothing at all`).not.toBe("");
      expect(line).not.toContain("not installed");
      expect(line, `${agent} does not recognise its own install`).not.toContain(
        "no plain-english entry",
      );
    });
  }
  it("still says so when the config is somebody else's hooks only", () => {
    // The point of the check. Widening it until everything reads as installed
    // would remove the warning rather than fix it, and this command exists to
    // catch a config that looks perfect while nothing of ours runs.
    const at = mkdtempSync(resolve(home, "foreign-"));
    mkdirSync(resolve(at, ".claude"), { recursive: true });
    writeFileSync(
      resolve(at, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/other-guard.sh" }],
            },
          ],
        },
      }),
    );
    const out = execFileSync(process.execPath, [CLI, "doctor"], {
      cwd: at,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const line = out.split("\n").filter((l) => l.trim().startsWith("claude-code ")).join("\n");
    expect(line).toContain("no plain-english entry");
  });

  it("does not read a TOML file's foreign hooks as ours", () => {
    const at = mkdtempSync(resolve(home, "foreign-toml-"));
    mkdirSync(resolve(at, ".vibe"), { recursive: true });
    writeFileSync(
      resolve(at, ".vibe/hooks.toml"),
      '[[hooks]]\nname = "no-force-push"\ntype = "pre_tool"\nmatch = "bash"\ncommand = "./scripts/no-force-push.sh"\n',
    );
    const out = execFileSync(process.execPath, [CLI, "doctor"], {
      cwd: at,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const line = out.split("\n").filter((l) => l.trim().startsWith("vibe ")).join("\n");
    expect(line).toContain("no plain-english entry");
  });
});

