/**
 * Mistral Vibe.
 *
 * The first agent in this registry whose payload says what it is. Every other
 * one sends a bare `tool_name`, which is why `resolveProfile` documents
 * detection as a weak guess; Vibe sends `hook_event_name: "pre_tool"`, a
 * vocabulary nobody else uses, so detection here is exact.
 *
 * Verified against vibe 2.24.1, source tier throughout, read off the installed
 * package rather than the docs. The published hooks page agrees with all of it.
 *
 *   events      pre_tool, post_tool, post_agent, and nothing else
 *               (`vibe/core/hooks/models.py`, class HookType)
 *   payload     JSON on stdin (`hooks/executor.py`)
 *   reply       exit 0 plus a JSON object on stdout (`hooks/_handler.py`)
 *   vocabulary  allow / deny. There is no `ask`.
 *
 * Two consequences shape this file. Without `ask` or a pre-tool context field,
 * the advisory tier has to travel as `additional_context` on `post_tool`, which
 * puts Vibe alongside Cursor and Gemini. And `post_agent` is a real stop event:
 * a denial there is injected
 * back as a retry user message, capped at three per hook per user turn
 * (`hooks/_post_agent.py`), which is what gives Vibe a chat gate at all.
 *
 * Docs: https://docs.mistral.ai/vibe/code/cli/hooks
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Decision } from "../adapters/hook.ts";
import type { AgentProfile, HookEvent, NormalisedEvent, PlanContext } from "./profile.ts";
import { asRecord, issueFields, pick } from "./fields.ts";
import { DOCS_MAX_JUDGE_BYTES } from "../adapters/judge.ts";
import { HOOK_RUNNER, runnerCommand, runnerPath } from "./runner.ts";

const RUNNER = runnerPath(".vibe");

/**
 * Vibe's matcher is fnmatch by default and a full-match regex behind `re:`.
 *
 * Tools from a local tool server arrive flattened as `{server}_{tool}`, so the
 * issue channel cannot name a server it does not know. It matches the tool half.
 */
const CHANNELS = [
  { channel: "docs", match: "re:(write_file|edit)", timeout: 30 },
  { channel: "github", match: "bash", timeout: 30 },
  { channel: "issue", match: "re:.*_save_(issue|comment)", timeout: 30 },
] as const;

/** The events that carry a payload this package can read. */
const EVENTS = new Set(["pre_tool", "post_tool", "post_agent"]);

/** Where Vibe keeps its own state. `VIBE_HOME` moves the whole tree. */
export function vibeHome(): string {
  const override = process.env["VIBE_HOME"];
  return override && override.length ? resolve(override) : resolve(homedir(), ".vibe");
}

/**
 * Whether Vibe has been told to trust this directory.
 *
 * A line scan rather than a TOML parser, for the reason `codex.ts` gives about
 * the same question: it is one key in one file this package does not own, a
 * parser would be a dependency, and failing to read it must not stop `doctor`
 * from printing everything else.
 *
 * The file holds `trusted = [ "...", ... ]` with an `untrusted` list beside it,
 * so the scan has to know which of the two it is inside.
 */
function trustedFolder(configPath: string, root: string): boolean {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  let inTrusted = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^trusted\s*=/.test(line)) {
      // A single-line `trusted = ["a", "b"]` carries its entries right here.
      if (line.includes("]")) {
        if (listed(line, root)) return true;
        inTrusted = false;
      } else {
        inTrusted = true;
      }
      continue;
    }
    // Any other key, or any table header, ends the list we were reading.
    if (/^[A-Za-z_]+\s*=/.test(line) || line.startsWith("[")) {
      inTrusted = false;
      continue;
    }
    if (!inTrusted) continue;
    if (line.startsWith("]")) inTrusted = false;
    else if (listed(line, root)) return true;
  }
  return false;
}

/** Whether any quoted path on this line resolves to the one we want. */
function listed(line: string, root: string): boolean {
  const wanted = resolve(root);
  for (const m of line.matchAll(/["']([^"']+)["']/g)) {
    if (resolve(m[1]!) === wanted) return true;
  }
  return false;
}

export const vibe: AgentProfile = {
  id: "vibe",
  label: "Mistral Vibe",
  docs: "https://docs.mistral.ai/vibe/code/cli/hooks",

  detect(raw) {
    const name = raw["hook_event_name"];
    return typeof name === "string" && EVENTS.has(name);
  },

  parse(raw): NormalisedEvent {
    const input = asRecord(raw["tool_input"]);
    const cwd = pick(raw, "cwd") || undefined;
    const filePath = pick(input, "file_path", "path");

    switch (pick(raw, "tool_name")) {
      // The capitalised spellings are not Vibe's. They cost nothing and they
      // keep the guard closed if a future release renames a tool, which is the
      // same trade `fields.ts` documents: a wrong guess is free, a missing one
      // allows every write.
      case "write_file":
      case "Write":
        return { tool: "write", cwd, input: { filePath, content: pick(input, "content") } };
      case "edit":
      case "Edit":
        return { tool: "edit", cwd, input: { filePath, newString: pick(input, "new_string") } };
      case "bash":
      case "Bash":
        return { tool: "bash", cwd, input: { command: pick(input, "command") } };
      default:
        return { tool: "other", cwd, input: issueFields(input) };
    }
  },

  // `HookStructuredResponse.decision` is `Literal["allow", "deny"]`. An `ask`
  // would fail schema validation, and a pre_tool reply that fails validation is
  // treated as a hook failure rather than being ignored.
  supportsAsk: false,

  emit(decision: Decision, event: HookEvent) {
    // Vibe documents `system_message` as UI-only. `post_tool` is the event that
    // can add context to what the model sees, so advisory findings travel here.
    if (event === "post") {
      if (!decision.advisory) return { stdout: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({
          hook_specific_output: { additional_context: decision.advisory },
        }),
        exitCode: 0,
      };
    }
    if (decision.allow) return { stdout: "", exitCode: 0 };

    if (decision.decision === "ask") {
      // Let the tool run. Its post event carries the advisory to the model.
      return { stdout: "", exitCode: 0 };
    }

    // Vibe wraps this as `Tool 'X' was denied by hook 'Y': {reason}` before the
    // model sees it, and prefixes UI content with `[hook-name]`. So the reason
    // must not name this package, or it reads twice.
    return {
      stdout: JSON.stringify({ decision: "deny", reason: decision.reason }),
      exitCode: 0,
    };
  },

  /**
   * post_agent.
   *
   * A denial here is injected as a retry user message rather than shown, so the
   * model gets a turn to fix the reply. Three per hook per user turn, after
   * which Vibe reports the retries exhausted and moves on. That cap is Vibe's
   * own and needs nothing from this side.
   */
  emitChat(decision: Decision, _eventName: string) {
    void _eventName;
    if (decision.allow && !decision.advisory) return { stdout: "", exitCode: 0 };
    if (decision.allow) {
      return { stdout: JSON.stringify({ system_message: decision.advisory }), exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({ decision: "deny", reason: decision.reason }),
      exitCode: 0,
    };
  },

  /**
   * The way an installed Vibe hook does nothing on this machine.
   *
   * `.vibe/hooks.toml` is read only in a folder the user has trusted. Until
   * then Vibe finds no hooks and says nothing, which is this project's
   * recurring failure: a configuration that reads correctly and never runs.
   */
  diagnose(root: string): string[] {
    // Quiet where the hooks are not installed here. `policy` runs this over
    // every profile in the registry and writes the answer into a committed
    // document, so an opinion about an agent this project does not use ends up
    // in a public file with an absolute home path in it. Codex guards the same
    // way: there is nothing to be wrong about until something is installed.
    if (!existsSync(resolve(root, ".vibe", "hooks.toml"))) return [];

    const trustFile = resolve(vibeHome(), "trusted_folders.toml");
    if (trustedFolder(trustFile, root)) return [];
    // Only the persisted list is visible from here. A session started with
    // `--trust` is trusted and leaves no trace, so this can say "not trusted"
    // about a session that is running fine. Saying so is still worth it: the
    // opposite mistake is a hook that never runs and never explains itself.
    return [
      `this project is not trusted in ${trustFile}, so Vibe reads no hooks from ` +
        `.vibe/hooks.toml and reports nothing. Start an interactive session here and ` +
        `accept the trust prompt, which is what writes that file. \`vibe --trust\` ` +
        `covers this invocation only and is not persisted, so it fixes automation ` +
        `rather than the machine.`,
    ];
  },

  plan(ctx: PlanContext) {
    const judged = CHANNELS.filter((c) => (ctx.prompts[c.channel] ?? "").length > 0);
    return {
      config: [
        {
          path: ".vibe/hooks.toml",
          format: "toml" as const,
          at: ["hooks"],
          shape: "flat" as const,
          entries: [
            ...CHANNELS.map((c) => ({
              name: `plain-english-${c.channel}`,
              type: "pre_tool",
              match: c.match,
              command: runnerCommand(RUNNER, c.channel, "vibe"),
              timeout: c.timeout,
              description: `plain-english ${c.channel} channel`,
            })),
            ...CHANNELS.map((c) => ({
              name: `plain-english-${c.channel}-advisory`,
              type: "post_tool",
              match: c.match,
              command: runnerCommand(RUNNER, c.channel, "vibe") + " --event post",
              timeout: c.timeout,
              description: `plain-english ${c.channel} advisory context`,
            })),
            // The semantic tier, one per channel that has a prompt to run.
            ...judged.map((c) => ({
              name: `plain-english-${c.channel}-judge`,
              type: "pre_tool",
              match: c.match,
              // Through `node`, not by shebang. Windows honours neither the
              // shebang nor the exec bit, so a bare path here is a hook that
              // fails to spawn on one platform and reports nothing, which is
              // the silent-and-installed failure this package exists to avoid.
              command: `node .vibe/hooks/plain-english-judge.mjs ${c.channel}`,
              timeout: 60,
              description: `plain-english ${c.channel} judge, opt-in`,
            })),
            {
              name: "plain-english-chat",
              type: "post_agent",
              command: runnerCommand(RUNNER, "chat", "vibe"),
              timeout: 10,
              description: "plain-english chat channel",
            },
          ],
        },
      ],
      shims: [
        { path: RUNNER, body: HOOK_RUNNER },
        ...(judged.length ? [{ path: ".vibe/hooks/plain-english-judge.mjs", body: JUDGE }] : []),
      ],
      // The prompts travel as plain files rather than being pasted into the
      // shim. A rendered ruleset is markdown full of quotes and newlines, and a
      // generated script that embeds one is a quoting bug waiting to happen.
      files: judged.map((c) => ({
        path: `.vibe/hooks/plain-english-${c.channel}.prompt.md`,
        body: (ctx.prompts[c.channel] ?? "").replaceAll("{{PROJECT_DIR}}", "this repository"),
      })),
      notes: [
        "Vibe reads .vibe/hooks.toml only in a folder you have trusted. Start a session here " +
          "and accept the trust prompt, or run `vibe --trust` once. Untrusted, it finds no " +
          "hooks and says nothing.",
        "The writing style reaches Vibe through AGENTS.md, which init has already updated. " +
          "Unlike a Claude Code output style, it reaches subagents too.",
        "Do not move the style into .vibe/prompts/. A file there replaces Vibe's whole system " +
          "prompt rather than adding to it.",
        "The semantic judge is off by default, because it costs a model call on every matching " +
          "tool call. Turn it on with PLAIN_ENGLISH_VIBE_JUDGE=1.",
      ],
    };
  },
};

/**
 * The semantic judge, because Vibe has no prompt hook.
 *
 * Claude Code takes a `type: "prompt"` hook and runs the judge itself. Vibe's
 * hooks are shell commands only, so the shell command asks Vibe. It uses the
 * model access the operator already set up, which is the only way to do this
 * without a public repository asking for one of its own.
 *
 * Node rather than `/bin/sh`, for the same reason the prompt is a separate
 * file: markdown full of quotes and braces does not survive a shell round trip,
 * and a JSON verdict parsed with `sed` is a bug waiting to happen. Node is
 * already a hard requirement of this package.
 *
 * The verdict contract is not invented here. `renderPrompts` already ends every
 * prompt by asking for only JSON, `{"ok": true}` or `{"ok": false, "reason"}`,
 * and marks `$ARGUMENTS` as where the host pastes the payload. Claude Code does
 * that substitution itself. On Vibe this script is the host.
 *
 * Every failure path is a silent exit 0. A judge that cannot run has to cost
 * nothing: this tier is off by default, and a linter must never be the reason a
 * write cannot happen.
 */
const JUDGE = [
  "#!/usr/bin/env node",
  "// Generated by plain-english. Semantic judge for Mistral Vibe.",
  "//",
  "// Vibe has no prompt hook, so this asks Vibe itself. Off unless",
  "// PLAIN_ENGLISH_VIBE_JUDGE=1, because it costs a model call per tool call.",
  'import { readFileSync } from "node:fs";',
  'import { spawnSync } from "node:child_process";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "// Silence is the only safe failure. Exit 0 saying nothing.",
  "const quiet = () => process.exit(0);",
  "",
  'if (process.env.PLAIN_ENGLISH_VIBE_JUDGE !== "1") quiet();',
  "",
  'const channel = process.argv[2] || "docs";',
  "const here = dirname(fileURLToPath(import.meta.url));",
  "let prompt, payload;",
  "try {",
  '  prompt = readFileSync(join(here, "plain-english-" + channel + ".prompt.md"), "utf8");',
  '  payload = readFileSync(0, "utf8");',
  "} catch {",
  "  quiet();",
  "}",
  "",
  "// Size guard, matching the Claude Code docs path. A large file overflows the",
  "// model with `Prompt is too long`, so above this it passes on its size alone.",
  `if (payload.length > ${DOCS_MAX_JUDGE_BYTES}) quiet();`,
  "",
  "// One question, not a session: a single turn with every tool switched off and",
  "// a price ceiling, so a runaway cannot bill anybody.",
  "//",
  "// The judge runs in the same working directory, so its own session reads this",
  "// repository's .vibe/hooks.toml and fires these same hooks. Switching the",
  "// judge off for the child is what stops a hook that spawns a model call that",
  "// spawns a hook. Disabling the tools is not enough on its own: that is a flag",
  "// on this one call, and the recursion would come back the day it changes.",
  "const run = spawnSync(",
  '  "vibe",',
  '  ["-p", "--output", "text", "--max-turns", "1", "--disabled-tools", "*", "--max-price", "0.05"],',
  "  {",
  '    input: prompt.replace("$ARGUMENTS", payload),',
  '    encoding: "utf8",',
  "    timeout: 55000,",
  '    env: { ...process.env, PLAIN_ENGLISH_VIBE_JUDGE: "0" },',
  "  },",
  ");",
  "if (run.error || run.status !== 0 || !run.stdout) quiet();",
  "",
  "// The model was asked for only JSON. Models add a sentence anyway, so take",
  "// the outermost braces rather than trusting all of stdout to parse.",
  'const open = run.stdout.indexOf("{");',
  'const close = run.stdout.lastIndexOf("}");',
  "if (open < 0 || close <= open) quiet();",
  "",
  "let verdict;",
  "try {",
  "  verdict = JSON.parse(run.stdout.slice(open, close + 1));",
  "} catch {",
  "  quiet();",
  "}",
  'if (!verdict || verdict.ok !== false || typeof verdict.reason !== "string") quiet();',
  "",
  '// Vibe already wraps this as "Tool \'X\' was denied by hook \'Y\': {reason}",',
  "// so the reason must not name this package or the hook.",
  'process.stdout.write(JSON.stringify({ decision: "deny", reason: verdict.reason }));',
  "",
].join("\n");
