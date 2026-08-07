import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { allAgents, init, mergeNested, spliceAgentsMd } from "../src/init.ts";
import { byId } from "../src/agents/registry.ts";
import { AGENTS_MD_START, AGENTS_MD_END, renderAgentsFragment } from "../src/render.ts";
import { compile, loadDefault } from "../src/rules.ts";

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
    expect(init({ root })).toBe(0);
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
    init({ root });
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
    init({ root });
    const s = settings();

    const bash = s["hooks"].PreToolUse.find((b: any) => b.matcher === "Bash");
    const commands = bash.hooks.map((h: any) => h.command ?? "").join(" ");
    expect(commands, "the pre-existing gate was dropped").toContain("ticket-gate.sh");
    expect(commands).toContain("plain-english-github.sh");
  });

  it("preserves unrelated top-level keys and other hook events", () => {
    seedExistingSettings();
    init({ root });
    const s = settings();
    expect(s["model"]).toBe("claude-sonnet-5");
    expect(s["permissions"].allow).toEqual(["Bash(npm test)"]);
    expect(s["hooks"].PostToolUse).toHaveLength(1);
  });

  it("is idempotent", () => {
    seedExistingSettings();
    init({ root });
    const first = readFileSync(resolve(root, ".claude/settings.json"), "utf8");
    init({ root });
    const second = readFileSync(resolve(root, ".claude/settings.json"), "utf8");
    expect(second).toBe(first);
  });

  it("replaces its own entries on re-run instead of stacking them", () => {
    init({ root });
    init({ root });
    init({ root });
    const s = settings();
    const bash = s["hooks"].PreToolUse.find((b: any) => b.matcher === "Bash");
    expect(bash.hooks.filter((h: any) => h.type === "command")).toHaveLength(1);
    expect(bash.hooks.filter((h: any) => h.type === "prompt")).toHaveLength(1);
  });

  it("does not overwrite an existing project config", () => {
    writeFileSync(resolve(root, ".plain-english.yml"), "version: 1\nextends: default\nallow: [mine]\n");
    init({ root });
    expect(readFileSync(resolve(root, ".plain-english.yml"), "utf8")).toContain("mine");
  });

  it("refuses to touch a settings file that is not valid JSON", () => {
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(resolve(root, ".claude/settings.json"), "{ not json");
    expect(init({ root })).toBe(2);
    expect(readFileSync(resolve(root, ".claude/settings.json"), "utf8")).toBe("{ not json");
  });

  it("writes nothing on a dry run", () => {
    expect(init({ root, dryRun: true })).toBe(0);
    expect(() => statSync(resolve(root, ".claude/settings.json"))).toThrow();
    expect(() => statSync(resolve(root, ".plain-english.yml"))).toThrow();
  });

  it("resolves the prompt placeholder", () => {
    init({ root });
    const s = settings();
    const docs = s["hooks"].PreToolUse.find((b: any) => b.matcher.includes("Write"));
    const prompt = docs.hooks.find((h: any) => h.type === "prompt").prompt;
    expect(prompt).not.toContain("{{PROJECT_DIR}}");
  });

  // .claude/settings.json is usually committed. Writing the machine's own
  // directory layout into it breaks the file for every other contributor and
  // leaks a local path into what may be a public repo. An earlier version did
  // exactly that, which is the fault this package exists to remove.
  it("writes no absolute filesystem path into settings.json", () => {
    init({ root });
    const raw = readFileSync(resolve(root, ".claude/settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    for (const block of parsed.hooks.PreToolUse) {
      for (const entry of block.hooks) {
        const prompt: string = entry.prompt ?? "";
        expect(prompt, `prompt for ${block.matcher} embeds the project path`).not.toContain(root);
        expect(prompt).not.toMatch(/\/(Users|home)\//);
      }
    }
    // The command hook uses the variable Claude Code expands, not a real path.
    expect(raw).toContain("$CLAUDE_PROJECT_DIR/.claude/hooks/");
  });

  it("produces byte-identical settings from two different project roots", () => {
    init({ root });
    const a = readFileSync(resolve(root, ".claude/settings.json"), "utf8");

    const other = mkdtempSync(resolve(tmpdir(), "pe-init-other-"));
    init({ root: other });
    const b = readFileSync(resolve(other, ".claude/settings.json"), "utf8");
    rmSync(other, { recursive: true, force: true });

    // Two people running init on the same project must get the same file, or
    // the settings file churns on every checkout.
    expect(b).toBe(a);
  });
});

describe("init --agent", () => {
  const read = (f: string) => JSON.parse(readFileSync(resolve(root, f), "utf8"));

  const AGENTS: [string, string][] = [
    ["claude-code", ".claude/settings.json"],
    ["copilot", ".github/hooks/plain-english.json"],
    ["codex", ".codex/hooks.json"],
    ["cursor", ".cursor/hooks.json"],
  ];

  for (const [id, file] of AGENTS) {
    it(`${id} writes ${file}`, () => {
      expect(init({ root, agents: [byId(id)!] })).toBe(0);
      expect(statSync(resolve(root, file)).isFile()).toBe(true);

      // The hook has to name the agent it is speaking for, or a shim installed
      // for one agent would emit another's wire format. Claude Code keeps the
      // command in a shim script; the other three inline it in the config.
      const plan = byId(id)!.plan({ prompts: { docs: "", github: "", issue: "" }, model: "m" });
      const installed =
        JSON.stringify(read(file)) +
        plan.shims.map((s) => readFileSync(resolve(root, s.path), "utf8")).join("");
      expect(installed).toContain(`--agent ${id}`);
    });

    it(`${id} is idempotent`, () => {
      init({ root, agents: [byId(id)!] });
      const before = readFileSync(resolve(root, file), "utf8");
      init({ root, agents: [byId(id)!] });
      expect(readFileSync(resolve(root, file), "utf8")).toBe(before);
    });
  }

  it("only writes the agent asked for", () => {
    init({ root, agents: [byId("cursor")!] });
    expect(statSync(resolve(root, ".cursor/hooks.json")).isFile()).toBe(true);
    expect(() => statSync(resolve(root, ".claude/settings.json"))).toThrow();
    expect(() => statSync(resolve(root, ".codex/hooks.json"))).toThrow();
  });

  it("writes every agent when asked for all of them", () => {
    init({ root, agents: allAgents() });
    for (const [, file] of AGENTS) {
      expect(statSync(resolve(root, file)).isFile(), `${file} missing`).toBe(true);
    }
  });

  // A project that already gates its own tool calls must not lose that gate by
  // installing this one. Two of the four config shapes are flat lists and two
  // are matcher-keyed groups, so both merges need the same guarantee.
  it("keeps a hook it did not write", () => {
    mkdirSync(resolve(root, ".cursor"), { recursive: true });
    writeFileSync(
      resolve(root, ".cursor/hooks.json"),
      JSON.stringify({ version: 2, hooks: { preToolUse: [{ type: "command", command: "./gate.sh" }] } }),
    );
    init({ root, agents: [byId("cursor")!] });
    const doc = read(".cursor/hooks.json");
    expect(doc.hooks.preToolUse[0].command).toBe("./gate.sh");
    expect(doc.hooks.preToolUse).toHaveLength(4);
    // A version the project pinned itself is left alone.
    expect(doc.version).toBe(2);
  });

  it("refuses to touch a config file that is not valid JSON", () => {
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    writeFileSync(resolve(root, ".codex/hooks.json"), "{ not json");
    expect(init({ root, agents: [byId("codex")!] })).toBe(2);
    expect(readFileSync(resolve(root, ".codex/hooks.json"), "utf8")).toBe("{ not json");
  });
});

/**
 * AGENTS.md is the one instructions file that reaches roughly twenty agents,
 * and unlike every other generated artifact here it is spliced into a file the
 * project also writes by hand. So the markers have to hold.
 */
describe("the AGENTS.md fragment", () => {
  it("creates the file when there is none", () => {
    init({ root });
    const md = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(md).toContain(AGENTS_MD_START);
    expect(md).toContain(AGENTS_MD_END);
    expect(md).toContain("## Writing style");
  });

  it("appends to a file that already has content, keeping it", () => {
    writeFileSync(resolve(root, "AGENTS.md"), "# AGENTS.md\n\n## Build\n\nRun `npm test`.\n");
    init({ root });
    const md = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(md).toContain("Run `npm test`.");
    expect(md).toContain(AGENTS_MD_START);
  });

  it("replaces its own section rather than stacking a second copy", () => {
    init({ root });
    const first = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    init({ root });
    const second = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(second).toBe(first);
    expect(second.match(new RegExp(AGENTS_MD_START, "g"))).toHaveLength(1);
  });

  it("leaves text after its section alone", () => {
    init({ root });
    const withTail = readFileSync(resolve(root, "AGENTS.md"), "utf8") + "\n## Deploy\n\nRun make.\n";
    writeFileSync(resolve(root, "AGENTS.md"), withTail);
    init({ root });
    const md = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(md).toContain("Run make.");
    expect(md.match(new RegExp(AGENTS_MD_START, "g"))).toHaveLength(1);
  });

  it("reports no change when the section is already current", () => {
    init({ root });
    const md = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(spliceAgentsMd(md, renderAgentsFragment(compile(loadDefault())))).toBeNull();
  });
});

describe("mergeNested", () => {
  it("appends a new matcher without disturbing existing ones", () => {
    const existing = [{ matcher: "Read", hooks: [{ type: "command", command: "x.sh" }] }];
    const { groups, added } = mergeNested(existing, [
      { matcher: "Bash", hooks: [{ type: "command", command: "plain-english hook github" }] },
    ]);
    expect(groups).toHaveLength(2);
    expect(added).toEqual(["Bash"]);
    expect(groups[0]!.matcher).toBe("Read");
  });

  it("works on an empty group list", () => {
    const { groups } = mergeNested([], [
      { matcher: "Bash", hooks: [{ type: "command", command: "plain-english hook github" }] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe("Bash");
  });

  it("replaces our entry and keeps a foreign one under the same matcher", () => {
    const existing = [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "./ticket-gate.sh" },
          { type: "command", command: "plain-english hook github" },
        ],
      },
    ];
    const { groups, replaced } = mergeNested(existing, [
      { matcher: "Bash", hooks: [{ type: "command", command: "plain-english hook github --agent claude-code" }] },
    ]);
    expect(replaced).toEqual(["Bash"]);
    expect(groups[0]!.hooks).toHaveLength(2);
    expect(groups[0]!.hooks[0]!["command"]).toBe("./ticket-gate.sh");
    expect(groups[0]!.hooks[1]!["command"]).toContain("--agent claude-code");
  });
});
