/**
 * What a coding agent has to tell us, and what it wants back.
 *
 * Every agent surveyed asks the same question before a write: "here is a tool
 * call, may I run it?" They disagree only on field names and on the shape of
 * the answer. Claude Code, Codex and Copilot even share the
 * `permissionDecision` vocabulary, because the others copied it.
 *
 * So a profile is a translation table, not a strategy. It maps one agent's
 * payload onto the canonical event below, and one `Decision` back onto that
 * agent's wire format. Everything between those two points is shared, which is
 * the only reason supporting four agents is not four linters.
 */

import type { Decision } from "../adapters/hook.ts";

/**
 * The tool kinds this linter cares about, named once so the extractors do not
 * have to know that Claude calls it `Write`, Codex calls it `apply_patch` and
 * Cursor calls the shell `Shell`.
 *
 * `other` is everything else, and is always allowed.
 */
export type CanonicalTool =
  | "write"
  | "edit"
  | "multi-edit"
  | "patch"
  | "bash"
  | "issue"
  | "other";

/**
 * A tool call with the agent's naming translated away.
 *
 * `input` uses canonical keys, so a profile that renames `new_string` to
 * `newString` is the whole of its file-write support:
 *
 *   filePath                      write | edit | multi-edit
 *   content                       write
 *   newString                     edit
 *   edits: [{ newString }]        multi-edit
 *   files: [{ path, text }]       patch
 *   command                       bash
 *   title, description, body      issue
 *   patch: [{ newString, text }]  issue
 */
export interface NormalisedEvent {
  tool: CanonicalTool;
  input: Record<string, unknown>;
  /** The session's working directory, when the payload carries one. */
  cwd?: string;
}

/** One JSON file this agent reads its hooks from. */
export interface ConfigFile {
  /** Path relative to the repository root. */
  path: string;
  /** Where in the parsed document our array lives, e.g. ["hooks", "preToolUse"]. */
  at: string[];
  /**
   * How the array is shaped.
   *
   *   flat    one entry per hook
   *   nested  entries are { matcher, hooks: [...] } groups, so a foreign hook
   *           sharing one of our matchers has to survive a re-install
   */
  shape: "flat" | "nested";
  /** The entries to splice in, already in this agent's format. */
  entries: unknown[];
  /**
   * Keys the agent expects at the root of a freshly created file, such as
   * `{ version: 1 }`. Never overwrites a value already there.
   */
  defaults?: Record<string, unknown>;
}

/** Everything `init` needs to wire one agent up. */
export interface InstallPlan {
  config: ConfigFile[];
  /** Executable scripts, written 0755. Paths are relative to the root. */
  shims: { path: string; body: string }[];
  /**
   * What the installer cannot do for the user: approval steps, and behaviour
   * that differs from what the rest of the documentation promises.
   */
  notes: string[];
}

export interface PlanContext {
  /** Rendered semantic prompts by channel, for agents that support prompt hooks. */
  prompts: Record<string, string>;
  /** Model for prompt hooks. */
  model: string;
}

export interface AgentProfile {
  /** Stable id, used by `--agent` and in the shim command. */
  id: string;
  /** Human name, for help text and install output. */
  label: string;
  /** Where this agent's hook documentation lives, printed on install. */
  docs: string;
  /**
   * Best-effort recognition from a payload alone.
   *
   * A shim written by `init` always passes `--agent`, so this only has to
   * carry hand-written configs. Several agents are indistinguishable by
   * payload, which is why detection is documented as a convenience and the
   * explicit flag is what the installer emits.
   */
  detect(raw: Record<string, unknown>): boolean;
  parse(raw: Record<string, unknown>): NormalisedEvent;
  /**
   * The bytes to write and the code to exit with.
   *
   * Exit codes are part of the protocol and they do not agree: Copilot reads
   * an unexpected non-zero as a refusal while everyone else reads it as
   * "carry on". The safe answer everywhere is 0 with an explicit decision.
   */
  emit(decision: Decision): { stdout: string; exitCode: number };
  plan(ctx: PlanContext): InstallPlan;
}
