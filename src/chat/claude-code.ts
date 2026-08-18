/**
 * Claude Code transcripts.
 *
 * Location: `<config>/projects/<project>/<session>.jsonl`, where `<config>` is
 * `~/.claude` unless `CLAUDE_CONFIG_DIR` moves it. Both are documented.
 *
 * Evidence, per `docs/verifying-an-adapter.md`:
 *   observed  the record shapes below, read off live transcripts
 *   docs      the location, `CLAUDE_CONFIG_DIR`, and the two caveats
 *
 * Two documented caveats shape this file.
 *
 * The transcript is written asynchronously and may lag the conversation, so
 * `current()` must not read it for the turn it is judging. It takes
 * `last_assistant_message` off the payload, which the stop events carry, and
 * only falls back to the file when they do not.
 *
 * The project directory name is not derived here. The documentation says to
 * use the `transcript_path` the hook was given rather than constructing one,
 * and a scan does better by reading each record's own `cwd` than by guessing
 * how a path was flattened into a directory name.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  field,
  hasSegment,
  inScope,
  readJsonl,
  withinDays,
  type Availability,
  type ChatReader,
  type ReadOptions,
  type Reply,
} from "./reader.ts";

/** `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` points. */
export function configDir(): string {
  const override = process.env["CLAUDE_CONFIG_DIR"];
  return override && override.length ? resolve(override) : resolve(homedir(), ".claude");
}

function projectsDir(): string {
  return resolve(configDir(), "projects");
}

/**
 * Every transcript file, newest first, filtered by age before anything is
 * parsed.
 *
 * The walk recurses, and that is the whole point. A main-loop session is
 * `projects/<project>/<session>.jsonl`, but a subagent writes its own file at
 * `projects/<project>/<session>/subagents/agent-<id>.jsonl`, one to three
 * levels further down. Scanning only the top level found every main-loop reply
 * and no subagent reply at all, and reported that as zero rather than as an
 * error: on this machine it silently dropped 1,845 replies, which are exactly
 * the ones an output style cannot reach and the ones this feature exists to
 * count.
 */
function transcripts(sinceDays: number | undefined, now: number): string[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const out: { path: string; mtime: number }[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        // `projects/<project>/memory/` holds auto memory, which is markdown
        // and not a transcript. It is also the one directory the cleanup sweep
        // spares, so it is the one most likely to be large and stale.
        if (entry.name === "memory") continue;
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (sinceDays !== undefined && now - mtime > sinceDays * 24 * 60 * 60 * 1000) continue;
      out.push({ path, mtime });
    }
  };

  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

/** The text blocks of one assistant record. Thinking and tool calls are not replies. */
function assistantText(record: Record<string, unknown>): string[] {
  if (record["type"] !== "assistant") return [];
  const message = record["message"];
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "text") continue;
    if (typeof b["text"] === "string" && b["text"].trim()) out.push(b["text"]);
  }
  return out;
}

export const claudeCodeChat: ChatReader = {
  id: "claude-code",
  label: "Claude Code",

  available(): Availability {
    if (!existsSync(projectsDir())) {
      return {
        ok: false,
        // Two different causes, and the fix differs, so both are named.
        why:
          `no transcripts at ${projectsDir()}. Either none have been written yet, ` +
          "or CLAUDE_CODE_SKIP_PROMPT_HISTORY is set, which turns them off",
      };
    }
    return { ok: true };
  },

  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    const out: Reply[] = [];
    for (const path of transcripts(options.sinceDays, now)) {
      readJsonl(path, (record, line) => {
        const texts = assistantText(record);
        if (!texts.length) return;
        const cwd = typeof record["cwd"] === "string" ? record["cwd"] : undefined;
        if (!inScope(cwd, options.cwd)) return;
        const at = typeof record["timestamp"] === "string" ? record["timestamp"] : undefined;
        if (!withinDays(at, options.sinceDays, now)) return;
        for (const text of texts) {
          const reply: Reply = {
            text,
            // Two signals, because they do not always agree. `isSidechain` is
            // on the record, and a subagent also gets its own file under a
            // `subagents/` directory. Trusting only the flag would miss a file
            // whose records do not carry it.
            isSubagent: record["isSidechain"] === true || hasSegment(path, "subagents"),
            session: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
            source: path,
            line,
          };
          if (at) reply.at = at;
          out.push(reply);
        }
      });
    }
    return out;
  },

  current(payload: Record<string, unknown>): Reply | null {
    // Documented as the complete final message, and documented as the thing to
    // use instead of the transcript, which lags.
    const text = field(payload, "last_assistant_message");
    if (!text) return null;
    const reply: Reply = {
      text,
      // SubagentStop is the event that reaches where an output style cannot.
      isSubagent:
        payload["hook_event_name"] === "SubagentStop" || typeof payload["agent_id"] === "string",
      session: field(payload, "session_id") ?? "",
      source: field(payload, "transcript_path") ?? "",
      line: 0,
    };
    return reply;
  },
};
