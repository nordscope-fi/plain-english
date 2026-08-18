/**
 * GitHub Copilot CLI sessions.
 *
 * Location: `$COPILOT_HOME/session-store.db`, defaulting to `~/.copilot`.
 * SQLite, and the cleanest of the four stores:
 *
 *   sessions(id, cwd, repository, host_type, branch, summary, created_at, updated_at)
 *   turns(id, session_id, turn_index, user_message, assistant_response, timestamp)
 *
 * Evidence:
 *   observed  the schema above, read off a live store
 *   docs      the location, `COPILOT_HOME` replacing the whole path, the
 *             `reindex` command, and that sessions sync to the user's GitHub
 *             account by default
 *
 * Two things follow from the documentation and belong here rather than only in
 * a docs page. `COPILOT_HOME` replaces the entire directory, so the path is
 * never assumed. And Copilot's own documentation says session data syncs to
 * the user's GitHub account by default, which is the strongest reason in this
 * package for `lint --chat` being local-only and never a CI step.
 *
 * SQLite arrives through `node:sqlite`, which is built in from Node 22.5. The
 * package floor is Node 20, so the import is lazy and its absence is reported
 * in words rather than thrown. `.nvmrc` here already says 22.
 *
 * Copilot's `Stop` does not carry the reply text; only `SubagentStop` does.
 * So `current()` reads the payload when it is there and the store when it is
 * not, which is the whole reason this interface has two ways in.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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

export function copilotHome(): string {
  const override = process.env["COPILOT_HOME"];
  return override && override.length ? resolve(override) : resolve(homedir(), ".copilot");
}

export function storePath(): string {
  return resolve(copilotHome(), "session-store.db");
}

interface Row {
  session_id: string;
  turn_index: number;
  assistant_response: string | null;
  timestamp: string | null;
  cwd: string | null;
}

/**
 * Query a copy of the store, never the store.
 *
 * The obvious approach is `file:<path>?immutable=1`, and it is wrong here in a
 * way that reports success. Copilot runs its database in write-ahead logging
 * mode, where recent writes live in a `-wal` sidecar until a checkpoint folds
 * them in. `immutable=1` promises SQLite the file cannot change, so SQLite
 * skips the log entirely. Against a live store that meant the main file was
 * 4 KB and essentially empty, the log held 650 KB, and the query returned
 * "no such table: turns" or an empty result depending on the statement.
 *
 * A plain read-only open does read the log, but it wants to touch the `-shm`
 * file to do it, which is a write to somebody's agent state.
 *
 * So: copy the three files to a scratch directory and open the copy. The
 * original is never opened for writing, the log is honoured, and the copy goes
 * away afterwards.
 */
function query(sql: string, params: unknown[] = []): Row[] | { error: string } {
  let DatabaseSync: unknown;
  try {
    // Lazy, and through createRequire because this is an ES module: a static
    // import of node:sqlite would make the whole CLI fail to load on Node 20,
    // for a feature only this one reader needs.
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: unknown;
    });
  } catch {
    return {
      error:
        "reading Copilot chat needs Node 22.5 or newer, which is where node:sqlite arrives",
    };
  }
  let scratch: string | undefined;
  try {
    const Ctor = DatabaseSync as new (path: string) => {
      prepare(sql: string): { all(...p: unknown[]): unknown[] };
      close(): void;
    };
    scratch = mkdtempSync(resolve(tmpdir(), "plain-english-copilot-"));
    const copy = resolve(scratch, "session-store.db");
    copyFileSync(storePath(), copy);
    // The log and the shared-memory index, when they exist. Without the log
    // the copy is the stale checkpointed state, which is the bug above.
    for (const suffix of ["-wal", "-shm"]) {
      const side = storePath() + suffix;
      if (existsSync(side)) copyFileSync(side, copy + suffix);
    }
    const db = new Ctor(copy);
    try {
      return db.prepare(sql).all(...params) as unknown as Row[];
    } finally {
      db.close();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const SELECT =
  "SELECT t.session_id, t.turn_index, t.assistant_response, t.timestamp, s.cwd " +
  "FROM turns t LEFT JOIN sessions s ON s.id = t.session_id " +
  "WHERE t.assistant_response IS NOT NULL AND t.assistant_response != ''";

export const copilotChat: ChatReader = {
  id: "copilot",
  label: "GitHub Copilot CLI",

  available(): Availability {
    if (!existsSync(storePath())) {
      return {
        ok: false,
        why:
          `no session store at ${storePath()}. Copilot's reindex command rebuilds ` +
          "one from session files that were moved or restored",
      };
    }
    // Probes the real table, not a constant. A store whose schema this reader
    // cannot read has to say so rather than come back as zero replies.
    const probe = query("SELECT COUNT(*) AS turn_index FROM turns");
    if (!Array.isArray(probe)) return { ok: false, why: probe.error };
    return { ok: true };
  },

  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    const rows = query(SELECT + " ORDER BY t.session_id, t.turn_index");
    // An error here is reported by `available()`, which the caller prints. It
    // must never come back as an empty list, because a clean scan and a scan
    // that never ran look identical from the outside.
    if (!Array.isArray(rows)) return [];
    const out: Reply[] = [];
    for (const row of rows) {
      if (!row.assistant_response) continue;
      if (!inScope(row.cwd ?? undefined, options.cwd)) continue;
      const at = row.timestamp ?? undefined;
      if (!withinDays(at, options.sinceDays, now)) continue;
      const reply: Reply = {
        text: row.assistant_response,
        // The store records no subagent flag, so the split this package cares
        // about is not available on Copilot from the transcript alone.
        isSubagent: false,
        session: row.session_id,
        source: storePath(),
        // No lines in a table. The turn index is the locator a person can use.
        line: row.turn_index,
      };
      if (at) reply.at = at;
      out.push(reply);
    }
    return out;
  },

  current(payload: Record<string, unknown>): Reply | null {
    const session = field(payload, "sessionId", "session_id") ?? "";
    // Documented on SubagentStop, and documented as absent on Stop. Observed
    // absent on Stop: the payload carries only sessionId, stopReason,
    // stop_hook_active, cwd and transcriptPath.
    const direct = field(payload, "response", "last_assistant_message");
    if (direct) {
      return {
        text: direct,
        isSubagent: true,
        session,
        source: field(payload, "transcriptPath", "transcript_path") ?? storePath(),
        line: 0,
      };
    }

    // Main loop. `transcriptPath` names a live event stream, not the session
    // store: `session-state/<id>/events.jsonl`, where an `assistant.message`
    // record carries the reply under `data.content`. Observed present at the
    // moment the Stop hook runs, which the store is not guaranteed to be.
    const path = field(payload, "transcriptPath", "transcript_path");
    if (path) {
      let text = "";
      let line = 0;
      readJsonl(path, (record, at) => {
        if (record["type"] !== "assistant.message") return;
        const data = record["data"];
        if (!data || typeof data !== "object") return;
        const content = (data as Record<string, unknown>)["content"];
        // Last one wins: the reply this stop event is about is the latest.
        if (typeof content === "string" && content.trim()) {
          text = content;
          line = at;
        }
      });
      if (text) return { text, isSubagent: false, session, source: path, line };
    }

    // Nothing readable there. The store is the fallback rather than the
    // first choice, because it can lag the event that asked about it.
    if (!session) return null;
    const rows = query(SELECT + " AND t.session_id = ? ORDER BY t.turn_index DESC LIMIT 1", [session]);
    if (!Array.isArray(rows) || !rows.length) return null;
    const row = rows[0]!;
    if (!row.assistant_response) return null;
    const reply: Reply = {
      text: row.assistant_response,
      isSubagent: false,
      session,
      source: storePath(),
      line: row.turn_index,
    };
    if (row.timestamp) reply.at = row.timestamp;
    return reply;
  },
};
