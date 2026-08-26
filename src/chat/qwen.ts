/** Qwen Code JSONL conversations under ~/.qwen/projects. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { field, readJsonl, withinDays, type Availability, type ChatReader, type ReadOptions, type Reply } from "./reader.ts";

export function qwenHome(): string {
  return resolve(process.env["QWEN_HOME"] || resolve(homedir(), ".qwen"));
}

function looksLikeProject(name: string, cwd: string | undefined): boolean {
  if (!cwd) return true;
  const flattened = cwd.replace(/^[\\/]/, "").replace(/[\\/.]/g, "-");
  return name.includes(flattened) || flattened.includes(name.replace(/^-/, ""));
}

interface File { path: string; subagent: boolean; mtime: number }

function files(options: ReadOptions, now: number): File[] {
  const root = resolve(qwenHome(), "projects");
  let projects;
  try { projects = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: File[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || !looksLikeProject(project.name, options.cwd)) continue;
    const walk = (dir: string, subagent: boolean) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) { walk(path, subagent); continue; }
        if (!entry.name.endsWith(".jsonl")) continue;
        let mtime: number;
        try { mtime = statSync(path).mtimeMs; } catch { continue; }
        if (options.sinceDays !== undefined && now - mtime > options.sinceDays * 86400000) continue;
        out.push({ path, subagent, mtime });
      }
    };
    walk(resolve(root, project.name, "chats"), false);
    walk(resolve(root, project.name, "subagents"), true);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function replies(path: string, subagent: boolean): Reply[] {
  const out: Reply[] = [];
  let session = basename(path, ".jsonl");
  readJsonl(path, (record, line) => {
    if (record["type"] !== "assistant") return;
    if (typeof record["sessionId"] === "string") session = record["sessionId"];
    const message = record["message"];
    if (!message || typeof message !== "object") return;
    const parts = (message as Record<string, unknown>)["parts"];
    if (!Array.isArray(parts)) return;
    const text = parts.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const part = raw as Record<string, unknown>;
      return part["thought"] !== true && typeof part["text"] === "string" ? [part["text"]] : [];
    }).join("");
    if (!text.trim()) return;
    const reply: Reply = { text, isSubagent: subagent, session, source: path, line };
    if (typeof record["timestamp"] === "string") reply.at = record["timestamp"];
    out.push(reply);
  });
  return out;
}

export const qwenChat: ChatReader = {
  id: "qwen",
  label: "Qwen Code",
  available(): Availability {
    const dir = resolve(qwenHome(), "projects");
    return existsSync(dir) ? { ok: true } : { ok: false, why: `no Qwen chat directory at ${dir}` };
  },
  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    return files(options, now).flatMap((file) =>
      replies(file.path, file.subagent).filter((reply) => withinDays(reply.at, options.sinceDays, now)),
    );
  },
  current(payload: Record<string, unknown>): Reply | null {
    const direct = field(payload, "last_assistant_message");
    const subagent = payload["hook_event_name"] === "SubagentStop";
    const path = field(payload, "agent_transcript_path", "transcript_path") ?? "";
    if (direct) return { text: direct, isSubagent: subagent, session: field(payload, "session_id", "agent_id") ?? "", source: path, line: 0 };
    if (!path) return null;
    const found = replies(path, subagent);
    return found[found.length - 1] ?? null;
  },
};
