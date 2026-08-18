/**
 * `plain-english init [--agent <id>]`
 *
 * The highest-friction step in the old design was a human hand-merging a
 * 50-line JSON blob out of a README into their own settings file. That is the
 * step most likely to be done wrong, and the one where an existing unrelated
 * hook gets clobbered.
 *
 * Every agent keeps its hooks in a JSON file, in one of two shapes: a flat list
 * of entries, or a list of `{ matcher, hooks: [...] }` groups. So the merge is
 * shared and only the entries differ, which is what makes a fourth agent a
 * table rather than a rewrite.
 *
 * Merging preserves every entry it did not add, and is idempotent: running it
 * twice changes nothing the second time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { compile, loadDefault } from "./rules.ts";
import {
  renderAgentsFragment,
  renderOutputStyle,
  renderPrompts,
  outputStylePath,
  AGENTS_MD_START,
  AGENTS_MD_END,
} from "./render.ts";
import type { AgentProfile, ConfigFile } from "./agents/profile.ts";
import { byId, DEFAULT_AGENT, PROFILES } from "./agents/registry.ts";

const MARKER = "plain-english";

type Json = Record<string, unknown>;

interface HookGroup {
  matcher: string;
  hooks: Json[];
}

const STARTER_CONFIG = `# Project config for plain-english.
# \`extends: default\` means you never fork the ruleset: you add your own
# vocabulary and exclusions, and upstream rule fixes still reach you.

version: 1
extends: default

# Findings are reported and the run still exits 0. Set this to "error" to make
# blocking findings fail the build and refuse the write, or "warn" to fail on
# warnings too.
failOn: never

# Terms that never trigger a finding. Put your domain vocabulary here.
allow: []

# Files the linter skips entirely. Anything that quotes the banned list as
# reference material belongs here.
exclude:
  - "docs/writing-style.md"
  - "CHANGELOG.md"

# Adjust individual rules without forking the file:
# rules:
#   - id: showcase
#     severity: warn
`;

/**
 * True when an entry was added by us, so re-running can replace it cleanly.
 *
 * Matches on the command string across every field an agent might carry one in:
 * `command` (Claude, Codex, Cursor), `bash` and `powershell` (Copilot), and
 * `prompt` for Claude's semantic hook.
 */
function isOurs(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Json;
  return ["command", "prompt", "bash", "powershell"].some(
    (k) => typeof e[k] === "string" && (e[k] as string).includes(MARKER),
  );
}

/** Read a nested key, copying each level so the original is never mutated. */
function readAt(doc: Json, path: string[]): unknown {
  let node: unknown = doc;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Json)[key];
  }
  return node;
}

/** Write a nested key, copying each level on the way down. */
function writeAt(doc: Json, path: string[], value: unknown): Json {
  const [head, ...rest] = path;
  if (head === undefined) return doc;
  if (rest.length === 0) return { ...doc, [head]: value };
  const child = doc[head];
  const next = child && typeof child === "object" && !Array.isArray(child) ? (child as Json) : {};
  return { ...doc, [head]: writeAt(next, rest, value) };
}

/**
 * Splice our entries into a flat list.
 *
 * Ours are identified by the marker and replaced wholesale; everything else
 * keeps its position relative to the other survivors.
 */
export function mergeFlat(existing: unknown[], entries: unknown[]): unknown[] {
  return [...existing.filter((e) => !isOurs(e)), ...entries];
}

/**
 * Splice our entries into a list of `{ matcher, hooks }` groups.
 *
 * Matching is exact on `matcher`. A group we share with somebody else keeps
 * their hooks: a project that already gates `Bash` for its own reasons must not
 * lose that gate by installing this one.
 *
 * Our entries are first stripped from *every* group, not only from the ones we
 * are about to write. Otherwise changing a matcher string orphans the old group
 * forever: the new matcher finds no match, a fresh group is appended, and the
 * old one keeps a stale copy of our command, so the hook fires twice on every
 * matching call. Idempotence within a version hid this, because it only shows
 * up across a version that renamed a matcher. `mergeFlat` never had the problem,
 * since it filters by marker across the whole list.
 */
export function mergeNested(
  existing: HookGroup[],
  entries: HookGroup[],
): { groups: HookGroup[]; added: string[]; replaced: string[]; orphaned: string[] } {
  const wanted = new Set(entries.map((e) => e.matcher));
  const added: string[] = [];
  const replaced: string[] = [];
  const orphaned: string[] = [];

  const hadOurs = new Set<string>();
  const groups: HookGroup[] = [];
  for (const g of existing) {
    // A flat entry where a group belongs. This is what 0.9.0 wrote into
    // `hooks.Stop`, following documentation that shows the event flat, and
    // Claude Code rejects the whole file over it. Treating it as a group turns
    // it into `{ type, command, hooks: [] }`, which is a third thing and still
    // invalid, so an upgrade left the file just as broken as it found it.
    //
    // Ours goes. Somebody else's is left exactly as it is: their flat entry is
    // their business, and rewriting it would be the same mistake in reverse.
    if (!Array.isArray((g as { hooks?: unknown }).hooks)) {
      if (isOurs(g)) {
        hadOurs.add(g.matcher);
        continue;
      }
      groups.push(g);
      continue;
    }
    const keep = g.hooks.filter((h) => !isOurs(h));
    const wasOurs = g.hooks.length !== keep.length;
    if (wasOurs) {
      hadOurs.add(g.matcher);
      if (!wanted.has(g.matcher)) orphaned.push(g.matcher);
    }
    // A group that held nothing but our old entries goes with them.
    if (!keep.length && wasOurs) continue;
    groups.push({ ...g, hooks: keep });
  }

  for (const block of entries) {
    const at = groups.findIndex((b) => b.matcher === block.matcher);
    if (at === -1) {
      groups.push(block);
      (hadOurs.has(block.matcher) ? replaced : added).push(block.matcher);
      continue;
    }
    groups[at] = { ...groups[at]!, hooks: [...(groups[at]!.hooks ?? []), ...block.hooks] };
    (hadOurs.has(block.matcher) ? replaced : added).push(block.matcher);
  }

  return { groups, added, replaced, orphaned };
}

/**
 * Take our entries out of somewhere we used to write and no longer do.
 *
 * Returns the document unchanged, and `removed: 0`, when there is nothing of
 * ours there. A key emptied of everything goes with them; a key still holding
 * somebody else's hook keeps that hook and stays.
 */
export function retireAt(doc: Json, at: string[]): { doc: Json; removed: number } {
  const current = readAt(doc, at);
  if (!Array.isArray(current)) return { doc, removed: 0 };

  let removed = 0;
  const kept: unknown[] = [];
  for (const entry of current) {
    // A nested group holds hooks; a flat list holds them directly.
    const group = entry as HookGroup;
    if (Array.isArray(group?.hooks)) {
      const hooks = group.hooks.filter((h) => !isOurs(h));
      removed += group.hooks.length - hooks.length;
      if (hooks.length) kept.push({ ...group, hooks });
      continue;
    }
    if (isOurs(entry)) removed += 1;
    else kept.push(entry);
  }
  if (!removed) return { doc, removed: 0 };

  if (kept.length) return { doc: writeAt(doc, at, kept), removed };

  // Drop the key itself rather than leaving an empty array behind.
  const parent = at.slice(0, -1);
  const leaf = at[at.length - 1]!;
  const holder = parent.length ? readAt(doc, parent) : doc;
  if (!holder || typeof holder !== "object") return { doc, removed };
  const next = { ...(holder as Json) };
  delete next[leaf];
  return { doc: parent.length ? writeAt(doc, parent, next) : next, removed };
}

/** Apply one profile's config file to whatever is on disk. */
function applyConfig(
  doc: Json,
  file: ConfigFile,
): { doc: Json; added: string[]; replaced: string[]; orphaned: string[]; preserved: number } {
  const current = readAt(doc, file.at);
  const existing = Array.isArray(current) ? current : [];

  let next: unknown[];
  let added: string[] = [];
  let replaced: string[] = [];
  let orphaned: string[] = [];
  let preserved = 0;

  if (file.shape === "nested") {
    const groups = existing as HookGroup[];
    preserved = groups.reduce((n, g) => n + (g.hooks ?? []).filter((h) => !isOurs(h)).length, 0);
    const merged = mergeNested(groups, file.entries as HookGroup[]);
    next = merged.groups;
    added = merged.added;
    replaced = merged.replaced;
    orphaned = merged.orphaned;
  } else {
    preserved = existing.filter((e) => !isOurs(e)).length;
    const had = existing.some(isOurs);
    next = mergeFlat(existing, file.entries);
    (had ? replaced : added).push(file.at.join("."));
  }

  // Defaults never overwrite. A project that pinned `version: 2` keeps it.
  const withDefaults: Json = { ...(file.defaults ?? {}), ...doc };
  return { doc: writeAt(withDefaults, file.at, next), added, replaced, orphaned, preserved };
}

/**
 * A `hooks.toml`, split into the blocks it is made of.
 *
 * Vibe is the only agent in the registry that reads TOML, and this is the whole
 * of the support it needs: an array of tables at the top level, each one a
 * `[[hooks]]` header followed by scalar keys. Anything before the first header,
 * and any other table, is somebody else's and travels through untouched.
 *
 * A line scan rather than a parser, which is the same call `codex.ts` makes
 * about `config.toml`. A parser would be a dependency; a strict one would throw
 * on syntax it does not know in a file this package does not own.
 */
export function splitHooksToml(text: string): { preamble: string; blocks: string[] } {
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [];
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.trim() === "[[hooks]]") {
      if (current) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    // Any other table header ends the array of tables. What follows belongs to
    // that table, so it stays where it is rather than being swept into a block.
    if (current && /^\s*\[/.test(line)) {
      blocks.push(current.join("\n"));
      current = null;
      preamble.push(line);
      continue;
    }
    (current ?? preamble).push(line);
  }
  if (current) blocks.push(current.join("\n"));
  return { preamble: preamble.join("\n"), blocks };
}

/** The `name` of a `[[hooks]]` block, or "" when it does not declare one. */
function hookName(block: string): string {
  const m = /^\s*name\s*=\s*["']([^"']*)["']/m.exec(block);
  return m ? m[1]! : "";
}

/**
 * Ours, by name rather than by command.
 *
 * `isOurs` matches the marker anywhere in a command string, which is right for
 * JSON where we wrote the whole entry. Here it would be wrong: a project whose
 * own hook shells out to this linter under its own name would lose that hook on
 * every install. We only own the names we write.
 */
function isOurHook(block: string): boolean {
  return hookName(block).startsWith(MARKER + "-");
}

/** One TOML scalar. Enough for the shapes a hook entry actually holds. */
function tomlValue(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

/** One `[[hooks]]` block, keys in the order the profile listed them. */
function renderHook(entry: unknown): string {
  const e = entry as Record<string, unknown>;
  const lines = ["[[hooks]]"];
  for (const [key, value] of Object.entries(e)) {
    if (value === undefined) continue;
    lines.push(key + " = " + tomlValue(value));
  }
  return lines.join("\n");
}

/**
 * Splice our hooks into a `hooks.toml`, keeping everyone else's.
 *
 * Ours are dropped wherever they were and re-appended together, which is what
 * `mergeFlat` does for JSON. Appending is always valid: `[[hooks]]` defines a
 * top-level array of tables, so it means the same thing at the end of a file as
 * it does in the middle, whatever tables came before it.
 */
export function mergeHooksToml(existing: string, entries: unknown[]): string {
  const { preamble, blocks } = splitHooksToml(existing);
  const kept = blocks.filter((b) => !isOurHook(b));
  const parts = [preamble.trimEnd(), ...kept.map((b) => b.trimEnd()), ...entries.map(renderHook)];
  return parts.filter((p) => p.length).join("\n\n") + "\n";
}

/**
 * Whether this text is a `hooks.toml` we can account for line by line.
 *
 * The scan above cannot report a syntax error, so it must not be handed one.
 * A header this package half-recognises, such as `[[hooks]` with a bracket
 * missing, would be swept into a block and rewritten. Refusing is the same
 * promise the JSON path makes: a file we cannot parse is a file we do not touch.
 */
export function readableHooksToml(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("[")) continue;
    if (!/^\[\[[A-Za-z0-9_.-]+\]\]$/.test(line) && !/^\[[A-Za-z0-9_.-]+\]$/.test(line)) {
      return false;
    }
  }
  return true;
}

/**
 * Put the generated section into AGENTS.md without disturbing the rest.
 *
 * Returns null when the file already says exactly this, so a re-run reports
 * nothing rather than claiming a change it did not make.
 */
export function spliceAgentsMd(existing: string | null, fragment: string): string | null {
  const body = fragment.trimEnd();

  if (existing === null || existing.trim() === "") {
    const created = `# AGENTS.md\n\nInstructions for coding agents working in this repository.\n\n${body}\n`;
    return created;
  }

  const start = existing.indexOf(AGENTS_MD_START);
  const end = existing.indexOf(AGENTS_MD_END);
  if (start !== -1 && end !== -1 && end > start) {
    const next =
      existing.slice(0, start) + body + existing.slice(end + AGENTS_MD_END.length);
    return next === existing ? null : next;
  }

  return `${existing.trimEnd()}\n\n${body}\n`;
}

export interface InitOptions {
  root: string;
  dryRun?: boolean;
  /** Profiles to wire up. Defaults to Claude Code, which is what init always did. */
  agents?: AgentProfile[];
  model?: string;
  /**
   * Also write files outside the repository, in the home directory.
   *
   * Off by default, and deliberately a separate decision. Everything else
   * `init` writes lands in the project, where it is committed, reviewed and
   * removed with the checkout. A user-level file is none of those things.
   *
   * Copilot needs it: its CLI does not read the repository location its own
   * documentation gives (github/copilot-cli#1730).
   */
  includeUser?: boolean;
}

export function init(opts: InitOptions): number {
  const { root, dryRun = false } = opts;
  const model = opts.model ?? "claude-sonnet-5";
  const agents = opts.agents?.length ? opts.agents : [byId(DEFAULT_AGENT)!];
  const includeUser = opts.includeUser ?? false;
  const set = compile(loadDefault());
  const prompts = renderPrompts(set);
  // Rendered once here rather than inside each profile: a profile is a
  // translation table and should not know how a style is built, only where its
  // host wants the file.
  const styles = set.chat.levels.map((level) => ({
    level: level.id,
    name: level.name,
    // The basename only. A profile decides which directory its host reads.
    path: outputStylePath(set, level.id).split("/").pop()!,
    body: renderOutputStyle(set, level.id),
  }));
  const defaultLevel = set.chat.levels.find((l) => l.id === set.chat.level);
  const defaultStyle = defaultLevel
    ? { level: defaultLevel.id, name: defaultLevel.name }
    : undefined;
  const configPath = resolve(root, ".plain-english.yml");
  const agentsMdPath = resolve(root, "AGENTS.md");

  const planned: string[] = [];
  const notes: string[] = [];
  const writes: { path: string; body: string; mode?: number }[] = [];

  // Keyed by resolved path, because one agent can put two hook events in one
  // file. Re-reading from disk per entry meant the second write started from
  // the same document as the first and overwrote it, so installing a pre and a
  // post hook together left only whichever came last.
  const docs = new Map<string, Json>();

  // TOML travels separately, as text rather than as a parsed document. Only
  // Vibe reads it, the merge is a line scan, and giving it a `Json` shape would
  // mean writing a serialiser for a format this package barely touches.
  const tomlDocs = new Map<string, string>();

  // A user-scoped path is anchored to the home directory rather than the
  // project. Only a profile asks for one, and only when `includeUser`.
  const locate = (file: { path: string; scope?: "repo" | "user" }) =>
    file.scope === "user" ? resolve(homedir(), file.path) : resolve(root, file.path);

  /** The parsed document for a path, or null if it is not JSON we should touch. */
  const load = (path: string): Json | null => {
    if (docs.has(path)) return docs.get(path)!;
    let doc: Json = {};
    if (existsSync(path)) {
      try {
        doc = JSON.parse(readFileSync(path, "utf8")) as Json;
      } catch (e) {
        process.stderr.write(
          `plain-english: ${relative(root, path)} is not valid JSON, refusing to touch it\n` +
            `  ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return null;
      }
    }
    docs.set(path, doc);
    return doc;
  };

  for (const agent of agents) {
    const plan = agent.plan({ prompts, model, includeUser, styles, ...(defaultStyle ? { defaultStyle } : {}) });

    // Retirement first, so a location this version has stopped writing to is
    // cleared before anything else in the same file is merged.
    for (const gone of plan.retire ?? []) {
      const path = locate(gone);
      if (!existsSync(path)) continue;
      const doc = load(path);
      if (doc === null) return 2;
      const { doc: next, removed } = retireAt(doc, gone.at);
      if (!removed) continue;
      docs.set(path, next);
      const shown = gone.scope === "user" ? path : relative(root, path);
      planned.push(
        `update ${shown} ${gone.at.join(".")} (removed ${removed} retired hook` +
          `${removed === 1 ? "" : "s"})`,
      );
    }

    for (const file of plan.config) {
      const path = locate(file);
      const existed = existsSync(path);

      if (file.format === "toml") {
        let text = tomlDocs.get(path);
        if (text === undefined) {
          text = existed ? readFileSync(path, "utf8") : "";
          if (!readableHooksToml(text)) {
            process.stderr.write(
              `plain-english: ${relative(root, path)} has a table header this ` +
                `installer does not recognise, refusing to touch it\n`,
            );
            return 2;
          }
        }
        const before = splitHooksToml(text).blocks.length;
        const next = mergeHooksToml(text, file.entries);
        tomlDocs.set(path, next);
        const preserved = splitHooksToml(next).blocks.length - file.entries.length;
        planned.push(
          `${existed ? "update" : "create"} ${relative(root, path)} ${file.at.join(".")}` +
            ` (${before ? "replaced" : "added"}: ${file.entries.length};` +
            ` preserved ${preserved} unrelated hook${preserved === 1 ? "" : "s"})`,
        );
        continue;
      }

      const doc = load(path);
      if (doc === null) return 2;
      const result = applyConfig(docs.get(path)!, file);
      docs.set(path, result.doc);
      const shown = file.scope === "user" ? path : relative(root, path);
      planned.push(
        `${existed ? "update" : "create"} ${shown} ${file.at.join(".")}` +
          ` (added: ${result.added.join(", ") || "none"};` +
          ` replaced: ${result.replaced.join(", ") || "none"};` +
          (result.orphaned.length ? ` removed stale: ${result.orphaned.join(", ")};` : "") +
          ` preserved ${result.preserved} unrelated hook${result.preserved === 1 ? "" : "s"})`,
      );
    }

    for (const s of plan.shims) {
      const path = resolve(root, s.path);
      planned.push(`create ${relative(root, path)}`);
      writes.push({ path, body: s.body, mode: 0o755 });
    }

    // 0644, not 0755. An output style is markdown the agent reads, not a
    // script it runs, and nothing would ever report the wrong mode.
    //
    // Reported only when the bytes differ. `init` promises that a second run
    // changes nothing, and a run that lists three files it did not change
    // reads as a broken promise even though nothing moved.
    for (const f of plan.files ?? []) {
      const path = locate(f);
      let current: string | null = null;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = null;
      }
      if (current === f.body) continue;
      planned.push(`${current === null ? "create" : "update"} ${relative(root, path)}`);
      writes.push({ path, body: f.body });
    }

    for (const patch of plan.settings ?? []) {
      const path = locate(patch);
      const doc = load(path);
      if (doc === null) return 2;
      const current = docs.get(path)!;
      const next: Json = { ...current };
      const changes: string[] = [];
      for (const [key, value] of Object.entries(patch.set)) {
        const before = current[key];
        if (before === value) continue;
        // Say what was replaced. Changing a setting somebody chose by hand
        // without telling them is the kind of help nobody asked for.
        changes.push(
          before === undefined
            ? `${key}=${JSON.stringify(value)}`
            : `${key}=${JSON.stringify(value)} (was ${JSON.stringify(before)})`,
        );
        next[key] = value;
      }
      if (!changes.length) continue;
      docs.set(path, next);
      planned.push(
        `${existsSync(path) ? "update" : "create"} ${relative(root, path)} ${changes.join(", ")}`,
      );
    }

    for (const n of plan.notes) notes.push(`${agent.label}: ${n}`);
  }

  for (const [path, doc] of docs) {
    writes.push({ path, body: JSON.stringify(doc, null, 2) + "\n" });
  }

  for (const [path, body] of tomlDocs) {
    writes.push({ path, body });
  }

  const existingAgentsMd = existsSync(agentsMdPath)
    ? readFileSync(agentsMdPath, "utf8")
    : null;
  const nextAgentsMd = spliceAgentsMd(existingAgentsMd, renderAgentsFragment(set));
  if (nextAgentsMd !== null) {
    planned.push(`${existingAgentsMd === null ? "create" : "update"} AGENTS.md`);
    writes.push({ path: agentsMdPath, body: nextAgentsMd });
  }

  if (!existsSync(configPath)) {
    planned.push(`create ${relative(root, configPath)}`);
    writes.push({ path: configPath, body: STARTER_CONFIG });
  }

  if (dryRun) {
    process.stdout.write("plain-english init --dry-run\n\n");
    for (const p of planned) process.stdout.write(`  ${p}\n`);
    process.stdout.write("\nNothing was written.\n");
    if (notes.length) {
      process.stdout.write("\nAfter installing:\n");
      for (const n of notes) process.stdout.write(`  - ${n}\n`);
    }
    return 0;
  }

  for (const w of writes) {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.body, "utf8");
    if (w.mode !== undefined) chmodSync(w.path, w.mode);
  }

  for (const p of planned) process.stdout.write(`  ${p}\n`);
  if (notes.length) {
    process.stdout.write("\nAfter installing:\n");
    for (const n of notes) process.stdout.write(`  - ${n}\n`);
  }
  process.stdout.write(`\nDone. Try: plain-english lint .\n`);
  return 0;
}

/**
 * The 0.3.x entry point.
 *
 * @deprecated Use `init({ agents: [...] })`. Kept so a consumer importing the
 * old name keeps working for one minor version.
 */
export function initClaudeCode(opts: Omit<InitOptions, "agents">): number {
  return init({ ...opts, agents: [byId("claude-code")!] });
}

/** Every profile, for `init --agent all`. */
export function allAgents(): AgentProfile[] {
  return [...PROFILES];
}
