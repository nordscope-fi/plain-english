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
  /** Path, relative to the repository root unless `scope` says otherwise. */
  path: string;
  /**
   * How the file on disk is encoded.
   *
   * JSON everywhere except Vibe, which reads `.vibe/hooks.toml`. Optional so
   * that four existing profiles say nothing and keep working; a profile that
   * wants TOML asks for it.
   *
   * The two are not interchangeable at the `at` level. TOML here means one
   * array of tables named by `at`, so `at` is a single key and `shape` is
   * always `flat`.
   */
  format?: "json" | "toml";
  /**
   * Where the path is anchored.
   *
   * `repo` is the default and the only one `init` writes without being asked.
   * `user` resolves against the home directory, which is outside the project,
   * so a profile that wants one only emits it when `ctx.includeUser` is set.
   * Copilot needs this: its CLI does not read the repository location its own
   * documentation gives, verified against 1.0.78 and reported upstream as
   * github/copilot-cli#1730.
   */
  scope?: "repo" | "user";
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

/** A place in a config file, without saying what goes there. */
export type ConfigLocation = Pick<ConfigFile, "path" | "at" | "scope">;

/**
 * A plain file to write, verbatim.
 *
 * Distinct from `shims`, which are executable. An output style is neither a
 * hook nor a script: it is markdown the agent reads, and writing it 0755 would
 * be wrong in a way nothing would ever report.
 */
export interface PlainFile {
  path: string;
  body: string;
  scope?: "repo" | "user";
}

/**
 * Scalar keys to set in a JSON file, leaving everything else alone.
 *
 * `ConfigFile` splices into an array, which is right for hooks and wrong for a
 * setting like `outputStyle`. This sets named keys and nothing more, so a
 * settings file full of somebody's own preferences survives.
 *
 * `init` reports the previous value when it replaces one. Silently changing a
 * setting a person chose by hand is the kind of help nobody asked for.
 */
export interface SettingPatch {
  path: string;
  scope?: "repo" | "user";
  set: Record<string, unknown>;
}

/** Everything `init` needs to wire one agent up. */
export interface InstallPlan {
  config: ConfigFile[];
  /**
   * Places a previous version of this package wrote to and no longer does.
   *
   * `init` strips our entries from each and drops the key when nothing of
   * anyone else's is left. Without it a retired hook event survives every
   * re-install, because `init` only looks where the current plan tells it to.
   *
   * Codex needs it: its advisory moved from a second `PostToolUse` hook onto
   * the pre event in 0.7.0, and the old entry would otherwise keep spawning a
   * process per tool call to say nothing.
   */
  retire?: ConfigLocation[];
  /** Executable scripts, written 0755. Paths are relative to the root. */
  shims: { path: string; body: string }[];
  /** Plain files, written 0644. Output styles arrive this way. */
  files?: PlainFile[];
  /** Scalar settings to set without disturbing the rest of the file. */
  settings?: SettingPatch[];
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
  /**
   * The rendered chat styles, one per level, and which level is the default.
   *
   * Passed in rather than rendered here, because a profile is a translation
   * table and not a strategy. Nothing in `src/agents/` should know how a style
   * is built, only where its host wants the file and what the host calls it.
   */
  styles?: { level: string; name: string; path: string; body: string }[];
  defaultStyle?: { level: string; name: string };
  /**
   * Whether the caller has asked for files outside the repository.
   *
   * Off unless `init --user` was passed. Writing to somebody's home directory
   * is a different promise from writing to their project, and the flag is
   * where that promise is made.
   */
  includeUser?: boolean;
}

/**
 * Which point in the tool call this invocation is speaking for.
 *
 *   pre   before the tool runs; can still refuse
 *   post  after it ran; can only tell the model something
 *
 * Only agents that discard `ask` need the post event. It is how an advisory
 * finding reaches a model that has no way to surface one to a human.
 */
export type HookEvent = "pre" | "post";

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
   * Whether a pre-tool-call `ask` actually reaches a human on this agent.
   *
   * False for Codex, where a live session shows the run reported as Failed and
   * the reason delivered to nobody, and for Cursor, whose docs say `ask` "is
   * accepted by the schema but not enforced for preToolUse today". On those the
   * advisory tier has to be text fed back to the model instead, or the hook
   * looks installed and reports nothing at all under the default configuration.
   */
  supportsAsk: boolean;
  /**
   * Anything about this machine that would stop an installed hook from running.
   *
   * Optional, and only Codex has one: its repository hook file is read solely
   * in a folder the user has trusted, and until then it finds no hooks and
   * reports no error. That is this project's recurring failure, a configuration
   * that reads correctly and never runs, so `doctor` should be able to name it.
   *
   * Returns one line per problem, empty when there is nothing to say.
   */
  diagnose?(root: string): string[];
  /**
   * The bytes to write and the code to exit with.
   *
   * Exit codes are part of the protocol and they do not agree: Copilot reads
   * an unexpected non-zero as a refusal while everyone else reads it as
   * "carry on". The safe answer everywhere is 0 with an explicit decision.
   */
  emit(decision: Decision, event: HookEvent): { stdout: string; exitCode: number };
  /**
   * The same decision, in this agent's stop-event format.
   *
   * Optional, and its absence is meaningful rather than an oversight: an agent
   * with no event carrying the assistant's reply has no chat gate, and
   * `plain-english policy` prints that as an uncovered channel. Cursor is that
   * agent today.
   *
   * `eventName` is the event that fired, because at least one agent echoes it
   * back and the two stop events are not interchangeable.
   */
  emitChat?(decision: Decision, eventName: string): { stdout: string; exitCode: number };
  plan(ctx: PlanContext): InstallPlan;
}
