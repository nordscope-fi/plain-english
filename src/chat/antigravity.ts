/** Observed on Antigravity CLI 1.3.1: indexed JSONL steps and a SQLite workspace index. */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { field, inScope, readJsonl, withinDays, type ChatReader, type Reply } from "./reader.ts";

/** Override is for this linter's reader, not an Antigravity CLI setting. */
export function antigravityHome(): string {
  return process.env["PLAIN_ENGLISH_ANTIGRAVITY_HOME"] || resolve(homedir(), ".gemini", "antigravity-cli");
}

interface Step { record: Record<string, unknown>; line: number }
function steps(path: string): Step[] {
  const latest = new Map<number, Step>();
  readJsonl(path, (record, line) => {
    const index = record["step_index"];
    if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) {
      latest.set(index, { record, line });
    }
  });
  return [...latest.entries()].sort(([a], [b]) => a - b).map(([, step]) => step);
}

function explicitAsk(step: Step): boolean {
  return step.record["type"] === "USER_INPUT" && step.record["source"] === "USER_EXPLICIT";
}

function replyOf(step: Step, path: string, session: string, isSubagent = false): Reply | null {
  const record = step.record;
  if (record["type"] !== "PLANNER_RESPONSE" || record["source"] !== "MODEL" || record["status"] !== "DONE") return null;
  const text = record["content"];
  if (typeof text !== "string" || !text.trim()) return null;
  const reply: Reply = { text, session, isSubagent, source: path, line: step.line };
  if (typeof record["created_at"] === "string") reply.at = record["created_at"];
  return reply;
}

interface Summary { conversation_id: string; workspace_uris: string; parent_conversation_id: string; nesting_depth: number }
function summaries(): Summary[] {
  let scratch: string | undefined;
  try {
    let DatabaseSync;
    try { ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite")); }
    catch { throw new Error("reading Antigravity chat history needs Node 22.5 or newer"); }
    const source = resolve(antigravityHome(), "conversation_summaries.db");
    scratch = mkdtempSync(resolve(tmpdir(), "plain-english-antigravity-"));
    const copy = resolve(scratch, "summaries.db");
    copyFileSync(source, copy);
    // Recent workspace mappings can still be in the write-ahead log.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy);
    try {
      return db.prepare("SELECT conversation_id, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries").all() as Summary[];
    } finally { db.close(); }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function workspaces(row: Summary): string[] {
  try {
    const values: unknown = JSON.parse(row.workspace_uris);
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (typeof value !== "string") return [];
      try { return [fileURLToPath(value)]; } catch { return []; }
    });
  } catch { return []; }
}

export const antigravityChat: ChatReader = {
  id: "antigravity",
  label: "Google Antigravity CLI",
  available() {
    const path = resolve(antigravityHome(), "conversation_summaries.db");
    if (!existsSync(path)) return { ok: false, why: `no Antigravity conversation index at ${path}` };
    try { summaries(); return { ok: true }; }
    catch (error) { return { ok: false, why: error instanceof Error ? error.message : String(error) }; }
  },
  read(options = {}) {
    const now = Date.now();
    return summaries().flatMap((row) => {
      if (options.cwd && !workspaces(row).some((cwd) => inScope(cwd, options.cwd))) return [];
      // A conversation identifier is a directory name, never a relative path.
      if (!/^[A-Za-z0-9_-]+$/.test(row.conversation_id)) return [];
      const dir = resolve(antigravityHome(), "brain", row.conversation_id, ".system_generated", "logs");
      const full = resolve(dir, "transcript_full.jsonl");
      const path = existsSync(full) ? full : resolve(dir, "transcript.jsonl");
      return steps(path).flatMap((step) => {
        const reply = replyOf(step, path, row.conversation_id, Boolean(row.parent_conversation_id) || row.nesting_depth > 0);
        return reply && withinDays(reply.at, options.sinceDays, now) ? [reply] : [];
      });
    });
  },
  current(payload) {
    if (payload["fullyIdle"] === false) return null;
    if (field(payload, "error")) return null;
    const reason = field(payload, "terminationReason");
    if (reason && reason !== "NO_TOOL_CALL" && reason !== "model_stop") return null;
    const path = field(payload, "transcriptPath");
    if (!path) return null;
    const found = steps(path);
    let current: Reply | null = null;
    for (const step of found) {
      if (explicitAsk(step)) current = null;
      else current = replyOf(step, path, field(payload, "conversationId") ?? "") ?? current;
    }
    return current;
  },
  lastAsk(payload) {
    const path = field(payload, "transcriptPath");
    if (!path) return undefined;
    const ask = steps(path).filter(explicitAsk).at(-1);
    return ask && typeof ask.record["content"] === "string" ? ask.record["content"] : undefined;
  },
  turnId(payload) {
    const path = field(payload, "transcriptPath");
    const session = field(payload, "conversationId");
    if (!path || !session) return undefined;
    const ask = steps(path).filter(explicitAsk).at(-1);
    return ask ? `${session}:${ask.record["step_index"]}` : undefined;
  },
};
