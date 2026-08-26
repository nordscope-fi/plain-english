/** Qwen Code hooks, using its documented Claude-shaped command protocol. */

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asRecord, issueFields, pick } from "./fields.ts";
import { HOOK_RUNNER, runnerCommand, runnerPath } from "./runner.ts";

const RUNNER = runnerPath(".qwen");
const CHANNELS = [
  { channel: "docs", matcher: "write_file|edit" },
  { channel: "github", matcher: "run_shell_command" },
  { channel: "issue", matcher: "mcp_.*_save_(issue|comment)" },
] as const;

export const qwen: AgentProfile = {
  id: "qwen",
  label: "Qwen Code",
  docs: "https://qwenlm.github.io/qwen-code-docs/",

  detect(raw) {
    return typeof raw["hook_event_name"] === "string" && !!process.env["QWEN_PROJECT_DIR"];
  },

  parse(raw): NormalisedEvent {
    const input = asRecord(raw["tool_input"]);
    const cwd = pick(raw, "cwd") || undefined;
    const filePath = pick(input, "file_path", "path");
    switch (pick(raw, "tool_name")) {
      case "write_file":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "content") } };
      case "edit":
        return { tool: "edit", cwd, input: { filePath, newString: pick(input, "new_string") } };
      case "run_shell_command":
        return { tool: "bash", cwd, input: { command: pick(input, "command") } };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  // `ask` becomes a denial in headless runs and background subagents. An
  // advisory must therefore be an explicit allow carrying additionalContext.
  supportsAsk: false,

  emit(decision: Decision, event: HookEvent) {
    if (event === "post") return { stdout: "", exitCode: 0 };
    if (decision.allow) return { stdout: "", exitCode: 0 };
    const advisory = decision.decision === "ask";
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: advisory ? "allow" : "deny",
          permissionDecisionReason: advisory ? decision.advisory : decision.reason,
          ...(advisory ? { additionalContext: decision.advisory } : {}),
        },
      }),
      exitCode: 0,
    };
  },

  emitChat(decision: Decision, _eventName: string) {
    void _eventName;
    if (decision.allow && !decision.advisory) return { stdout: "", exitCode: 0 };
    if (decision.allow) return { stdout: JSON.stringify({ systemMessage: decision.advisory }), exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "block", reason: decision.reason }), exitCode: 0 };
  },

  plan(_ctx: PlanContext) {
    const command = (channel: string) => runnerCommand(RUNNER, channel, "qwen");
    return {
      config: [
        {
          path: ".qwen/settings.json",
          at: ["hooks", "PreToolUse"],
          shape: "nested",
          entries: CHANNELS.map((c) => ({ matcher: c.matcher, hooks: [{ type: "command", name: `plain-english-${c.channel}`, command: command(c.channel), timeout: 30000 }] })),
        },
        {
          path: ".qwen/settings.json",
          at: ["hooks", "Stop"],
          shape: "nested",
          entries: [{ matcher: "*", hooks: [{ type: "command", name: "plain-english-chat", command: command("chat"), timeout: 10000 }] }],
        },
        {
          path: ".qwen/settings.json",
          at: ["hooks", "SubagentStop"],
          shape: "nested",
          entries: [{ matcher: "*", hooks: [{ type: "command", name: "plain-english-chat", command: command("chat"), timeout: 10000 }] }],
        },
      ],
      shims: [{ path: RUNNER, body: HOOK_RUNNER }],
      notes: [
        "Qwen loads .qwen/settings.json only after the project hook fingerprint is trusted.",
        "Advisory findings explicitly allow the call, so headless runs and subagents do not turn them into denials.",
      ],
    };
  },
};
