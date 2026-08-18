/**
 * Cursor CLI agent transcripts.
 *
 * Location: `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`.
 *
 * Evidence:
 *   observed  the record shapes below, and the path, read off a live store
 *   docs      nothing. Cursor documents how to resume a session and where its
 *             config lives, and documents neither this location nor its format
 *
 * This reader is the reason `docs/verifying-an-adapter.md` gained a chat
 * section. Inspecting disk first turned up
 * `~/.cursor/chats/<hash>/<uuid>/store.db`, a SQLite file whose `blobs` table
 * holds message JSON. Building on it looked reasonable and was wrong: in the
 * store examined, 11 of 39 blobs parsed as JSON and only 4 were assistant
 * messages. The rest are opaque to this reader. A reader built on that file
 * would have reported a fraction of the replies and looked exactly like one
 * that found nothing, which is the failure that page opens by naming.
 *
 * The JSONL above is the full transcript, and it was found by reading around
 * for documentation after the disk had already answered. Disk beat prose on
 * three agents here; prose beat disk on this one.
 *
 * There is no `current()`. Cursor documents `stop` and `afterAgentResponse`
 * hooks, and several reports say its CLI dispatches only the two shell events.
 * Until the tracer pass says otherwise, chat on Cursor is ungated, and the
 * word for that is ungated.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
  inScope,
  readJsonl,
  withinDays,
  type Availability,
  type ChatReader,
  type ReadOptions,
  type Reply,
} from "./reader.ts";

export function cursorHome(): string {
  const override = process.env["CURSOR_HOME"];
  return override && override.length ? resolve(override) : resolve(homedir(), ".cursor");
}

function projectsDir(): string {
  return resolve(cursorHome(), "projects");
}

/**
 * The working directory for a project directory.
 *
 * `~/.cursor/chats/<hash>/<uuid>/meta.json` carries a `cwd`, and the project
 * directory name is the path with its separators flattened. The name is used
 * only as a hint: a reply is kept when the requested directory appears in it,
 * so a scan scoped to one repository does not read every project on disk.
 */
function looksLikeProject(name: string, cwd: string | undefined): boolean {
  if (!cwd) return true;
  const flattened = cwd.replace(/^\//, "").replace(/[/.]/g, "-");
  return name.includes(flattened) || flattened.includes(name.replace(/^-/, ""));
}

interface Found {
  path: string;
  mtime: number;
}

function transcripts(cwd: string | undefined, sinceDays: number | undefined, now: number): Found[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const out: Found[] = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    if (!looksLikeProject(project.name, cwd)) continue;
    const dir = resolve(root, project.name, "agent-transcripts");
    let sessions;
    try {
      sessions = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = resolve(dir, session.name, `${session.name}.jsonl`);
      let mtime: number;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (sinceDays !== undefined && now - mtime > sinceDays * 24 * 60 * 60 * 1000) continue;
      out.push({ path: file, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The `cwd` a project directory reports, when a `meta.json` can be found for it. */
function metaCwd(project: string): string | undefined {
  const chats = resolve(cursorHome(), "chats");
  let hashes;
  try {
    hashes = readdirSync(chats, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const hash of hashes) {
    if (!hash.isDirectory()) continue;
    let sessions;
    try {
      sessions = readdirSync(resolve(chats, hash.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          readFileSync(resolve(chats, hash.name, session.name, "meta.json"), "utf8"),
        ) as Record<string, unknown>;
        if (typeof meta["cwd"] === "string" && looksLikeProject(project, meta["cwd"])) {
          return meta["cwd"];
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export const cursorChat: ChatReader = {
  id: "cursor",
  label: "Cursor CLI",

  available(): Availability {
    if (!existsSync(projectsDir())) {
      return { ok: false, why: `no agent transcripts at ${projectsDir()}` };
    }
    return { ok: true };
  },

  read(options: ReadOptions = {}): Reply[] {
    const now = Date.now();
    const out: Reply[] = [];
    for (const { path } of transcripts(options.cwd, options.sinceDays, now)) {
      // `basename`, not a split on "/": Windows `resolve` returns backslashes.
      const session = basename(path, ".jsonl");
      readJsonl(path, (record, line) => {
        if (record["role"] !== "assistant") return;
        const message = record["message"];
        if (!message || typeof message !== "object") return;
        const content = (message as Record<string, unknown>)["content"];
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b["type"] !== "text") continue;
          if (typeof b["text"] !== "string" || !b["text"].trim()) continue;
          if (!withinDays(undefined, options.sinceDays, now)) continue;
          out.push({
            text: b["text"],
            isSubagent: false,
            session,
            source: path,
            line,
          });
        }
      });
    }
    return out;
  },

  // No stop event this package trusts. See the header.
  current(): Reply | null {
    return null;
  },
};

/** Exported for the scope test, which is the only thing that needs it. */
export const __test = { looksLikeProject, metaCwd, inScope };
