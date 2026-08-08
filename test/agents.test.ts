import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decide, type Decision } from "../src/adapters/hook.ts";
import { PROFILES, agentIds, byId, resolveProfile } from "../src/agents/registry.ts";
import { parseApplyPatch } from "../src/agents/fields.ts";
import { compile, loadDefault, type RuleSet } from "../src/rules.ts";

const BAD = "We leverage this.";
const advisory: RuleSet = compile({ ...loadDefault(), failOn: "never" });

function inTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-agent-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The payload every agent in the registry can be driven with.
 *
 * Three of the four read snake_case `tool_name` / `tool_input`, because
 * Copilot, Codex and Factory all copied Claude Code's shape. Cursor uses the
 * same envelope with different tool names. So one fixture exercises them all,
 * and the differences show up in what comes back out.
 */
function write(dir: string, content = BAD) {
  return { tool_name: "Write", tool_input: { file_path: resolve(dir, "x.md"), content } };
}

describe("every profile reads a file write", () => {
  for (const profile of PROFILES) {
    it(`${profile.id} finds the prose in a Write`, () => {
      inTmp((dir) => {
        const event = profile.parse(write(dir));
        expect(event.tool).toBe("write");
        const d = decide(event, "docs", { projectDir: dir, ruleSet: advisory });
        expect(d.allow, `${profile.id} did not see the text`).toBe(false);
        expect(d.findings.map((f) => f.ruleId)).toContain("leverage");
      });
    });

    it(`${profile.id} lets clean prose through with no output`, () => {
      inTmp((dir) => {
        const d = decide(profile.parse(write(dir, "The cache holds parsed results.")), "docs", {
          projectDir: dir,
          ruleSet: advisory,
        });
        expect(d.allow).toBe(true);
        expect(profile.emit(d).stdout).toBe("");
      });
    });

    it(`${profile.id} never exits non-zero`, () => {
      // Only Copilot reads a non-zero exit on this event as a refusal, but a
      // linter that can stop a write by crashing is wrong on every agent.
      inTmp((dir) => {
        for (const content of [BAD, "clean text", ""]) {
          const d = decide(profile.parse(write(dir, content)), "docs", {
            projectDir: dir,
            ruleSet: advisory,
          });
          expect(profile.emit(d).exitCode, `${profile.id} on ${JSON.stringify(content)}`).toBe(0);
        }
        expect(profile.emit(profile.parse({}) as unknown as Decision).exitCode).toBe(0);
      });
    });
  }
});

/**
 * The wire formats, spelled out.
 *
 * These are the only four places the protocols genuinely differ, so they are
 * asserted literally rather than through a helper. A vendor changing one of
 * these should fail a named test, not a shared abstraction.
 */
describe("each profile speaks its own wire format", () => {
  const refusal = (dir: string, id: string) =>
    JSON.parse(byId(id)!.emit(decide(byId(id)!.parse(write(dir)), "docs", {
      projectDir: dir,
      ruleSet: advisory,
    })).stdout);

  it("claude-code nests the decision under hookSpecificOutput", () => {
    inTmp((dir) => {
      const out = refusal(dir, "claude-code");
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("leverage");
    });
  });

  it("copilot puts the decision at the top level", () => {
    inTmp((dir) => {
      const out = refusal(dir, "copilot");
      expect(out.permissionDecision).toBe("ask");
      expect(out.permissionDecisionReason).toContain("leverage");
      expect(out.hookSpecificOutput).toBeUndefined();
    });
  });

  it("codex matches claude-code, because it copied the contract", () => {
    inTmp((dir) => {
      expect(refusal(dir, "codex").hookSpecificOutput.permissionDecision).toBe("ask");
    });
  });

  it("cursor uses `permission` and addresses human and model separately", () => {
    inTmp((dir) => {
      const out = refusal(dir, "cursor");
      expect(out.permission).toBe("ask");
      expect(out.user_message).toContain("leverage");
      expect(out.agent_message).toContain("leverage");
      expect(out.permissionDecision).toBeUndefined();
    });
  });
});

describe("codex writes files with apply_patch", () => {
  it("reads the added lines out of the patch envelope", () => {
    inTmp((dir) => {
      const patch = [
        "*** Begin Patch",
        "*** Add File: x.md",
        `+${BAD}`,
        "*** End Patch",
      ].join("\n");
      const event = byId("codex")!.parse({
        tool_name: "apply_patch",
        tool_input: { input: patch },
      });
      expect(event.tool).toBe("patch");
      const d = decide(event, "docs", { projectDir: dir, ruleSet: advisory });
      expect(d.findings.map((f) => f.ruleId)).toContain("leverage");
    });
  });

  it("judges the markdown file and not the source file beside it", () => {
    // One patch can touch both. Pooling their added lines would run prose rules
    // over a TypeScript identifier, which is the false positive this splits to
    // avoid.
    inTmp((dir) => {
      const patch = [
        "*** Begin Patch",
        "*** Add File: notes.md",
        "+The cache holds parsed results.",
        "*** Add File: x.ts",
        "+const leverage = 1;",
        "*** End Patch",
      ].join("\n");
      const d = decide(
        byId("codex")!.parse({ tool_name: "apply_patch", tool_input: { input: patch } }),
        "docs",
        { projectDir: dir, ruleSet: advisory },
      );
      expect(d.allow, JSON.stringify(d.findings)).toBe(true);
    });
  });

  it("ignores removed lines, so an existing term can still be edited around", () => {
    const files = parseApplyPatch(
      ["*** Begin Patch", "*** Update File: x.md", "-We leverage this.", "+We use this.", "*** End Patch"].join("\n"),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.text).toBe("We use this.");
  });

  it("returns nothing for a patch it cannot parse", () => {
    expect(parseApplyPatch("not a patch at all")).toEqual([]);
  });
});

describe("copilot accepts its native camelCase envelope too", () => {
  it("reads toolName and toolArgs", () => {
    inTmp((dir) => {
      const event = byId("copilot")!.parse({
        toolName: "edit",
        toolArgs: { path: resolve(dir, "x.md"), new_string: BAD },
      });
      expect(event.tool).toBe("edit");
      const d = decide(event, "docs", { projectDir: dir, ruleSet: advisory });
      expect(d.findings.map((f) => f.ruleId)).toContain("leverage");
    });
  });
});

describe("choosing a profile", () => {
  it("takes an explicit id first", () => {
    expect(resolveProfile("cursor", {}, {}).id).toBe("cursor");
  });

  it("reads PLAIN_ENGLISH_AGENT when no flag is given", () => {
    expect(resolveProfile(undefined, {}, { PLAIN_ENGLISH_AGENT: "codex" }).id).toBe("codex");
  });

  it("refuses an id it does not know, rather than guessing", () => {
    expect(() => resolveProfile("windsurf", {}, {})).toThrow(/unknown agent 'windsurf'/);
    expect(() => resolveProfile("windsurf", {}, {})).toThrow(/claude-code/);
  });

  it("recognises copilot's camelCase envelope", () => {
    expect(resolveProfile(undefined, { toolName: "edit" }, {}).id).toBe("copilot");
  });

  it("recognises cursor by its tool_use_id", () => {
    expect(resolveProfile(undefined, { tool_use_id: "t1" }, {}).id).toBe("cursor");
  });

  it("falls back to claude-code when nothing is distinctive", () => {
    expect(resolveProfile(undefined, { tool_name: "Write" }, {}).id).toBe("claude-code");
  });
});

describe("the registry stays consistent with itself", () => {
  it("has no duplicate ids", () => {
    expect(new Set(agentIds()).size).toBe(agentIds().length);
  });

  it("gives every profile a plan naming its own id in the command it installs", () => {
    for (const p of PROFILES) {
      const plan = p.plan({ prompts: { docs: "", github: "", issue: "" }, model: "m" });
      const commands = [
        ...plan.shims.map((s) => s.body),
        ...plan.config.flatMap((c) => JSON.stringify(c.entries)),
      ].join(" ");
      expect(commands, `${p.id} does not pass --agent ${p.id}`).toContain(`--agent ${p.id}`);
      expect(plan.config.length, `${p.id} installs nothing`).toBeGreaterThan(0);
    }
  });

  it("wires all three channels for every agent", () => {
    for (const p of PROFILES) {
      const plan = p.plan({ prompts: { docs: "", github: "", issue: "" }, model: "m" });
      const text = JSON.stringify(plan.config) + plan.shims.map((s) => s.body).join("");
      for (const channel of ["docs", "github", "issue"]) {
        expect(text, `${p.id} has no ${channel} hook`).toContain(`hook ${channel}`);
      }
    }
  });

  it("records what the installer cannot do for the user", () => {
    // Codex will not run an unapproved hook and Copilot's cloud agent turns an
    // ask into a deny. Both are silent surprises unless init says so.
    expect(byId("codex")!.plan({ prompts: {}, model: "m" }).notes.join(" ")).toContain("/hooks");
    expect(byId("copilot")!.plan({ prompts: {}, model: "m" }).notes.join(" ")).toContain("deny");
  });
});
