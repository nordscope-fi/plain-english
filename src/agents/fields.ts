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

import { contentText, issueText } from "./issue.ts";

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
 * Reader-visible fields from Linear, Jira and Confluence, in canonical form.
 * Each supplied prose field is retained; unrelated IDs and attributes are not.
 */
export function issueFields(input: Record<string, unknown>): Record<string, unknown> {
  const fields = asRecord(input["fields"]);
  const description = [issueText(input["description"]), issueText(fields["description"])].filter(Boolean).join("\n\n");
  const body = [issueText(input["body"]), issueText(input["commentBody"]), contentText(input["content"], input["contentFormat"])].filter(Boolean).join("\n\n");
  return {
    title: [pick(input, "title"), pick(input, "summary"), pick(fields, "summary")].filter(Boolean).join("\n\n"),
    description,
    body,
    patch: pickArray(input, "patch").map((p) => {
      const e = asRecord(p);
      // new_string / text only. old_string is text being replaced.
      return { newString: pick(e, "newString", "new_string"), text: pick(e, "text") };
    }),
  };
}

/** Fields needed to apply an edit without losing its surrounding document. */
export function editFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    newString: pick(input, "new_string", "newString", "new_str", "replacement"),
    oldString: pick(input, "old_string", "oldString", "old_str", "search"),
    replaceAll: input["replace_all"] === true || input["replaceAll"] === true,
  };
}

export interface PatchedFile {
  path: string;
  text: string;
  sourcePath?: string;
  edits?: { oldString: string; newString: string; changedRanges: { start: number; end: number }[] }[];
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
  const files: PatchedFile[] = [];
  let current: PatchedFile | undefined;
  let removed = "";
  let added = "";
  let ranges: { start: number; end: number }[] = [];
  const finishHunk = () => {
    if (current?.sourcePath && (removed || added)) {
      (current.edits ??= []).push({ oldString: removed, newString: added, changedRanges: ranges });
    }
    removed = ""; added = ""; ranges = [];
  };
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update) File: (.+)$/.exec(line);
    if (header?.[2]) {
      finishHunk();
      current = { path: header[2].trim(), text: "" };
      if (header[1] === "Update") current.sourcePath = current.path;
      files.push(current);
      continue;
    }
    if (line.startsWith("*** Move to:") && current) {
      current.path = line.slice("*** Move to:".length).trim();
      continue;
    }
    if (line.startsWith("***") || line.startsWith("@@")) {
      finishHunk();
      if (/^\*\*\* (?:End Patch|Delete File)/.test(line)) current = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      const value = line.slice(1);
      current.text += (current.text ? "\n" : "") + value;
      ranges.push({ start: added.length, end: added.length + value.length });
      added += value + "\n";
    } else if (line.startsWith("-")) removed += line.slice(1) + "\n";
    else if (line.startsWith(" ")) {
      removed += line.slice(1) + "\n";
      added += line.slice(1) + "\n";
    }
  }
  finishHunk();
  return files;
}

/** Ordinary `--- a/x` / `+++ b/x` / `@@` diff. */
function parseUnifiedDiff(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: PatchedFile | undefined;
  let sourcePath: string | undefined;
  let removed = "";
  let added = "";
  let ranges: { start: number; end: number }[] = [];
  const finishHunk = () => {
    if (current?.sourcePath && (removed || added)) {
      (current.edits ??= []).push({ oldString: removed, newString: added, changedRanges: ranges });
    }
    removed = ""; added = ""; ranges = [];
  };
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      finishHunk();
      const raw = line.slice(4).trim().split("\t")[0] ?? "";
      sourcePath = raw === "/dev/null" ? undefined : raw.replace(/^[ab]\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      finishHunk();
      const raw = line.slice(4).trim().split("\t")[0] ?? "";
      if (raw === "/dev/null") { current = undefined; continue; }
      current = { path: raw.replace(/^[ab]\//, ""), text: "" };
      if (sourcePath) current.sourcePath = sourcePath;
      files.push(current);
      continue;
    }
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
      finishHunk();
      continue;
    }
    if (line.startsWith("\\ ") || !current) continue;
    if (line.startsWith("+")) {
      const value = line.slice(1);
      current.text += (current.text ? "\n" : "") + value;
      ranges.push({ start: added.length, end: added.length + value.length });
      added += value + "\n";
    } else if (line.startsWith("-")) removed += line.slice(1) + "\n";
    else if (line.startsWith(" ")) {
      removed += line.slice(1) + "\n";
      added += line.slice(1) + "\n";
    }
  }
  finishHunk();
  return files;
}
