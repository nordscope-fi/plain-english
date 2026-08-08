/**
 * Reading a tool call whose field names are not fully documented.
 *
 * Claude Code and Copilot publish their payload schemas. Cursor documents the
 * envelope (`tool_name`, `tool_input`) but not the arguments inside a Write,
 * and Codex's docs describe a superset of what its binary actually dispatches.
 * So a profile that hardcodes one spelling is one vendor patch away from
 * reading nothing at all, and reading nothing means allowing everything.
 *
 * `pick` accepts every plausible spelling instead. A wrong guess costs nothing:
 * the key is absent and the next one is tried. A missing guess costs a silent
 * pass, which is the failure mode worth avoiding.
 */

/** The first key present with a string value, or "". */
export function pick(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

/** The first key present with an array value, or []. */
export function pickArray(input: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    const v = input[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** Coerce to a record so callers never guard for null. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Longest argument string worth parsing. A tool call is not a payload dump. */
const MAX_ARGS_BYTES = 256 * 1024;

/**
 * The tool-argument bag, from whichever field this agent put it in.
 *
 * Two things make this more than `a ?? b`.
 *
 * Copilot sends its camelCase `toolArgs` as an escaped JSON *string*, not an
 * object: `{"toolName":"bash","toolArgs":"{\"command\":\"git status\"}"}`.
 * Its own tutorial says so, and `copilot-cli#3349` exists because a hook that
 * forgets is a policy that silently passes everything. Its PascalCase mode
 * sends `tool_input` already parsed, so both shapes are live at once.
 *
 * And `??` is the wrong operator for choosing between them. It falls through
 * on null and undefined only, so an agent mid-rename sending `tool_input: {}`
 * beside a populated `toolArgs` would stop at the empty object and read
 * nothing. Take the first candidate that actually carries something.
 */
export function asArgs(...candidates: unknown[]): Record<string, unknown> {
  for (const c of candidates) {
    const parsed = parseArgs(c);
    if (Object.keys(parsed).length) return parsed;
  }
  return {};
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    if (v.length > MAX_ARGS_BYTES) return {};
    try {
      return asRecord(JSON.parse(v));
    } catch {
      // Not JSON. Nothing to read, and nothing worth failing over.
      return {};
    }
  }
  return asRecord(v);
}

/**
 * Linear-shaped issue fields, renamed to the canonical spelling.
 *
 * Shared across every profile on purpose: these names come from the Linear MCP
 * server, not from the agent, so all four see the same keys.
 */
export function issueFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    title: pick(input, "title"),
    description: pick(input, "description"),
    body: pick(input, "body"),
    patch: pickArray(input, "patch").map((p) => {
      const e = asRecord(p);
      // new_string / text only. old_string is text being replaced.
      return { newString: pick(e, "new_string"), text: pick(e, "text") };
    }),
  };
}

export interface PatchedFile {
  path: string;
  text: string;
}

/**
 * The added lines of a patch, which is how Codex writes files.
 *
 * Two formats arrive here. OpenAI's own envelope is what `apply_patch` carries:
 *
 *   *** Begin Patch
 *   *** Add File: docs/x.md
 *   +We leverage this.
 *   *** End Patch
 *
 * A unified diff turns up too, and the two need separate parsers rather than
 * one loop with both sets of rules. In a unified diff `+++ b/x.md` is a header
 * that happens to start with `+`, so a shared loop must special-case it, and
 * then a markdown line beginning `+++` inside an OpenAI envelope gets dropped
 * to pay for it. Detect once, then commit.
 *
 * Only added lines are returned, because only inserted text is being published.
 * A removed line is text on its way out, and judging it means never being able
 * to edit a file that already contains a banned term.
 *
 * Text is kept per file rather than concatenated. One patch can touch a
 * markdown file and a source file at once, and pooling them would judge the
 * source file's additions against prose rules.
 */
export function parseApplyPatch(patch: string): PatchedFile[] {
  return patch.trimStart().startsWith("*** Begin Patch")
    ? parseEnvelope(patch)
    : parseUnifiedDiff(patch);
}

/** OpenAI's `*** Begin Patch` format. */
function parseEnvelope(patch: string): PatchedFile[] {
  const files: { path: string; text: string[] }[] = [];
  let current: { path: string; text: string[] } | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (header?.[1]) {
      current = { path: header[1].trim(), text: [] };
      files.push(current);
      continue;
    }
    // Any other *** marker is structural: Begin Patch, End Patch, Delete File,
    // and the `*** Move to:` that follows an Update File header.
    if (line.startsWith("***")) {
      if (/^\*\*\* (?:End Patch|Delete File)/.test(line)) current = undefined;
      continue;
    }
    // "@@" context markers carry no inserted text.
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+") && current) current.text.push(line.slice(1));
  }

  return files.map((f) => ({ path: f.path, text: f.text.join("\n") }));
}

/** Ordinary `--- a/x` / `+++ b/x` / `@@` diff. */
function parseUnifiedDiff(patch: string): PatchedFile[] {
  const files: { path: string; text: string[] }[] = [];
  let current: { path: string; text: string[] } | undefined;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim().split("\t")[0] ?? "";
      // A deletion names /dev/null as its destination and creates no file.
      if (raw === "/dev/null") {
        current = undefined;
        continue;
      }
      current = { path: raw.replace(/^[ab]\//, ""), text: [] };
      files.push(current);
      continue;
    }
    // Headers and metadata, none of which is inserted text.
    if (
      line.startsWith("--- ") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("\\ ")
    ) {
      continue;
    }
    if (line.startsWith("+") && current) current.text.push(line.slice(1));
  }

  return files.map((f) => ({ path: f.path, text: f.text.join("\n") }));
}
