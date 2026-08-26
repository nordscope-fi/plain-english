/** Gemini CLI JSONL conversations under the per-project temporary directory. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { field, inScope, readJsonl, withinDays, type Availability, type ChatReader, type ReadOptions, type Reply } from "./reader.ts";

export function geminiHome(): string {
  const base = process.env["GEMINI_CLI_HOME"] || homedir();
  return basename(base) === ".gemini" ? resolve(base) : resolve(base, ".gemini");
}

function projectMappings(): Map<string, string> {
  try {
    const doc = JSON.parse(readFileSync(resolve(geminiHome(), "projects.json"), "utf8")) as { projects?: Record<string, string> };
    return new Map(Object.entries(doc.projects ?? {}).map(([cwd, id]) => [id, cwd]));
  } catch {
    return new Map();
  }
}

interface File { path: string; cwd?: string; subagent: boolean; mtime: number }

function files(options: ReadOptions, now: number): File[] {
  const tmp = resolve(geminiHome(), "tmp");
  const mappings = projectMappings();
  let projects;
  try { projects = readdirSync(tmp, { withFileTypes: true }); } catch { return []; }
  const out: File[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const cwd = mappings.get(project.name);
    if (!inScope(cwd, options.cwd)) continue;
    const chats = resolve(tmp, project.name, "chats");
    const walk = (dir: string, subagent: boolean) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) { walk(path, true); continue; }
        if (!entry.name.endsWith(".jsonl")) continue;
        let mtime: number;
        try { mtime = statSync(path).mtimeMs; } catch { continue; }
        if (options.sinceDays !== undefined && now - mtime > options.sinceDays * 86400000) continue;
        out.push({ path, cwd, subagent, mtime });
      }
    };
    walk(chats, false);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function textOf(record: Record<string, unknown>): string {
  if (record["type"] !== "gemini") return "";
  const content = record["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const part = raw as Record<string, unknown>;
    return part["thought"] !== true && typeof part["text"] === "string" ? [part["text"]] : [];
  }).join("");
}

function replies(path: string, subagent: boolean): Reply[] {
  const out: Reply[] = [];
  let session = basename(path, ".jsonl");
  readJsonl(path, (record, line) => {
    if (typeof record["sessionId"] === "string") session = record["sessionId"];
    const text = textOf(record);
    if (!text.trim()) return;
    const reply: Reply = { text, isSubagent: subagent, session, source: path, line };
    const at = typeof record["timestamp"] === "string" ? record["timestamp"] : undefined;
    if (at) reply.at = at;
    out.push(reply);
  });
  return out;
}

export const geminiChat: ChatReader = {
  id: "gemini",
  label: "Google Gemini CLI",
  available(): Availability {
    const dir = resolve(geminiHome(), "tmp");
    return existsSync(dir) ? { ok: true } : { ok: false, why: `no Gemini chat directory at ${dir}` };
  },
  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    return files(options, now).flatMap((file) =>
      replies(file.path, file.subagent).filter((reply) => withinDays(reply.at, options.sinceDays, now)),
    );
  },
  current(payload: Record<string, unknown>): Reply | null {
    const direct = field(payload, "prompt_response");
    const path = field(payload, "transcript_path") ?? "";
    if (direct) return { text: direct, isSubagent: false, session: field(payload, "session_id") ?? "", source: path, line: 0 };
    if (!path) return null;
    const found = replies(path, false);
    return found[found.length - 1] ?? null;
  },
  lastAsk(payload: Record<string, unknown>): string | undefined {
    return field(payload, "prompt");
  },
};
