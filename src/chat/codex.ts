/**
 * OpenAI Codex CLI rollout files.
 *
 * Location: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
 * defaulting to `~/.codex`. `CODEX_HOME` moving the whole directory is already
 * relied on elsewhere in this package, in `docs/verifying-an-adapter.md`.
 *
 * Evidence:
 *   observed  the record shapes below, read off a live rollout file
 *   docs      the location and the `CODEX_HOME` override
 *
 * The record shape is not Claude's. A rollout is an event stream, and the
 * assistant's words arrive as:
 *
 *   { type: "response_item",
 *     payload: { type: "message", role: "assistant",
 *                content: [ { type: "output_text", text } ] } }
 *
 * The working directory is not on each record. It is written once, in the
 * `session_meta` record at the head of the file, so scope is resolved per file
 * rather than per record.
 *
 * Codex documents `last_assistant_message` on its stop events as "if
 * available" and possibly incomplete. That word is why `current()` falls back
 * to the transcript rather than trusting the payload, and why the tracer pass
 * in `docs/verifying-an-adapter.md` has to answer whether the file has caught
 * up by the time the event fires.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  field,
  inScope,
  readJsonl,
  withinDays,
  type Availability,
  type ChatReader,
  type ReadOptions,
  type Reply,
} from "./reader.ts";

export function codexHome(): string {
  const override = process.env["CODEX_HOME"];
  return override && override.length ? resolve(override) : resolve(homedir(), ".codex");
}

function sessionsDir(): string {
  return resolve(codexHome(), "sessions");
}

/** Walk the YYYY/MM/DD tree. The depth is not assumed, only the extension. */
function rollouts(dir: string, sinceDays: number | undefined, now: number, out: { path: string; mtime: number }[] = []): { path: string; mtime: number }[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      rollouts(path, sinceDays, now, out);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (sinceDays !== undefined && now - mtime > sinceDays * 24 * 60 * 60 * 1000) continue;
    out.push({ path, mtime });
  }
  return out;
}

interface Parsed {
  cwd?: string;
  session?: string;
  replies: { text: string; line: number; at?: string }[];
}

function parseRollout(path: string): Parsed {
  const parsed: Parsed = { replies: [] };
  readJsonl(path, (record, line) => {
    const payload = record["payload"];
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;

    if (record["type"] === "session_meta") {
      if (typeof p["cwd"] === "string") parsed.cwd = p["cwd"];
      if (typeof p["session_id"] === "string") parsed.session = p["session_id"];
      return;
    }
    if (record["type"] !== "response_item") return;
    if (p["type"] !== "message" || p["role"] !== "assistant") return;
    const content = p["content"];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      // `output_text` is the assistant's; `input_text` is somebody else's.
      if (b["type"] !== "output_text") continue;
      if (typeof b["text"] !== "string" || !b["text"].trim()) continue;
      const entry: { text: string; line: number; at?: string } = { text: b["text"], line };
      if (typeof record["timestamp"] === "string") entry.at = record["timestamp"];
      parsed.replies.push(entry);
    }
  });
  return parsed;
}

export const codexChat: ChatReader = {
  id: "codex",
  label: "OpenAI Codex CLI",

  available(): Availability {
    if (!existsSync(sessionsDir())) {
      return { ok: false, why: `no rollout files at ${sessionsDir()}` };
    }
    return { ok: true };
  },

  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    const out: Reply[] = [];
    const files = rollouts(sessionsDir(), options.sinceDays, now).sort((a, b) => b.mtime - a.mtime);
    for (const { path } of files) {
      const parsed = parseRollout(path);
      // Resolved once per file: the working directory is on `session_meta`
      // and on nothing else.
      if (!inScope(parsed.cwd, options.cwd)) continue;
      for (const r of parsed.replies) {
        if (!withinDays(r.at, options.sinceDays, now)) continue;
        const reply: Reply = {
          text: r.text,
          // Codex carries a `phase` on the message and a SubagentStop event,
          // but nothing observed here distinguishes a subagent reply in the
          // rollout itself. Claiming otherwise would put a number on a split
          // this reader cannot actually see.
          isSubagent: false,
          session: parsed.session ?? "",
          source: path,
          line: r.line,
        };
        if (r.at) reply.at = r.at;
        out.push(reply);
      }
    }
    return out;
  },

  current(payload: Record<string, unknown>): Reply | null {
    const session = field(payload, "session_id") ?? "";
    const isSubagent = payload["hook_event_name"] === "SubagentStop";
    const direct = field(payload, "last_assistant_message");
    if (direct) {
      return { text: direct, isSubagent, session, source: field(payload, "transcript_path") ?? "", line: 0 };
    }

    // Documented as "if available", so absence is expected rather than a bug.
    // The transcript is the fallback, and the last assistant message in it is
    // the one the event is about.
    const path = field(payload, "transcript_path");
    if (!path) return null;
    const parsed = parseRollout(path);
    const last = parsed.replies[parsed.replies.length - 1];
    if (!last) return null;
    const reply: Reply = { text: last.text, isSubagent, session: session || (parsed.session ?? ""), source: path, line: last.line };
    if (last.at) reply.at = last.at;
    return reply;
  },
};
