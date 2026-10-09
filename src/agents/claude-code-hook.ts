/**
 * What Claude Code's hooks need from its profile: reading an event and
 * writing a decision. Separate from the profile's installer, so the plugin's
 * mod carries these and not the hook-runner template (ADR-008).
 */
import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent } from "./profile.ts";
import { asRecord, editFields, issueFields, pick, pickArray } from "./fields.ts";

export const claudeCodeHook: Pick<AgentProfile, "id" | "parse" | "emit" | "emitChat"> = {
  id: "claude-code",

  parse(raw): NormalisedEvent {
    const input = asRecord(raw["tool_input"]);
    const cwd = pick(raw, "cwd") || undefined;
    const filePath = pick(input, "file_path", "notebook_path");

    switch (pick(raw, "tool_name")) {
      case "Write":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "content") } };
      case "Edit":
        // Only the inserted side.
        return { tool: "edit", cwd, input: { filePath, ...editFields(input) } };
      case "MultiEdit":
        return {
          tool: "multi-edit",
          cwd,
          input: {
            filePath,
            edits: pickArray(input, "edits").map((e) => ({
              ...editFields(asRecord(e)),
            })),
          },
        };
      case "Bash":
        return { tool: "bash", cwd, input: { command: pick(input, "command") } };
      default:
        // Includes the Linear-shaped MCP calls. The issue channel judges the
        // input directly, so it never needs the tool name.
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  emit(decision: Decision, event: HookEvent) {
    // Nothing on the post event. An agent that can surface `ask` to a human
    // before the write has already had its say, and repeating it afterwards
    // would report the same finding twice.
    if (event === "post") return { stdout: "", exitCode: 0 };
    // Writing nothing leaves the normal permission flow in charge, which is
    // what an allow means here.
    if (decision.allow) return { stdout: "", exitCode: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.reason,
        },
      }),
      exitCode: 0,
    };
  },

  /**
   * Stop and SubagentStop.
   *
   * `decision: "block"` prevents the stop and shows `reason` to the model,
   * which then writes again. `systemMessage` reaches the user either way, and
   * is how the advisory tier says something without holding up a turn.
   */
  emitChat(decision: Decision) {
    if (decision.allow && !decision.advisory) return { stdout: "", exitCode: 0 };
    if (decision.allow) {
      return {
        stdout: JSON.stringify({ systemMessage: decision.advisory }),
        exitCode: 0,
      };
    }
    // Flat. The nested `hookSpecificOutput` shape shipped here until 0.11.0 and
    // could never hold a turn: observed 2026-08-18 against Claude Code 2.1.234
    // in a real interactive session, the nested body produced no second turn at
    // all while the flat one did. See the note on the wire-format test.
    //
    // `systemMessage` rides along so the reader sees why their turn paused
    // rather than watching the model write twice for no stated reason.
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason: decision.reason,
        ...(decision.advisory ? { systemMessage: decision.advisory } : {}),
      }),
      exitCode: 0,
    };
  },
};
