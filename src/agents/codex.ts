/**
 * OpenAI Codex CLI.
 *
 * Payload and reply are both Claude-shaped: snake_case `tool_name` /
 * `tool_input` in, `hookSpecificOutput.permissionDecision` out. The difference
 * that matters is how Codex writes a file. It does not have Write and Edit as
 * separate tools; it has `apply_patch`, carrying a patch envelope, so the
 * inserted text has to be read out of that rather than off a field.
 *
 * Two things about this profile are documented by OpenAI but not confirmed
 * against a running binary, and both are recorded in docs/agents.md:
 * openai/codex#18491 reports that `PreToolUse` may dispatch for shell calls
 * only on some versions, and that `updatedInput` is rejected at runtime. This
 * profile never sends `updatedInput`, so only the first matters.
 *
 * Docs: https://learn.chatgpt.com/docs/hooks
 */

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asRecord, issueFields, parseApplyPatch, pick, pickArray } from "./fields.ts";

const CHANNELS = [
  { channel: "docs", matcher: "apply_patch|Write|Edit|MultiEdit" },
  { channel: "github", matcher: "Bash" },
  { channel: "issue", matcher: "mcp__linear__save_issue|mcp__linear__save_comment" },
] as const;

export const codex: AgentProfile = {
  id: "codex",
  label: "OpenAI Codex CLI",
  docs: "https://learn.chatgpt.com/docs/hooks",

  detect(raw) {
    return typeof raw["tool_name"] === "string" && !!process.env["CODEX_HOME"];
  },

  parse(raw): NormalisedEvent {
    const input = asRecord(raw["tool_input"]);
    const cwd = pick(raw, "cwd") || undefined;
    const filePath = pick(input, "file_path", "path");

    switch (pick(raw, "tool_name")) {
      case "apply_patch": {
        // The patch text has been seen under several keys and the schema is not
        // published. Any of them, or nothing, in which case there is no text to
        // judge and the call is allowed.
        // `command` first, and it is the one that is actually right:
        // codex-rs/core/src/tools/handlers/apply_patch.rs emits
        // `tool_input: json!({ "command": command })`. The others were guesses
        // made when the schema was unpublished, and they are kept only because
        // a wrong guess costs nothing while a missing one allows every write.
        const patch = pick(input, "command", "input", "patch", "patch_text", "content");
        return { tool: "patch", cwd, input: { files: parseApplyPatch(patch) } };
      }
      case "Write":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "content") } };
      case "Edit":
        return { tool: "edit", cwd, input: { filePath, newString: pick(input, "new_string") } };
      case "MultiEdit":
        return {
          tool: "multi-edit",
          cwd,
          input: {
            filePath,
            edits: pickArray(input, "edits").map((e) => ({
              newString: pick(asRecord(e), "new_string"),
            })),
          },
        };
      case "Bash":
      case "shell":
        return { tool: "bash", cwd, input: { command: pick(input, "command") } };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  // "permissionDecision: 'ask' ... parsed but not supported yet", per Codex's
  // own hooks reference. Emitting it is not an error, it simply allows.
  supportsAsk: false,

  emit(decision: Decision, event: HookEvent) {
    if (event === "post") {
      // The advisory channel. Codex discards `ask`, so under the default
      // `failOn: never` this is the only way a finding reaches anyone, and it
      // reaches the model rather than a human. `deny` maps here too: a
      // deny-shaped decision arrives on the post event whenever the pre hook
      // did not fire, and `permissionDecision` under a PostToolUse event is an
      // unrecognised shape that Codex rejects wholesale.
      if (!decision.advisory) return { stdout: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: decision.advisory,
          },
        }),
        exitCode: 0,
      };
    }

    // Still emitted although Codex discards it. Someone who upgrades this
    // package without re-running `init` has a config with pre entries only; if
    // this went silent, the upgrade would switch Codex off with no error. An
    // ignored decision is exactly as effective as before and fails safe.
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

  plan(_ctx: PlanContext) {
    return {
      config: [
        {
          path: ".codex/hooks.json",
          at: ["hooks", "PreToolUse"],
          shape: "nested" as const,
          entries: CHANNELS.map((c) => ({
            matcher: c.matcher,
            hooks: [
              {
                type: "command",
                command: `npx --no-install plain-english hook ${c.channel} --agent codex`,
                timeout: 30,
              },
            ],
          })),
        },
        {
          // The advisory channel, because Codex discards `ask`. Under
          // `failOn: error` the pre hook refuses and this never speaks; under
          // the default it is the only thing that does.
          path: ".codex/hooks.json",
          at: ["hooks", "PostToolUse"],
          shape: "nested" as const,
          entries: CHANNELS.map((c) => ({
            matcher: c.matcher,
            hooks: [
              {
                type: "command",
                command:
                  `npx --no-install plain-english hook ${c.channel} --agent codex --event post`,
                timeout: 30,
              },
            ],
          })),
        },
      ],
      shims: [],
      notes: [
        "Codex will not run a hook you have not approved. Start a session and run /hooks " +
          "to review and trust these entries.",
        "Approval is asked for again whenever the command string changes, which includes " +
          "pinning a new version of this package.",
        "Hooks must be enabled: `[features] hooks = true` in config.toml if your build " +
          "has them switched off.",
      ],
    };
  },
};
