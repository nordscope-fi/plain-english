import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("codex tells the model instead of asking, because `ask` fails the run", () => {
    // codex-cli 0.147.0 reports a hook that returns `ask` as "PreToolUse
    // Failed" and delivers the reason to nobody. `additionalContext` on the
    // same event arrives as a developer message and the run reports Completed.
    inTmp((dir) => {
      const out = refusal(dir, "codex");
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.additionalContext).toContain("leverage");
      expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    });
  });

  it("codex refuses with the one decision it acts on", () => {
    inTmp((dir) => {
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", {
        projectDir: dir,
        ruleSet: compile({ ...loadDefault(), failOn: "error" }),
      });
      const out = JSON.parse(codex.emit(d, "pre").stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      // The schema rejects a deny whose reason is empty.
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("leverage");
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
 * Neither Codex nor Cursor surfaces `ask` to a human. Cursor accepts it and
 * allows; Codex fails the hook run outright. Either way the pre hook alone
 * reports nothing to anybody under the default `failOn: never`, which is the
 * shipped-and-does-nothing failure this tier exists to remove.
 */
describe("the advisory tier reaches agents that discard `ask`", () => {
  it("declares which agents honour ask", () => {
    expect(byId("claude-code")!.supportsAsk).toBe(true);
    expect(byId("copilot")!.supportsAsk).toBe(true);
    expect(byId("codex")!.supportsAsk).toBe(false);
    expect(byId("cursor")!.supportsAsk).toBe(false);
  });

  it("codex sends nothing Codex would reject", () => {
    // Both hook output schemas set additionalProperties: false, so a stray key
    // throws the whole reply away rather than being ignored.
    inTmp((dir) => {
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      const out = JSON.parse(codex.emit(d, "pre").stdout);
      expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
      expect(Object.keys(out.hookSpecificOutput).sort()).toEqual([
        "additionalContext",
        "hookEventName",
      ]);
    });
  });

  it("codex says nothing on the post event, so a stale config does not repeat itself", () => {
    // Before the advisory moved to the pre event, `init` wrote a second hook
    // pointing here. Somebody who upgrades the package without re-running it
    // still has that entry, and both speaking would report one finding twice.
    inTmp((dir) => {
      const codex = byId("codex")!;
      const d = decide(codex.parse(write(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      expect(codex.emit(d, "post").stdout).toBe("");
    });
  });

  it("installs no post-tool event, now that the pre event can speak", () => {
    // The point of this assertion is what is absent. The advisory moved onto
    // the pre event in 0.7.0, and a leftover PostToolUse hook would spawn a
    // process per tool call to say nothing.
    const ctx = { prompts: { docs: "", github: "", issue: "" }, model: "m" };
    const events = (id: string) =>
      byId(id)!.plan(ctx).config.map((c) => c.at.join("."));
    for (const id of ["codex", "cursor", "claude-code", "copilot"]) {
      expect(events(id).some((e) => /post/i.test(e)), `${id} installs a post hook`).toBe(false);
      expect(events(id).some((e) => /pretooluse/i.test(e)), `${id} has no pre hook`).toBe(true);
    }
  });

  it("puts the chat gate on the stop events, and only where one carries the reply", () => {
    const ctx = { prompts: { docs: "", github: "", issue: "" }, model: "m" };
    const events = (id: string) =>
      byId(id)!.plan(ctx).config.map((c) => c.at.join("."));

    // Three agents document an event carrying the assistant's final message.
    for (const id of ["claude-code", "codex", "copilot"]) {
      expect(events(id), `${id} should gate chat`).toContain("hooks.Stop");
      expect(events(id), `${id} should gate subagent chat`).toContain("hooks.SubagentStop");
      expect(byId(id)!.emitChat, `${id} should speak the stop format`).toBeTypeOf("function");
    }

    // Cursor documents `stop` and `afterAgentResponse`, and its CLI is reported
    // to dispatch only the two shell events. Installing a hook that never fires
    // is the failure docs/verifying-an-adapter.md exists to prevent, so chat on
    // Cursor is ungated and says so.
    expect(events("cursor").some((e) => /stop/i.test(e))).toBe(false);
    expect(byId("cursor")!.emitChat).toBeUndefined();
  });

  it("codex asks for the timeout under the key Codex actually reads", () => {
    // It reports the value back as `timeoutSec`, but a `timeoutSec` in the
    // config is ignored and the hook silently gets the 600 second default.
    // Measured through Codex's own hooks/list on 0.147.0.
    const ctx = { prompts: { docs: "", github: "", issue: "" }, model: "m" };
    const entries = byId("codex")!.plan(ctx).config[0]!.entries as {
      hooks: Record<string, unknown>[];
    }[];
    for (const group of entries) {
      expect(Object.keys(group.hooks[0]!)).toContain("timeout");
      expect(Object.keys(group.hooks[0]!)).not.toContain("timeoutSec");
    }
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

/**
 * A hook Codex will never run looks exactly like a linter with nothing to say,
 * which is the failure this project keeps meeting. Both causes below were
 * measured against codex-cli 0.147.0 through its own `hooks/list`.
 */
describe("doctor can name the two ways a Codex hook does nothing", () => {
  const withHome = <T,>(home: string | undefined, fn: () => T): T => {
    const before = process.env["CODEX_HOME"];
    if (home === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = home;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = before;
    }
  };

  const install = (dir: string) => {
    mkdirSync(resolve(dir, ".codex"), { recursive: true });
    writeFileSync(resolve(dir, ".codex", "hooks.json"), "{}");
  };

  it("says nothing when the hooks are not installed here", () => {
    inTmp((dir) => {
      expect(byId("codex")!.diagnose?.(dir) ?? []).toEqual([]);
    });
  });

  it("reports an untrusted project, because Codex reads no hooks in one", () => {
    inTmp((dir) => {
      install(dir);
      const home = resolve(dir, "codex-home");
      mkdirSync(home, { recursive: true });
      const out = withHome(home, () => byId("codex")!.diagnose!(dir));
      expect(out.join(" ")).toContain("not trusted");
      expect(out.join(" ")).toContain("trust_level");
    });
  });

  it("is quiet once the project is trusted", () => {
    inTmp((dir) => {
      install(dir);
      const home = resolve(dir, "codex-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        resolve(home, "config.toml"),
        `[projects."${dir}"]\ntrust_level = "trusted"\n`,
      );
      expect(withHome(home, () => byId("codex")!.diagnose!(dir))).toEqual([]);
    });
  });

  it("does not read another project's trust entry as this one's", () => {
    inTmp((dir) => {
      install(dir);
      const home = resolve(dir, "codex-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        resolve(home, "config.toml"),
        `[projects."${dir}-other"]\ntrust_level = "trusted"\n`,
      );
      expect(withHome(home, () => byId("codex")!.diagnose!(dir)).join(" ")).toContain(
        "not trusted",
      );
    });
  });

  it("reports a linked worktree, whose own hooks file Codex ignores", () => {
    // A linked worktree has a `.git` file rather than a directory, and Codex
    // resolves the hook path to the main working tree: with the main file
    // removed, `hooks/list` finds nothing at all from inside the worktree.
    inTmp((dir) => {
      install(dir);
      const home = resolve(dir, "codex-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(resolve(home, "config.toml"), `[projects."${dir}"]\ntrust_level = "trusted"\n`);
      writeFileSync(resolve(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/probe\n");
      expect(withHome(home, () => byId("codex")!.diagnose!(dir)).join(" ")).toContain("worktree");
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

/**
 * Mistral Vibe.
 *
 * Verified against vibe 2.24.1. Its payload is the only one in the registry
 * that identifies itself: `hook_event_name` is `pre_tool`, `post_tool` or
 * `post_agent`, a vocabulary no other agent uses.
 *
 * The reply is flat, not nested, and the vocabulary is `allow` / `deny` with
 * no `ask` in it. Source: `vibe/core/hooks/models.py`, class
 * `HookStructuredResponse`.
 */
describe("mistral vibe", () => {
  const vibeWrite = (dir: string, content = BAD) => ({
    hook_event_name: "pre_tool",
    session_id: "s1",
    transcript_path: "",
    cwd: dir,
    tool_name: "write_file",
    tool_call_id: "call_1",
    tool_input: { file_path: resolve(dir, "x.md"), content },
  });

  it("is in the registry", () => {
    expect(agentIds()).toContain("vibe");
  });

  it("reads the prose out of a write_file", () => {
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      const event = vibe.parse(vibeWrite(dir));
      expect(event.tool).toBe("write");
      const d = decide(event, "docs", { projectDir: dir, ruleSet: advisory });
      expect(d.allow).toBe(false);
      expect(d.findings.map((f) => f.ruleId)).toContain("leverage");
    });
  });

  it("reads the prose out of an edit", () => {
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      const event = vibe.parse({
        ...vibeWrite(dir),
        tool_name: "edit",
        tool_input: { file_path: resolve(dir, "x.md"), old_string: "a", new_string: BAD },
      });
      expect(event.tool).toBe("edit");
      const d = decide(event, "docs", { projectDir: dir, ruleSet: advisory });
      expect(d.findings.map((f) => f.ruleId)).toContain("leverage");
    });
  });

  it("recognises its own payload without being told", () => {
    expect(resolveProfile(undefined, { hook_event_name: "pre_tool" }).id).toBe("vibe");
    expect(resolveProfile(undefined, { hook_event_name: "post_agent" }).id).toBe("vibe");
  });

  it("advises with system_message, because pre_tool has no ask", () => {
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      expect(vibe.supportsAsk).toBe(false);
      const d = decide(vibe.parse(vibeWrite(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      const out = JSON.parse(vibe.emit(d, "pre").stdout);
      expect(out.system_message).toContain("leverage");
      expect(out.decision).toBeUndefined();
    });
  });

  it("refuses flat, with no hookSpecificOutput anywhere", () => {
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      const d = decide(vibe.parse(vibeWrite(dir)), "docs", {
        projectDir: dir,
        ruleSet: compile({ ...loadDefault(), failOn: "error" }),
      });
      const out = JSON.parse(vibe.emit(d, "pre").stdout);
      expect(out.decision).toBe("deny");
      expect(out.reason).toContain("leverage");
      expect(out.hookSpecificOutput).toBeUndefined();
      expect(out.permissionDecision).toBeUndefined();
    });
  });

  it("does not self-name in the reason, because Vibe prefixes it already", () => {
    // Vibe wraps a pre_tool denial as `Tool 'X' was denied by hook 'Y': reason`
    // and prefixes hook-end content with `[hook-name]`. A reason that opened
    // with "plain-english:" would read as "hook 'plain-english': plain-english:".
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      const d = decide(vibe.parse(vibeWrite(dir)), "docs", {
        projectDir: dir,
        ruleSet: compile({ ...loadDefault(), failOn: "error" }),
      });
      const out = JSON.parse(vibe.emit(d, "pre").stdout);
      expect(out.reason.startsWith("plain-english")).toBe(false);
    });
  });

  it("blocks a chat reply on the post_agent event", () => {
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      const d = decide(vibe.parse(vibeWrite(dir)), "docs", {
        projectDir: dir,
        ruleSet: compile({ ...loadDefault(), failOn: "error" }),
      });
      const out = JSON.parse(vibe.emitChat!(d, "post_agent").stdout);
      expect(out.decision).toBe("deny");
      expect(out.reason).toContain("leverage");
    });
  });

  it("says nothing after the fact, since post_tool cannot unwrite a file", () => {
    inTmp((dir) => {
      const vibe = byId("vibe")!;
      const d = decide(vibe.parse(vibeWrite(dir)), "docs", { projectDir: dir, ruleSet: advisory });
      expect(vibe.emit(d, "post").stdout).toBe("");
    });
  });
});


/**
 * The Vibe trust gate.
 *
 * `.vibe/hooks.toml` is read only in a folder the user has trusted, and
 * untrusted it produces no hooks and no error. That is the shipped-and-does-
 * nothing failure `docs/verifying-an-adapter.md` opens with, so `doctor` has
 * to be able to name it.
 */
describe("vibe trust diagnosis", () => {
  const vibe = () => byId("vibe")!;

  /**
   * A temporary home and a temporary repo, with the trust file written to say
   * whatever the test needs about that repo.
   *
   * `body` is a template: `{{ROOT}}` becomes the repo path. Writing the paths
   * in by hand would make each test assert against a string it also authored,
   * which is the assertion that cannot fail.
   */
  function withTrust<T>(
    body: string | null,
    fn: (root: string) => T,
    opts: { installed?: boolean } = {},
  ): T {
    const home = mkdtempSync(resolve(tmpdir(), "pe-vibe-home-"));
    const root = mkdtempSync(resolve(tmpdir(), "pe-vibe-repo-"));
    const before = process.env["VIBE_HOME"];
    process.env["VIBE_HOME"] = home;
    try {
      if (opts.installed !== false) {
        mkdirSync(resolve(root, ".vibe"), { recursive: true });
        writeFileSync(resolve(root, ".vibe/hooks.toml"), "[[hooks]]\n");
      }
      if (body !== null) {
        writeFileSync(resolve(home, "trusted_folders.toml"), body.replaceAll("{{ROOT}}", root));
      }
      return fn(root);
    } finally {
      if (before === undefined) delete process.env["VIBE_HOME"];
      else process.env["VIBE_HOME"] = before;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("stays quiet when the folder is trusted, one entry per line", () => {
    withTrust('trusted = [\n    "/somewhere/else",\n    "{{ROOT}}",\n]\nuntrusted = []\n', (root) => {
      expect(vibe().diagnose!(root)).toEqual([]);
    });
  });

  it("reads a single-line list too", () => {
    withTrust('trusted = ["{{ROOT}}"]\nuntrusted = []\n', (root) => {
      expect(vibe().diagnose!(root)).toEqual([]);
    });
  });

  it("does not read the untrusted list as the trusted one", () => {
    withTrust('trusted = []\nuntrusted = [\n    "{{ROOT}}",\n]\n', (root) => {
      expect(vibe().diagnose!(root)).toHaveLength(1);
    });
  });

  it("names the requirement when the folder is absent from the list", () => {
    withTrust('trusted = [\n    "/somewhere/else",\n]\n', (root) => {
      const line = vibe().diagnose!(root)[0]!;
      expect(line).toContain("not trusted");
      expect(line).toContain("hooks.toml");
    });
  });

  it("does not offer --trust as the fix, because it does not persist", () => {
    // vibe --help, 2.24.1: "Trust the working directory for this invocation
    // only (not persisted to trusted_folders.toml)". Offering it as the fix
    // would send somebody back to the same silent state on the next run.
    withTrust(null, (root) => {
      const line = vibe().diagnose!(root)[0]!;
      expect(line).toContain("--trust");
      expect(line).toContain("this invocation only");
    });
  });

  it("stays quiet where this package is not installed at all", () => {
    // `policy` calls diagnose on every profile, including agents a project does
    // not use, and writes the result into a committed document. Reporting a
    // trust problem about an agent with no hooks here put an absolute home path
    // into a public file, and `npm run check:refs` caught it. Codex guards the
    // same way and for the same reason: there is nothing to be wrong about
    // until something is installed.
    withTrust(null, (root) => {
      expect(vibe().diagnose!(root)).toEqual([]);
    }, { installed: false });
  });
});
