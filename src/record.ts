/**
 * Recording what an agent actually sent.
 *
 * Three of the four adapters were written from vendor documentation, and the
 * documentation was wrong twice: Copilot's PascalCase mode does not rename
 * `tool_input` the way its camelCase rule implies, and a widely-cited claim
 * that Codex routes file edits through `Bash` described a bug fixed months
 * earlier. Reading harder does not fix that. Capturing one real payload does.
 *
 * Switched on with `PLAIN_ENGLISH_RECORD=<dir>`, so a session can be recorded
 * without editing the shim `init` wrote.
 *
 * Two rules govern everything here.
 *
 * It must never be able to break the linter. It is called after the decision
 * has already been written to stdout, in its own try/catch, because a debugging
 * aid that throws before the verdict would allow the write with no output at
 * all, and on Copilot an unexpected exit is read as a refusal.
 *
 * And it must never leak. A payload carries the whole text somebody was about
 * to write, from whatever repository they were in. Content is reduced to a
 * length and a hash unless the caller opts out, paths are rewritten, and a file
 * that still contains a home directory after all that is not written.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { Decision } from "./adapters/hook.ts";
import type { HookEvent, NormalisedEvent } from "./agents/profile.ts";

/** Keys whose values are prose somebody wrote, rather than structure. */
const CONTENT_KEYS = new Set([
  "content",
  "contents",
  "text",
  "new_string",
  "newString",
  "new_str",
  "old_string",
  "oldString",
  "command",
  "patchText",
  "title",
  "description",
  "body",
  "prompt",
  "message",
]);

/** Most captures worth keeping from one session. */
const MAX_FILES = 200;

/** Largest capture worth writing, after redaction. */
const MAX_BYTES = 256 * 1024;

export interface RecordOptions {
  dir: string;
  agent: string;
  channel: string;
  event: HookEvent;
  projectDir: string;
  version: string;
  /**
   * Keep prose verbatim instead of reducing it to a length and a hash.
   *
   * For a payload you wrote yourself and are about to commit as a fixture.
   * Never for a capture from somebody's real session.
   */
  verbatim?: boolean;
}

/**
 * Rewrite the paths a capture carries.
 *
 * `{{TMP}}` is the placeholder the regression corpus already hydrates, so a
 * scrubbed capture drops straight in as a fixture.
 */
function scrubText(s: string, projectDir: string): string {
  const home = homedir();
  let out = s.split(projectDir).join("{{TMP}}");
  // Both separators, because a payload from Windows carries backslashes.
  out = out.split(projectDir.split(sep).join("/")).join("{{TMP}}");
  if (home) out = out.split(home).join("~");
  // A capture is meant to be committed and replayed anywhere, so the part we
  // rewrote leaves with forward slashes whatever platform recorded it.
  // Only the placeholder's own tail: a backslash elsewhere in the payload may
  // be a real escape in somebody's prose.
  out = out.replace(/\{\{TMP\}\}((?:\\[^\\"]*)+)/g, (_m, tail: string) =>
    "{{TMP}}" + tail.split("\\").join("/"),
  );
  return out;
}

/**
 * What survives into the file.
 *
 * Prose is replaced by its shape unless `verbatim`. The length and hash are
 * enough to tell "the adapter read the right field" from "it read nothing",
 * which is the only question a capture has to answer.
 */
function redact(v: unknown, opts: RecordOptions, key?: string): unknown {
  if (typeof v === "string") {
    // Identity goes whatever `verbatim` says. It is never the thing being
    // debugged, and a capture is meant to be safe to attach to an issue.
    if (key && IDENTITY_KEYS.has(key)) return "<redacted>";
    const scrubbed = scrubText(v, opts.projectDir).replace(EMAIL, "<email>");
    if (opts.verbatim || !key || !CONTENT_KEYS.has(key)) return scrubbed;
    return `<${scrubbed.length} chars, sha256:${createHash("sha256")
      .update(scrubbed)
      .digest("hex")
      .slice(0, 12)}>`;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, opts, key));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redact(val, opts, k);
    }
    return out;
  }
  return v;
}

/**
 * Identifiers that are neither prose nor structure.
 *
 * Cursor puts `user_email` in every payload, which a capture from a real
 * session would otherwise carry into a public issue. Found by capturing one.
 */
const IDENTITY_KEYS = new Set(["user_email", "userEmail", "email", "user", "author"]);

/** An address anywhere else in the payload, such as inside a commit message. */
const EMAIL = /[^\s<>"@]+@[^\s<>"@]+\.[A-Za-z]{2,}/g;

/** Something that survived redaction and should not leave the machine. */
const LEAK = /\/Users\/|\/home\/|[A-Za-z]:\\Users\\|[^\s<>"@]+@[^\s<>"@]+\.[A-Za-z]{2,}/;

export function buildCapture(
  raw: Record<string, unknown>,
  parsed: NormalisedEvent,
  decision: Decision,
  stdout: string,
  opts: RecordOptions,
): string | null {
  const capture = {
    agent: opts.agent,
    channel: opts.channel,
    event: opts.event,
    toolVersion: opts.version,
    redacted: !opts.verbatim,
    raw: redact(raw, opts),
    parsed: redact(parsed as unknown, opts),
    decision: {
      allow: decision.allow,
      decision: decision.decision,
      ruleIds: [...new Set(decision.findings.map((f) => f.ruleId))].sort(),
      ...(decision.timedOut ? { timedOut: decision.timedOut } : {}),
    },
    // Never the reason text: it quotes the matched prose back.
    stdoutKeys: stdout ? Object.keys(JSON.parse(stdout) as object) : [],
  };

  const body = JSON.stringify(capture, null, 2) + "\n";
  if (body.length > MAX_BYTES) return null;
  // The last check, and the one that matters. A partial scrub that wrote
  // anyway would put somebody's home directory in a committed fixture.
  if (LEAK.test(body)) return null;
  return body;
}

/**
 * Write one capture. Returns the path, or null if nothing was written.
 *
 * Never throws. Every failure here is a debugging aid not working, which is
 * not worth a single degraded decision.
 */
export function record(
  raw: Record<string, unknown>,
  parsed: NormalisedEvent,
  decision: Decision,
  stdout: string,
  opts: RecordOptions,
): string | null {
  try {
    mkdirSync(opts.dir, { recursive: true });

    // One session should not fill a disk. Counting beats tracking state.
    if (readdirSync(opts.dir).length >= MAX_FILES) return null;

    const body = buildCapture(raw, parsed, decision, stdout, opts);
    if (!body) {
      process.stderr.write(
        "plain-english: a capture was dropped because it still held a home path " +
          "after redaction, or was too large\n",
      );
      return null;
    }

    // Copilot runs hooks in parallel, so a timestamp alone collides. `wx`
    // fails rather than overwriting if one ever does.
    const name =
      `${opts.agent}-${opts.channel}-${opts.event}-` +
      `${process.pid}-${process.hrtime.bigint()}-${randomBytes(3).toString("hex")}.json`;
    const path = resolve(opts.dir, name);
    writeFileSync(path, body, { encoding: "utf8", flag: "wx" });
    return path;
  } catch {
    return null;
  }
}
