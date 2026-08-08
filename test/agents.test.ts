import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ackPath, decide, type Decision } from "../src/adapters/hook.ts";
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
        expect(profile.emit(d, "pre").stdout).toBe("");
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
          expect(profile.emit(d, "pre").exitCode, `${profile.id} on ${JSON.stringify(content)}`).toBe(0);
        }
        expect(profile.emit(profile.parse({}) as unknown as Decision, "pre").exitCode).toBe(0);
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
    }), "pre").stdout);

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

  it("cursor allows and tells the model, because it discards `ask`", () => {
    // "`ask` is accepted by the schema but not enforced for preToolUse today",
    // per Cursor's own docs. Emitting it would allow the write and report
    // nothing. `additional_context` on preToolUse is staff-confirmed, so the
    // advisory tier goes there rather than to the broken postToolUse one.
    inTmp((dir) => {
      const out = refusal(dir, "cursor");
      expect(out.permission).toBe("allow");
      expect(out.additional_context).toContain("leverage");
      expect(out.permissionDecision).toBeUndefined();
    });
  });

  it("cursor refuses outright under strict mode", () => {
    inTmp((dir) => {
      const cursor = byId("cursor")!;
      const d = decide(cursor.parse(write(dir)), "docs", {
        projectDir: dir,
        ruleSet: compile({ ...loadDefault(), failOn: "error" }),
      });
      const out = JSON.parse(cursor.emit(d, "pre").stdout);
      expect(out.permission).toBe("deny");
      expect(out.user_message).toContain("leverage");
      expect(out.agent_message).toContain("leverage");
    });
  });
});

/**
 * Codex and Cursor both parse `ask` and then allow anyway, so under the default
 * `failOn: never` the pre hook alone reports nothing to anybody. That is the
 * shipped-and-does-nothing failure this tier exists to remove.
 */
describe("the advisory tier reaches agents that discard `ask`", () => {
  it("declares which agents honour ask", () => {
    expect(byId("claude-code")!.supportsAsk).toBe(true);
    expect(byId("copilot")!.supportsAsk).toBe(true);
    expect(byId("codex")!.supportsAsk).toBe(false);
    expect(byId("cursor")!.supportsAsk).toBe(false);
  });

  it("codex feeds the finding back as additionalContext on the post event", () => {
    inTmp((dir) => {
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      const out = JSON.parse(codex.emit(d, "post").stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(out.hookSpecificOutput.additionalContext).toContain("leverage");
    });
  });

  it("codex sends nothing Codex would reject", () => {
    // Codex refuses the whole hook output on an unrecognised key, so a stray
    // `permissionDecision` under a PostToolUse event throws the finding away
    // rather than being ignored.
    inTmp((dir) => {
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      const out = JSON.parse(codex.emit(d, "post").stdout);
      expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
      expect(Object.keys(out.hookSpecificOutput).sort()).toEqual([
        "additionalContext",
        "hookEventName",
      ]);
    });
  });

  it("codex still speaks on the pre event, so a stale config is no worse", () => {
    // Someone who upgrades without re-running init has pre entries only. If
    // this went silent the upgrade would switch Codex off with no error.
    inTmp((dir) => {
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      expect(codex.emit(d, "pre").stdout).not.toBe("");
    });
  });

  it("installs a post hook for codex and none for the agents that can ask", () => {
    const ctx = { prompts: { docs: "", github: "", issue: "" }, model: "m" };
    const events = (id: string) =>
      byId(id)!.plan(ctx).config.map((c) => c.at.join("."));
    expect(events("codex")).toContain("hooks.PostToolUse");
    expect(events("cursor")).toEqual(["hooks.preToolUse"]);
    expect(events("claude-code")).toEqual(["hooks.PreToolUse"]);
    expect(events("copilot")).toEqual(["hooks.PreToolUse"]);
  });

  it("says nothing on either event when a `touch`ed ack has waived the channel", () => {
    // The hatch has to silence the advice as well as the refusal, or an agent
    // that can only be told things keeps being told this one for ten minutes.
    inTmp((dir) => {
      writeFileSync(ackPath("docs", dir), "");
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      expect(d.allow).toBe(true);
      expect(d.advisory).toBeUndefined();
      expect(codex.emit(d, "post").stdout).toBe("");
      expect(codex.emit(d, "pre").stdout).toBe("");
    });
  });

  it("honours failOn: warn, which used to mean the same as error", () => {
    // Only error-severity findings reached the decision, so a project asking
    // for warnings to matter got nothing from any agent while `cmdLint`
    // honoured the same setting.
    inTmp((dir) => {
      const warnOnly = "The OIDC check runs first.";
      const strictWarn = compile({ ...loadDefault(), failOn: "warn" });
      const claude = byId("claude-code")!;
      const d = decide(claude.parse(write(dir, warnOnly)), "docs", {
        projectDir: dir,
        ruleSet: strictWarn,
      });
      expect(d.allow, "a warning did not reach the decision").toBe(false);
      expect(d.findings.map((f) => f.ruleId)).toContain("unglossed-term");
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
