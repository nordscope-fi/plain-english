/**
 * GitHub Copilot, both the CLI and the cloud coding agent.
 *
 * Installed in Claude-compatibility mode on purpose. Copilot accepts either a
 * camelCase `preToolUse` event with its own tool names, or a PascalCase
 * `PreToolUse` event where "tool names map to Claude equivalents" and matchers
 * use Claude's syntax. The compatibility path is the better documented of the
 * two, and it makes the payload identical to Claude Code's, so there is one
 * parser rather than two.
 *
 * The reply is still Copilot's own: `permissionDecision` sits at the top level
 * rather than inside `hookSpecificOutput`.
 *
 * Docs: https://docs.github.com/en/copilot/reference/hooks-reference
 */

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asArgs, asRecord, issueFields, pick, pickArray } from "./fields.ts";

const MATCHERS = {
  docs: "Write|Edit|MultiEdit",
  github: "Bash",
  issue: "mcp__linear__save_issue|mcp__linear__save_comment",
} as const;

function command(channel: string): string {
  return `npx --no-install plain-english hook ${channel} --agent copilot`;
}

export const copilot: AgentProfile = {
  id: "copilot",
  label: "GitHub Copilot",
  docs: "https://docs.github.com/en/copilot/reference/hooks-reference",

  detect(raw) {
    // The camelCase envelope is Copilot's alone. The PascalCase one is shared
    // with three other agents and proves nothing, so it is not tested here.
    // `typeof null` is "object", hence the truthiness guard.
    return typeof raw["toolName"] === "string" || !!raw["toolArgs"];
  },

  parse(raw): NormalisedEvent {
    // Compatibility mode first, since that is what `init` writes. The camelCase
    // fallback carries a hand-written config, and there it arrives as an
    // escaped JSON string rather than an object; `asArgs` handles both and
    // takes the first candidate that actually carries something.
    const input = asArgs(raw["tool_input"], raw["toolArgs"]);
    const cwd = pick(raw, "cwd") || undefined;
    const name = pick(raw, "tool_name", "toolName");
    const filePath = pick(input, "file_path", "filePath", "path");

    // PascalCase mode reports Claude's names (`Bash`, `Read`, `Write`, `Edit`);
    // native mode reports Copilot's own (`bash`, `view`, `create`, `edit`,
    // `str_replace_editor`, `apply_patch`). Lowercasing collapses the two.
    switch (name.toLowerCase()) {
      case "write":
      case "create":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "content", "text") } };
      case "edit":
      case "str_replace":
      case "str_replace_editor":
      case "apply_patch":
        return {
          tool: "edit",
          cwd,
          input: { filePath, newString: pick(input, "new_string", "newString", "new_str") },
        };
      case "multiedit":
        return {
          tool: "multi-edit",
          cwd,
          input: {
            filePath,
            edits: pickArray(input, "edits").map((e) => ({
              newString: pick(asRecord(e), "new_string", "newString"),
            })),
          },
        };
      case "bash":
      case "shell":
      case "powershell":
        return { tool: "bash", cwd, input: { command: pick(input, "command", "cmd") } };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  supportsAsk: true,

  emit(decision: Decision, event: HookEvent) {
    if (event === "post") return { stdout: "", exitCode: 0 };
    // Always exit 0, and this is the one profile where it is not merely tidy.
    //
    // `preToolUse` is the single event Copilot fails CLOSED on: an unexpected
    // non-zero exit is read as a refusal, not as "carry on". Every other agent
    // does the opposite. So a crash in this linter would stop the user working,
    // which is the outcome the whole fail-open design exists to prevent.
    if (decision.allow) return { stdout: "", exitCode: 0 };
    return {
      stdout: JSON.stringify({
        permissionDecision: decision.decision,
        permissionDecisionReason: decision.reason,
      }),
      exitCode: 0,
    };
  },

  /**
   * agentStop and subagentStop.
   *
   * Only `subagentStop` carries the reply; `Stop` documents that it does not,
   * so the main loop is answered from the session store instead. `block`
   * forces another turn and `reason` becomes the prompt for it.
   *
   * `modifiedResponse` would replace a subagent's output outright, and is not
   * used: replacing a reply means generating prose, and nothing in this package
   * generates prose. `Decision.replacement` exists for it and stays unset.
   */
  emitChat(decision: Decision, _eventName: string) {
    void _eventName;
    if (decision.allow && !decision.advisory) return { stdout: "", exitCode: 0 };
    if (decision.allow) {
      return { stdout: JSON.stringify({ systemMessage: decision.advisory }), exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason: decision.reason,
        ...(decision.replacement ? { modifiedResponse: decision.replacement } : {}),
      }),
      exitCode: 0,
    };
  },

  plan(ctx: PlanContext) {
    const entries = Object.entries(MATCHERS).map(([channel, matcher]) => ({
      type: "command",
      matcher,
      bash: command(channel),
      powershell: command(channel),
      timeoutSec: 30,
    }));

    return {
      config: [
        {
          // A standalone file, so nothing has to be merged. The cloud agent
          // reads this path and only from the default branch.
          path: ".github/hooks/plain-english.json",
          at: ["hooks", "PreToolUse"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries,
        },
        {
          // Both stop events. Copilot documents that `Stop` does not carry the
          // reply text and `SubagentStop` does, so the main loop is answered
          // from the session store the reader already opens for `lint --chat`.
          path: ".github/hooks/plain-english.json",
          at: ["hooks", "Stop"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries: [
            { type: "command", bash: command("chat"), powershell: command("chat"), timeoutSec: 10 },
          ],
        },
        {
          path: ".github/hooks/plain-english.json",
          at: ["hooks", "SubagentStop"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries: [
            { type: "command", bash: command("chat"), powershell: command("chat"), timeoutSec: 10 },
          ],
        },
        // The location the CLI actually reads. Its own `copilot help config`
        // documents the repository file above, and 1.0.78 does not load it:
        // an identical hook fires from here and not from there. Reported as
        // github/copilot-cli#1730. Only written when `init --user` asks,
        // because this is outside the project.
        ...(ctx.includeUser
          ? [
              {
                path: ".copilot/hooks/plain-english.json",
                scope: "user" as const,
                at: ["hooks", "PreToolUse"],
                shape: "flat" as const,
                defaults: { version: 1 },
                entries,
              },
            ]
          : []),
      ],
      shims: [],
      notes: [
        ...(ctx.includeUser
          ? [
              "Wrote ~/.copilot/hooks/plain-english.json as well, which is what the CLI " +
                "reads. The repository copy stays for the cloud agent.",
            ]
          : [
              "The CLI does not read .github/hooks/ as of 1.0.78, though its own config " +
                "help says it does. An identical hook fires from ~/.copilot/hooks/ and not " +
                "from here (github/copilot-cli#1730). Re-run with --user to write both, or: " +
                "mkdir -p ~/.copilot/hooks && cp .github/hooks/plain-english.json ~/.copilot/hooks/",
            ]),
        "The cloud coding agent does read .github/hooks/, from the default branch only, " +
          "so this takes effect there once it is merged.",
        "Copilot often writes files through the shell rather than a write tool. Since " +
          "0.6.0 a redirect into a markdown file is read on the github channel, so those " +
          "writes are checked too.",
        "The cloud agent treats `ask` as `deny`. Under `failOn: never` a finding is " +
          "advisory in the CLI and blocking in the cloud.",
        "Copilot has no prompt-hook equivalent here, so the semantic layer does not run. " +
          "The deterministic rules do.",
      ],
    };
  },
};
