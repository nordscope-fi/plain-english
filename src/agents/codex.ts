/**
 * OpenAI Codex CLI.
 *
 * Payload and reply are both Claude-shaped: snake_case `tool_name` /
 * `tool_input` in, `hookSpecificOutput.permissionDecision` out. The difference
 * that matters is how Codex writes a file. It does not have Write and Edit as
 * separate tools; it has `apply_patch`, carrying a patch envelope, so the
 * inserted text has to be read out of that rather than off a field.
 *
 * Verified against codex-cli 0.147.0 on 2026-08-09. `PreToolUse` does fire for
 * `apply_patch`, with the patch under `tool_input.command`, which settles a
 * third-party claim that it intercepts the shell tool alone. What the same
 * session showed about the reply is why this profile no longer sends `ask`:
 * Codex marks the hook run Failed and the reason reaches nobody. See
 * docs/agents.md.
 *
 * Docs: https://learn.chatgpt.com/docs/hooks
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asRecord, issueFields, parseApplyPatch, pick, pickArray } from "./fields.ts";
import { HOOK_RUNNER, runnerPath } from "./runner.ts";

const RUNNER = runnerPath(".codex");
const command = (channel: string) =>
  `node "$(git rev-parse --show-toplevel)/${RUNNER}" hook ${channel} --agent codex`;

const CHANNELS = [
  { channel: "docs", matcher: "apply_patch|Write|Edit|MultiEdit" },
  { channel: "github", matcher: "Bash" },
  { channel: "issue", matcher: "mcp__linear__save_issue|mcp__linear__save_comment" },
] as const;

/**
 * Whether `~/.codex/config.toml` marks this directory as a trusted project.
 *
 * A line scan rather than a TOML parser, on purpose. The question is one key in
 * one section, a parser would be a dependency, and a strict one would throw on
 * syntax it does not know in a file this package does not own. Missing a trust
 * entry prints a hint nobody needed; failing to read the file must not stop
 * `doctor` from printing the rest.
 */
function trustedProject(configPath: string, root: string): boolean {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  let inOurs = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const named = /^\[projects\.(?:"([^"]*)"|'([^']*)')\]$/.exec(line);
      inOurs = !!named && resolve(named[1] ?? named[2] ?? "") === resolve(root);
      continue;
    }
    if (!inOurs) continue;
    const trust = /^trust_level\s*=\s*["']([^"']*)["']/.exec(line);
    if (trust) return trust[1] === "trusted";
  }
  return false;
}

function hasHookTrustRecord(configPath: string, hooksPath: string): boolean {
  try {
    const escaped = hooksPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return readFileSync(configPath, "utf8").includes(`[hooks.state."${escaped}:`);
  } catch {
    return false;
  }
}

/** A linked worktree has a `.git` file pointing elsewhere, not a directory. */
function isLinkedWorktree(root: string): boolean {
  try {
    return statSync(resolve(root, ".git")).isFile();
  } catch {
    return false;
  }
}

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
        // `command` is right, and now observed rather than deduced: a live
        // 0.147.0 session sends `tool_input: {"command": "*** Begin Patch …"}`,
        // matching codex-rs/core/src/tools/handlers/apply_patch.rs. The others
        // were guesses made when the schema was unpublished, and they stay
        // because a wrong guess costs nothing while a missing one allows every
        // write.
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

  // `ask` is worse than unsupported here. 0.147.0 carries the error string
  // "PreToolUse hook returned unsupported permissionDecision:ask", and a live
  // session shows what that means: the run is reported as "PreToolUse Failed"
  // and the reason reaches neither the model nor the user. So an advisory has
  // to travel as text, which on this agent the pre event can carry.
  supportsAsk: false,

  emit(decision: Decision, event: HookEvent) {
    // Nothing is said after the fact. The pre event carries the advisory now,
    // and a stale config from before that change still has a PostToolUse entry
    // pointing here; staying quiet keeps it from repeating the same finding.
    if (event === "post") return { stdout: "", exitCode: 0 };

    // The one decision Codex acts on. Observed to block `apply_patch`, and the
    // schema requires the reason to be non-empty, which `decide` guarantees.
    if (decision.decision === "deny") {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
        }),
        exitCode: 0,
      };
    }

    // The advisory channel, and it runs before the write rather than after.
    // Confirmed on 0.147.0: `additionalContext` from a PreToolUse hook arrives
    // as a developer message and the run is reported Completed.
    if (decision.advisory) {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: decision.advisory,
          },
        }),
        exitCode: 0,
      };
    }

    return { stdout: "", exitCode: 0 };
  },

  /**
   * The ways an installed Codex hook does nothing on this machine.
   *
   * Both were measured against 0.147.0. Current Codex documentation says a
   * hook awaiting review produces a startup warning, while an untrusted
   * project layer is not loaded. Quiet when hooks are not installed here,
   * because then there is nothing to be wrong about.
   */
  diagnose(root: string): string[] {
    if (!existsSync(resolve(root, ".codex", "hooks.json"))) return [];

    const home = process.env["CODEX_HOME"] || resolve(homedir(), ".codex");
    const config = resolve(home, "config.toml");
    const out: string[] = [];

    if (!trustedProject(config, root)) {
      out.push(
        `this project is not trusted in ${config}, so Codex reads no hooks from ` +
          `.codex/hooks.json. Start a session here and answer yes, or add ` +
          `[projects."${root}"] trust_level = "trusted"`,
      );
    }
    if (!hasHookTrustRecord(config, resolve(root, ".codex", "hooks.json"))) {
      out.push(
        "the installed Codex hooks have no trust record, so non-interactive runs skip " +
          "them. Start an interactive session and choose 'Trust all and continue', or use /hooks",
      );
    }
    if (isLinkedWorktree(root)) {
      out.push(
        "this is a linked git worktree, and Codex reads the main working tree's " +
          ".codex/hooks.json rather than this one (openai/codex#27133)",
      );
    }
    return out;
  },

  /**
   * Stop and SubagentStop.
   *
   * Codex documents `decision: "block"` on Stop, and `systemMessage` as a
   * shared output field. Its `last_assistant_message` is documented as "if
   * available" and possibly incomplete, which is why the reader falls back to
   * the rollout file rather than trusting the payload.
   */
  emitChat(decision: Decision, _eventName: string) {
    void _eventName;
    if (decision.allow && !decision.advisory) return { stdout: "", exitCode: 0 };
    if (decision.allow) {
      return { stdout: JSON.stringify({ systemMessage: decision.advisory }), exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({ decision: "block", reason: decision.reason }),
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
          // `timeout`, in seconds, and not `timeoutSec`, although that is the
          // name Codex reports it back under. A configured `timeoutSec` is
          // ignored and the hook silently gets the 600 second default.
          entries: CHANNELS.map((c) => ({
            matcher: c.matcher,
            hooks: [
              {
                type: "command",
                command: command(c.channel),
                timeout: 30,
              },
            ],
          })),
        },
        {
          // Both stop events. Codex documents last_assistant_message on them as
          // "if available", so the reader falls back to the rollout file.
          path: ".codex/hooks.json",
          at: ["hooks", "Stop"],
          shape: "nested" as const,
          entries: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: command("chat"),
                  timeout: 10,
                },
              ],
            },
          ],
        },
        {
          path: ".codex/hooks.json",
          at: ["hooks", "SubagentStop"],
          shape: "nested" as const,
          entries: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: command("chat"),
                  timeout: 10,
                },
              ],
            },
          ],
        },
      ],
      // Where the advisory used to live, before 0.7.0 moved it onto the pre
      // event. Left alone it survives every re-install and spawns a process
      // per tool call to say nothing.
      retire: [{ path: ".codex/hooks.json", at: ["hooks", "PostToolUse"] }],
      shims: [{ path: RUNNER, body: HOOK_RUNNER }],
      notes: [
        "Codex reads .codex/hooks.json only in a folder you have trusted. Start a session " +
          "here and answer yes, or add [projects.\"<absolute path>\"] trust_level = " +
          '"trusted" to ~/.codex/config.toml. An untrusted project layer is not loaded.',
        "Then trust the hooks themselves. Starting a session offers this at once: answer " +
          "'Trust all and continue', or use /hooks. Trust is recorded against the command " +
          "definition's current hash, so a changed definition needs another review.",
        "Do that before any `codex exec` run. Non-interactive mode cannot open the review " +
          "screen and skips an untrusted hook. Once trusted it runs them, verified on " +
          "0.147.0. For vetted one-off automation, --dangerously-bypass-hook-trust " +
          "bypasses hook trust for that invocation.",
        "In a git worktree, Codex reads the main working tree's .codex/hooks.json and not " +
          "the worktree's own copy (openai/codex#27133). Install in the main checkout.",
      ],
    };
  },
};
