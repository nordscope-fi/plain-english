/** Google Gemini CLI hooks, following the native BeforeTool/AfterAgent API. */

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asRecord, issueFields, pick } from "./fields.ts";
import { HOOK_RUNNER, runnerCommand, runnerPath } from "./runner.ts";

const RUNNER = runnerPath(".gemini");
const CHANNELS = [
  { channel: "docs", matcher: "write_file|replace" },
  { channel: "github", matcher: "run_shell_command" },
  { channel: "issue", matcher: "mcp_.*_save_(issue|comment)" },
] as const;

export const gemini: AgentProfile = {
  id: "gemini",
  label: "Google Gemini CLI",
  docs: "https://geminicli.com/docs/hooks/reference/",

  detect(raw) {
    return typeof raw["hook_event_name"] === "string" &&
      ["BeforeTool", "AfterTool", "AfterAgent"].includes(String(raw["hook_event_name"]));
  },

  parse(raw): NormalisedEvent {
    const input = asRecord(raw["tool_input"]);
    const cwd = pick(raw, "cwd") || undefined;
    const filePath = pick(input, "file_path", "path");
    switch (pick(raw, "tool_name")) {
      case "write_file":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "content") } };
      case "replace":
        return { tool: "edit", cwd, input: { filePath, newString: pick(input, "new_string") } };
      case "run_shell_command":
        return { tool: "bash", cwd, input: { command: pick(input, "command") } };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  // BeforeTool has no interactive ask response. Advisory text is delivered by
  // the matching AfterTool hook through additionalContext.
  supportsAsk: false,

  emit(decision: Decision, event: HookEvent) {
    if (event === "post") {
      if (!decision.advisory) return { stdout: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: decision.advisory },
        }),
        exitCode: 0,
      };
    }
    if (decision.decision !== "deny") return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "deny", reason: decision.reason }), exitCode: 0 };
  },

  emitChat(decision: Decision, _eventName: string) {
    void _eventName;
    if (decision.allow && !decision.advisory) return { stdout: "", exitCode: 0 };
    if (decision.allow) {
      return { stdout: JSON.stringify({ systemMessage: decision.advisory }), exitCode: 0 };
    }
    return { stdout: JSON.stringify({ decision: "deny", reason: decision.reason }), exitCode: 0 };
  },

  plan(_ctx: PlanContext) {
    const toolEntries = (event: "pre" | "post") =>
      CHANNELS.map((c) => ({
        matcher: c.matcher,
        hooks: [
          {
            type: "command",
            name: `plain-english-${c.channel}-${event}`,
            command: runnerCommand(RUNNER, c.channel, "gemini") + ` --event ${event}`,
            timeout: 30000,
          },
        ],
      }));
    return {
      config: [
        { path: ".gemini/settings.json", at: ["hooks", "BeforeTool"], shape: "nested", entries: toolEntries("pre") },
        { path: ".gemini/settings.json", at: ["hooks", "AfterTool"], shape: "nested", entries: toolEntries("post") },
        {
          path: ".gemini/settings.json",
          at: ["hooks", "AfterAgent"],
          shape: "nested",
          entries: [{ matcher: "*", hooks: [{ type: "command", name: "plain-english-chat", command: runnerCommand(RUNNER, "chat", "gemini"), timeout: 10000 }] }],
        },
      ],
      shims: [{ path: RUNNER, body: HOOK_RUNNER }],
      notes: [
        "Gemini loads project hooks only after the folder and changed hook fingerprints are trusted.",
        "Advisory findings arrive after the tool result; strict findings are refused before the tool runs.",
      ],
    };
  },
};
