/** Antigravity CLI uses camelCase envelopes and PascalCase tool arguments. */

import type { Decision } from "../adapters/hook.ts";
import { CHAT_HOOK_TIMEOUT_SECONDS } from "../chat/budget.ts";
import { asRecord, issueFields, pick, pickArray } from "./fields.ts";
import type { AgentProfile } from "./profile.ts";
import { HOOK_RUNNER, runnerCommand, runnerPath } from "./runner.ts";

const RUNNER = runnerPath(".agents");
// Antigravity starts workspace hooks beside .agents/hooks.json, not at the
// workspace root. The runner itself anchors the CLI back to that root.
const COMMAND_RUNNER = "hooks/plain-english.mjs";

export function antigravityCwd(raw: Record<string, unknown>): string | undefined {
  const input = asRecord(asRecord(raw["toolCall"])["args"]);
  return pick(input, "Cwd") || pick(raw, "cwd") ||
    pickArray(raw, "workspacePaths").find((path): path is string => typeof path === "string") || undefined;
}

export const antigravity: AgentProfile = {
  id: "antigravity",
  label: "Google Antigravity CLI",
  docs: "https://antigravity.google/docs/hooks/",
  detect(raw) {
    return typeof raw["conversationId"] === "string" &&
      (Array.isArray(raw["workspacePaths"]) || typeof raw["toolCall"] === "object");
  },
  parse(raw) {
    const call = asRecord(raw["toolCall"]);
    const input = asRecord(call["args"]);
    const cwd = antigravityCwd(raw);
    const filePath = pick(input, "TargetFile");
    switch (call["name"]) {
      case "write_to_file":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "CodeContent") } };
      case "replace_file_content":
        return { tool: "edit", cwd, input: {
          filePath, newString: pick(input, "ReplacementContent"), oldString: pick(input, "TargetContent"),
        } };
      case "multi_replace_file_content":
        return { tool: "multi-edit", cwd, input: {
          filePath,
          edits: pickArray(input, "ReplacementChunks").map((chunk) => ({
            newString: pick(asRecord(chunk), "ReplacementContent"),
            oldString: pick(asRecord(chunk), "TargetContent"),
          })),
        } };
      case "run_command":
        return { tool: "bash", cwd, input: { command: pick(input, "CommandLine") } };
      case "call_mcp_tool":
        // The native matcher sees the relay, not the underlying MCP name.
        // Keep unrelated MCP tools out of the issue channel.
        return { tool: "other", cwd, input:
          /(?:^|[_:-])save_(?:issue|comment)$/.test(pick(input, "ToolName"))
            ? issueFields(asRecord(input["Arguments"])) : {},
        };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },
  supportsAsk: true,
  supportsModelChecks: false,
  emit(decision: Decision, event) {
    if (event === "post" || decision.decision === "allow" || !decision.decision) {
      return { stdout: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ decision: decision.decision, reason: decision.reason }), exitCode: 0 };
  },
  emitChat(decision: Decision) {
    if (decision.allow) return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "continue", reason: decision.reason }), exitCode: 0 };
  },
  plan() {
    const channels = [
      { channel: "docs", matcher: "write_to_file|replace_file_content|multi_replace_file_content|run_command" },
      { channel: "github", matcher: "run_command" },
      { channel: "issue", matcher: "call_mcp_tool|.*save_(issue|comment).*" },
    ];
    return {
      config: [
        ...channels.map(({ channel, matcher }) => ({
          path: ".agents/hooks.json",
          at: [`plain-english-${channel}`, "PreToolUse"],
          shape: "nested" as const,
          entries: [{ matcher, hooks: [{ type: "command", command: runnerCommand(COMMAND_RUNNER, channel, "antigravity"), timeout: 30 }] }],
        })),
        {
          path: ".agents/hooks.json",
          at: ["plain-english-chat", "Stop"],
          shape: "flat" as const,
          entries: [{ type: "command", command: runnerCommand(COMMAND_RUNNER, "chat", "antigravity"), timeout: CHAT_HOOK_TIMEOUT_SECONDS }],
        },
      ],
      shims: [{ path: RUNNER, body: HOOK_RUNNER }],
      notes: [
        "Antigravity reads .agents/hooks.json; Gemini settings hooks are not imported.",
        "Interactive sessions require workspace trust. Inspect loaded hooks with /hooks.",
        "Advisory tool findings ask for approval; strict findings deny the tool call.",
        "Strict chat findings request a rewrite. The Stop event cannot deliver advisory chat context.",
      ],
    };
  },
};
