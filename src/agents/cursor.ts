/**
 * Cursor.
 *
 * Same event model as the other three, different words for the answer:
 * `permission` rather than `permissionDecision`, and two separate reason
 * fields, one shown to the human and one handed back to the model. Splitting
 * them is a better design than the shared string everyone else uses, so both
 * carry the full finding.
 *
 * One caveat is Cursor's own. Its documentation states there is no
 * `beforeFileEdit` hook and that only `beforeReadFile` can block file access,
 * while separately documenting `preToolUse` as generic over all tool types with
 * a `Write` matcher. Those two claims disagree. This profile takes the
 * `preToolUse` route; docs/agents.md records what was observed against a
 * running Cursor rather than what the docs promise.
 *
 * The argument names inside a Write are not published at all, which is why
 * `pick` is given several spellings.
 *
 * Docs: https://cursor.com/docs/hooks
 */

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asRecord, issueFields, pick, pickArray } from "./fields.ts";
import { HOOK_RUNNER, runnerCommand, runnerPath } from "./runner.ts";

const RUNNER = runnerPath(".cursor");

const CHANNELS = [
  { channel: "docs", matcher: "Write|Edit|MultiEdit" },
  { channel: "github", matcher: "Shell" },
  { channel: "issue", matcher: "mcp__linear__save_issue|mcp__linear__save_comment" },
] as const;

export const cursor: AgentProfile = {
  id: "cursor",
  label: "Cursor",
  docs: "https://cursor.com/docs/hooks",

  detect(raw) {
    return typeof raw["tool_use_id"] === "string" || typeof raw["agent_message"] === "string";
  },

  parse(raw): NormalisedEvent {
    const input = asRecord(raw["tool_input"]);
    // Cursor sends no `cwd`. It sends `workspace_roots`, confirmed against a
    // live 2026.08.04 CLI, so without this the project scope falls back to
    // wherever the hook process happened to start.
    const root = pickArray(raw, "workspace_roots")[0];
    const cwd = pick(raw, "cwd") || (typeof root === "string" ? root : "") || undefined;
    const filePath = pick(input, "file_path", "path", "target_file", "filePath");

    switch (pick(raw, "tool_name")) {
      case "Write":
        return {
          tool: "write",
          cwd,
          input: { filePath, content: pick(input, "content", "contents", "text") },
        };
      case "Edit":
        return {
          tool: "edit",
          cwd,
          input: { filePath, newString: pick(input, "new_string", "new_str", "replacement") },
        };
      case "MultiEdit":
        return {
          tool: "multi-edit",
          cwd,
          input: {
            filePath,
            edits: pickArray(input, "edits").map((e) => ({
              newString: pick(asRecord(e), "new_string", "new_str"),
            })),
          },
        };
      case "Shell":
      case "Bash":
        return { tool: "bash", cwd, input: { command: pick(input, "command", "cmd") } };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  // "`ask` is accepted by the schema but not enforced for preToolUse today",
  // per Cursor's own hooks documentation. It degrades to allow.
  supportsAsk: false,

  emit(decision: Decision, event: HookEvent) {
    // Current Cursor documents additional_context on postToolUse, not on the
    // generic pre event. That makes the post event the advisory channel.
    if (event === "post") {
      if (!decision.advisory) return { stdout: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({ additional_context: decision.advisory }),
        exitCode: 0,
      };
    }
    if (decision.allow) return { stdout: "", exitCode: 0 };

    if (decision.decision === "ask") {
      // Let the tool run. Its post event carries the advisory to the model.
      return { stdout: "", exitCode: 0 };
    }

    return {
      stdout: JSON.stringify({
        permission: decision.decision,
        // The human needs the finding to judge it; the model needs it to fix
        // the text. Same content, two audiences, and Cursor is the only agent
        // that lets us address them separately.
        user_message: decision.reason,
        agent_message: decision.reason,
      }),
      exitCode: 0,
    };
  },

  emitChat(decision: Decision, _eventName: string) {
    void _eventName;
    if (decision.allow || decision.decision === "ask") return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify({ followup_message: decision.reason }), exitCode: 0 };
  },

  plan(_ctx: PlanContext) {
    const command = (channel: string, event: HookEvent = "pre") =>
      runnerCommand(RUNNER, channel, "cursor") + ` --event ${event}`;
    return {
      config: [
        {
          path: ".cursor/hooks.json",
          at: ["hooks", "preToolUse"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries: CHANNELS.map((c) => ({
            type: "command",
            matcher: c.matcher,
            command: command(c.channel),
            timeout: 30,
          })),
        },
        {
          path: ".cursor/hooks.json",
          at: ["hooks", "postToolUse"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries: CHANNELS.map((c) => ({
            type: "command",
            matcher: c.matcher,
            command: command(c.channel, "post"),
            timeout: 30,
          })),
        },
        {
          path: ".cursor/hooks.json",
          at: ["hooks", "stop"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries: [{ type: "command", command: command("chat"), timeout: 10, loop_limit: 5 }],
        },
        {
          path: ".cursor/hooks.json",
          at: ["hooks", "subagentStop"],
          shape: "flat" as const,
          defaults: { version: 1 },
          entries: [{ type: "command", command: command("chat"), timeout: 10, loop_limit: 5 }],
        },
      ],
      shims: [{ path: RUNNER, body: HOOK_RUNNER }],
      notes: [
        "Cursor project hooks run only in a trusted workspace. The stop hook can retry a " +
          "strictly rejected reply up to five times.",
        "Rules live in .cursor/rules/*.mdc. Cursor also reads AGENTS.md, which init writes.",
      ],
    };
  },
};
