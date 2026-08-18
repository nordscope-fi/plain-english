import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { allAgents, init, mergeNested, spliceAgentsMd } from "../src/init.ts";
import { byId } from "../src/agents/registry.ts";
import type { AgentProfile } from "../src/agents/profile.ts";
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

/**
 * Two bugs found by tracing rather than by test, both of which only show up
 * across a version rather than within one, which is why idempotence missed them.
 */
describe("merging across versions", () => {
  it("keeps both events when one agent writes two into one file", () => {
    // init re-read the document from disk for each config entry, so the second
    // write started from the same bytes as the first and overwrote it. An agent
    // installing a pre and a post hook kept only whichever came last, and the
    // one lost was the one that can actually refuse.
    const twoEvents: AgentProfile = {
      ...byId("codex")!,
      id: "codex",
      plan: () => ({
        config: [
          {
            path: ".codex/hooks.json",
            at: ["hooks", "PreToolUse"],
            shape: "nested" as const,
            entries: [{ matcher: "Bash", hooks: [{ type: "command", command: "plain-english pre" }] }],
          },
          {
            path: ".codex/hooks.json",
            at: ["hooks", "PostToolUse"],
            shape: "nested" as const,
            entries: [{ matcher: "Bash", hooks: [{ type: "command", command: "plain-english post" }] }],
          },
        ],
        shims: [],
        notes: [],
      }),
    };

    expect(init({ root, agents: [twoEvents] })).toBe(0);
    const doc = JSON.parse(readFileSync(resolve(root, ".codex/hooks.json"), "utf8"));
    expect(doc.hooks.PreToolUse, "the pre hook was overwritten").toBeDefined();
    expect(doc.hooks.PostToolUse, "the post hook is missing").toBeDefined();
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toContain("pre");
    expect(doc.hooks.PostToolUse[0].hooks[0].command).toContain("post");
  });

  it("clears a hook event this version has stopped writing to", () => {
    // Codex's advisory moved from a second PostToolUse hook onto the pre event
    // in 0.7.0. `init` only visits the places the current plan names, so
    // without a retirement list the old entry survives every re-install and
    // spawns a process per tool call to say nothing.
    writeFileSync(
      resolve(root, ".codex-hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "plain-english hook github" }] },
          ],
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "plain-english hook github --event post" }],
            },
          ],
        },
      }),
    );
    const retiring: AgentProfile = {
      ...byId("codex")!,
      plan: () => ({
        config: [
          {
            path: ".codex-hooks.json",
            at: ["hooks", "PreToolUse"],
            shape: "nested" as const,
            entries: [
              { matcher: "Bash", hooks: [{ type: "command", command: "plain-english hook github" }] },
            ],
          },
        ],
        retire: [{ path: ".codex-hooks.json", at: ["hooks", "PostToolUse"] }],
        shims: [],
        notes: [],
      }),
    };

    expect(init({ root, agents: [retiring] })).toBe(0);
    const doc = JSON.parse(readFileSync(resolve(root, ".codex-hooks.json"), "utf8"));
    expect(doc.hooks.PreToolUse).toBeDefined();
    expect(doc.hooks.PostToolUse, "the retired event is still there").toBeUndefined();
  });

  it("leaves somebody else's hook in a retired event alone", () => {
    writeFileSync(
      resolve(root, ".codex-hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "./their-audit.sh" },
                { type: "command", command: "plain-english hook github --event post" },
              ],
            },
          ],
        },
      }),
    );
    const retiring: AgentProfile = {
      ...byId("codex")!,
      plan: () => ({
        config: [],
        retire: [{ path: ".codex-hooks.json", at: ["hooks", "PostToolUse"] }],
        shims: [],
        notes: [],
      }),
    };

    expect(init({ root, agents: [retiring] })).toBe(0);
    const doc = JSON.parse(readFileSync(resolve(root, ".codex-hooks.json"), "utf8"));
    expect(doc.hooks.PostToolUse[0].hooks).toEqual([
      { type: "command", command: "./their-audit.sh" },
    ]);
  });

  it("removes our old group when a matcher is renamed", () => {
    // mergeNested matched groups by exact matcher and only stripped our entries
    // from a group that matched, so renaming a matcher left the old group
    // carrying our old command and the hook fired twice on every call.
    const before = [
      { matcher: "apply_patch|Write", hooks: [{ type: "command", command: "plain-english hook docs" }] },
    ];
    const { groups, orphaned } = mergeNested(before, [
      {
        matcher: "apply_patch|Write|Edit",
        hooks: [{ type: "command", command: "plain-english hook docs" }],
      },
    ]);
    expect(orphaned).toEqual(["apply_patch|Write"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe("apply_patch|Write|Edit");
  });

  it("leaves a renamed matcher's foreign hooks alone", () => {
    const before = [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "./ticket-gate.sh" },
          { type: "command", command: "plain-english hook github" },
        ],
      },
    ];
    const { groups, orphaned } = mergeNested(before, [
      { matcher: "Shell", hooks: [{ type: "command", command: "plain-english hook github" }] },
    ]);
    expect(orphaned).toEqual(["Bash"]);
    // The group survives because somebody else still uses it; only ours went.
    expect(groups.find((g) => g.matcher === "Bash")!.hooks).toEqual([
      { type: "command", command: "./ticket-gate.sh" },
    ]);
    expect(groups.find((g) => g.matcher === "Shell")).toBeDefined();
  });
});

/**
 * Copilot's CLI does not read `.github/hooks/`, although its own
 * `copilot help config` says repo-level hooks live there. Confirmed against
 * 1.0.78 with an identical hook firing from `~/.copilot/hooks/` and not from
 * the repository, and reported as github/copilot-cli#1730.
 *
 * So `init` can write there, but only when asked. Everything else it writes
 * lands in the project, where it is committed, reviewed and removed with the
 * checkout. A file in somebody's home directory is none of those things.
 */
describe("init --user", () => {
  const copilotPlan = (includeUser: boolean) =>
    byId("copilot")!.plan({ prompts: {}, model: "m", includeUser });

  it("writes nothing outside the repo by default", () => {
    const scopes = new Set(copilotPlan(false).config.map((c) => c.scope ?? "repo"));
    expect([...scopes]).toEqual(["repo"]);
  });

  it("adds the location the CLI actually reads when asked", () => {
    const config = copilotPlan(true).config;
    const user = config.filter((c) => c.scope === "user");
    const repo = config.filter((c) => (c.scope ?? "repo") === "repo");
    expect(user).toHaveLength(1);
    expect(repo.length).toBeGreaterThan(0);
    expect(user[0]!.path).toBe(".copilot/hooks/plain-english.json");
    // Same entries as the repository file for the same event, so the two
    // copies cannot drift.
    const sameEvent = repo.find((c) => c.at.join(".") === user[0]!.at.join("."))!;
    expect(JSON.stringify(user[0]!.entries)).toBe(JSON.stringify(sameEvent.entries));
  });

  it("no other agent asks for a file outside the repo, with or without the flag", () => {
    for (const id of ["claude-code", "codex", "cursor"]) {
      for (const includeUser of [false, true]) {
        const scopes = byId(id)!
          .plan({ prompts: {}, model: "m", includeUser })
          .config.map((c) => c.scope ?? "repo");
        expect(scopes.every((s) => s === "repo"), `${id} includeUser=${includeUser}`).toBe(true);
      }
    }
  });

  it("a plain init touches nothing under the home directory", () => {
    // The guard on the whole feature: the default must stay inside the project.
    init({ root, agents: allAgents() });
    for (const w of ["copilot", "claude", "codex", "cursor"]) {
      expect(existsSync(resolve(homedir(), `.${w}`, "hooks", "plain-english.json"))).toBe(false);
    }
  });

  it("says where a user-scoped file went, as an absolute path", () => {
    // `relative(root, ...)` would print a run of ../ that hides the location.
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (lines.push(s), true)) as typeof process.stdout.write;
    try {
      init({ root, agents: [byId("copilot")!], includeUser: true, dryRun: true });
    } finally {
      process.stdout.write = write;
    }
    const out = lines.join("");
    expect(out).toContain(resolve(homedir(), ".copilot/hooks/plain-english.json"));
    expect(out).not.toContain("../");
  });
});

describe("the chat output styles", () => {
  const set = compile(loadDefault());
  const styleDir = ".claude/output-styles";
  const local = () =>
    JSON.parse(readFileSync(resolve(root, ".claude/settings.local.json"), "utf8"));

  it("installs one style per level, so switching is a menu choice", () => {
    init({ root, agents: [byId("claude-code")!] });
    for (const level of set.chat.levels) {
      const name =
        level.id === set.chat.level ? "plain-english.md" : `plain-english-${level.id}.md`;
      const path = resolve(root, styleDir, name);
      expect(existsSync(path), `missing ${name}`).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`name: ${level.name}`);
    }
  });

  it("writes a style 0644, not 0755 like a shim", () => {
    // Nothing would ever report the wrong mode on a markdown file, which is
    // exactly why it is asserted rather than assumed.
    init({ root, agents: [byId("claude-code")!] });
    const mode = statSync(resolve(root, styleDir, "plain-english.md")).mode & 0o777;
    expect(mode & 0o111).toBe(0);
  });

  it("selects the default level, so nobody has to pick one", () => {
    init({ root, agents: [byId("claude-code")!] });
    const name = set.chat.levels.find((l) => l.id === set.chat.level)!.name;
    // .claude/settings.local.json is the file Claude Code's own /config picker
    // writes. Writing anywhere else installs a style nothing selects.
    expect(local()["outputStyle"]).toBe(name);
  });

  it("keeps every other setting when it selects one", () => {
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(
      resolve(root, ".claude/settings.local.json"),
      JSON.stringify({ outputStyle: "Explanatory", permissions: { allow: ["Bash(ls:*)"] } }),
    );
    init({ root, agents: [byId("claude-code")!] });
    expect(local()["outputStyle"]).toBe("Plain English");
    expect(local()["permissions"]).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("says what it replaced, because a style somebody chose is not ours to swap in silence", () => {
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(
      resolve(root, ".claude/settings.local.json"),
      JSON.stringify({ outputStyle: "Explanatory" }),
    );
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (lines.push(String(s)), true);
    try {
      init({ root, agents: [byId("claude-code")!] });
    } finally {
      (process.stdout as any).write = write;
    }
    expect(lines.join("")).toContain('was "Explanatory"');
  });

  it("reports nothing about styles on a second run", () => {
    // `init` promises a second run changes nothing. Listing three files it did
    // not change reads as a broken promise even though no byte moved.
    init({ root, agents: [byId("claude-code")!] });
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (lines.push(String(s)), true);
    try {
      init({ root, agents: [byId("claude-code")!] });
    } finally {
      (process.stdout as any).write = write;
    }
    expect(lines.join("")).not.toContain("output-styles");
  });

  it("puts a hand-edited style back", () => {
    init({ root, agents: [byId("claude-code")!] });
    const path = resolve(root, styleDir, "plain-english-brief.md");
    writeFileSync(path, "corrupted");
    init({ root, agents: [byId("claude-code")!] });
    expect(readFileSync(path, "utf8")).toContain("keep-coding-instructions: true");
  });

  it("tells the user the style needs a new session, which is the usual confusion", () => {
    const plan = byId("claude-code")!.plan({ prompts: {}, model: "" });
    expect(plan.notes.join(" ")).toMatch(/\/clear|new one/);
  });

  it("says a fork inherits the style and a subagent does not", () => {
    // Both halves matter. Saying only the second reads as "styles never reach
    // anything but the main loop", which is not what the documentation says.
    const notes = byId("claude-code")!.plan({ prompts: {}, model: "" }).notes.join(" ");
    expect(notes).toContain("fork");
    expect(notes).toContain("subagent");
  });

  it("installs no style for an agent that has no such concept", () => {
    for (const id of ["codex", "cursor", "copilot"]) {
      const plan = byId(id)!.plan({ prompts: {}, model: "" });
      expect(plan.files ?? [], `${id} should not install an output style`).toEqual([]);
      expect(plan.settings ?? [], `${id} should not set outputStyle`).toEqual([]);
    }
  });
});
