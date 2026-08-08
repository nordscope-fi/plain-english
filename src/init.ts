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
import { dirname, relative, resolve } from "node:path";
import { compile, loadDefault } from "./rules.ts";
import { renderAgentsFragment, renderPrompts, AGENTS_MD_START, AGENTS_MD_END } from "./render.ts";
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
    const keep = (g.hooks ?? []).filter((h) => !isOurs(h));
    const wasOurs = (g.hooks ?? []).length !== keep.length;
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
}

export function init(opts: InitOptions): number {
  const { root, dryRun = false } = opts;
  const model = opts.model ?? "claude-sonnet-5";
  const agents = opts.agents?.length ? opts.agents : [byId(DEFAULT_AGENT)!];
  const set = compile(loadDefault());
  const prompts = renderPrompts(set);
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

  for (const agent of agents) {
    const plan = agent.plan({ prompts, model });

    for (const file of plan.config) {
      const path = resolve(root, file.path);
      const existed = existsSync(path);
      if (!docs.has(path)) {
        let doc: Json = {};
        if (existed) {
          try {
            doc = JSON.parse(readFileSync(path, "utf8")) as Json;
          } catch (e) {
            process.stderr.write(
              `plain-english: ${relative(root, path)} is not valid JSON, refusing to touch it\n` +
                `  ${e instanceof Error ? e.message : String(e)}\n`,
            );
            return 2;
          }
        }
        docs.set(path, doc);
      }
      const result = applyConfig(docs.get(path)!, file);
      docs.set(path, result.doc);
      planned.push(
        `${existed ? "update" : "create"} ${relative(root, path)} ${file.at.join(".")}` +
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

    for (const n of plan.notes) notes.push(`${agent.label}: ${n}`);
  }

  for (const [path, doc] of docs) {
    writes.push({ path, body: JSON.stringify(doc, null, 2) + "\n" });
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
