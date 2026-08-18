/**
 * Mistral Vibe session logs.
 *
 * Location: `$VIBE_HOME/logs/session/session_<ts>_<id>/`, defaulting to
 * `~/.vibe`. Each session directory holds `messages.jsonl` beside a
 * `meta.json`, and any subagent it spawned under `agents/<name>_<ts>_<id>/`
 * with the same two files.
 *
 * Evidence:
 *   observed  the record and meta shapes below, read off live session logs
 *   source    the location, from `vibe/core/paths/_vibe_home.py`, and the
 *             `transcript_path` a hook receives, from `agent_loop_hooks.py`
 *
 * The transcript is a plain message list, not an event stream:
 *
 *   { role: "assistant", content: "...", injected: false, message_id: "..." }
 *
 * Two consequences shape this reader. A turn that only called tools carries
 * `content: null` and its `tool_calls`, so "has a string content" is what
 * separates a reply from a step. And `injected: true` marks text Vibe put into
 * the conversation itself, including the retry message a denied `post_agent`
 * hook produces, which must never be read back as something the model said.
 *
 * The working directory and the timestamps are not on the records. They are
 * written once into `meta.json`, so scope is resolved per session rather than
 * per record, exactly as the Codex reader resolves it per rollout file.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { vibeHome } from "../agents/vibe.ts";
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

function sessionsDir(): string {
  return resolve(vibeHome(), "logs", "session");
}

interface Meta {
  session: string;
  cwd?: string;
  at?: string;
}

/**
 * The session's own record of where and when it ran.
 *
 * Failing to read it is not fatal. A session whose meta is missing still holds
 * replies, and dropping them because a sidecar was unreadable would be the
 * "read nothing, report clean" failure this package keeps guarding against.
 */
function readMeta(dir: string): Meta {
  try {
    const raw = JSON.parse(readFileSync(resolve(dir, "meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const env = raw["environment"];
    const cwd =
      env && typeof env === "object" ? (env as Record<string, unknown>)["working_directory"] : undefined;
    const meta: Meta = { session: typeof raw["session_id"] === "string" ? raw["session_id"] : "" };
    if (typeof cwd === "string") meta.cwd = cwd;
    if (typeof raw["start_time"] === "string") meta.at = raw["start_time"];
    return meta;
  } catch {
    return { session: "" };
  }
}

/** Every assistant reply in one `messages.jsonl`. */
function repliesIn(path: string, meta: Meta, isSubagent: boolean): Reply[] {
  const out: Reply[] = [];
  readJsonl(path, (record, line) => {
    if (record["role"] !== "assistant") return;
    // Vibe's own injected text, including the retry message a denied
    // post_agent hook produces. Reading that back would lint our own words.
    if (record["injected"] === true) return;
    const text = record["content"];
    if (typeof text !== "string" || !text.trim()) return;
    const reply: Reply = { text, isSubagent, session: meta.session, source: path, line };
    if (meta.at) reply.at = meta.at;
    out.push(reply);
  });
  return out;
}

/** One session directory, plus every subagent nested inside it. */
function readSession(dir: string, isSubagent: boolean, options: ReadOptions, now: number): Reply[] {
  const meta = readMeta(dir);
  if (!inScope(meta.cwd, options.cwd)) return [];
  if (!withinDays(meta.at, options.sinceDays, now)) return [];

  const out: Reply[] = [];
  const messages = resolve(dir, "messages.jsonl");
  if (existsSync(messages)) out.push(...repliesIn(messages, meta, isSubagent));

  // A subagent runs its own loop and writes its own log. Unlike a Claude Code
  // subagent, it does receive the project AGENTS.md, so its replies are held to
  // the same standard rather than being a known gap.
  const agents = resolve(dir, "agents");
  let entries;
  try {
    entries = readdirSync(agents, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push(...readSession(resolve(agents, entry.name), true, options, now));
  }
  return out;
}

export const vibeChat: ChatReader = {
  id: "vibe",
  label: "Mistral Vibe",

  available(): Availability {
    const dir = sessionsDir();
    if (!existsSync(dir)) {
      return { ok: false, why: `no session log directory at ${dir}` };
    }
    try {
      statSync(dir);
    } catch (e) {
      return { ok: false, why: `cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  },

  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    let entries;
    try {
      entries = readdirSync(sessionsDir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Reply[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      out.push(...readSession(resolve(sessionsDir(), entry.name), false, options, now));
    }
    return out;
  },

  /**
   * The reply a `post_agent` event is about.
   *
   * The payload carries no message of any kind: `PostAgentInvocation` holds the
   * session, the transcript path and the cwd, and nothing else. So unlike three
   * of the four other agents there is no fast path here, and the transcript is
   * the only source. The last assistant reply in it is the turn that just ended.
   */
  current(payload: Record<string, unknown>): Reply | null {
    const path = field(payload, "transcript_path");
    if (!path) return null;
    // The session directory is the transcript's parent, which is where the cwd
    // and the timestamps live.
    const meta = readMeta(resolve(path, ".."));
    const session = field(payload, "session_id") ?? meta.session;
    const isSubagent = typeof payload["parent_session_id"] === "string";
    const replies = repliesIn(path, { ...meta, session }, isSubagent);
    return replies[replies.length - 1] ?? null;
  },
};
