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

/**
 * The added lines of an `apply_patch` envelope, which is how Codex writes files.
 *
 * The format is OpenAI's own, not unified diff:
 *
 *   *** Begin Patch
 *   *** Add File: docs/x.md
 *   +We leverage this.
 *   *** End Patch
 *
 * Only `+` lines are returned, because only inserted text is being published.
 * A `-` line is text on its way out, and judging it means never being able to
 * edit a file that already contains a banned term.
 *
 * Added text is kept per file rather than concatenated. One patch can touch a
 * markdown file and a source file at once, and pooling them would judge the
 * source file's additions against prose rules.
 */
export function parseApplyPatch(patch: string): { path: string; text: string }[] {
  const files: { path: string; text: string[] }[] = [];
  let current: { path: string; text: string[] } | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Update|Move to) File: (.+)$/.exec(line);
    if (header?.[1]) {
      current = { path: header[1].trim(), text: [] };
      files.push(current);
      continue;
    }
    // Any other *** marker is structural: Begin Patch, End Patch, Delete File.
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
