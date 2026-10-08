/** Native user-turn identities, including Cursor's generation-changing retries. */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ACK_WINDOW_MS } from "../adapters/hook.ts";
import { field, type ChatReader, type Reply } from "./reader.ts";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chatTurnId(
  payload: Record<string, unknown>, reader: ChatReader, reply: Reply, projectDir: string, now = Date.now(),
): string {
  const session = field(payload, "conversation_id", "conversationId", "session_id", "sessionId") ||
    reply.session || reply.source;
  const scope = JSON.stringify([resolve(projectDir), reader.id, session]);
  const activePath = resolve(tmpdir(), `plain-english-turn-${hash(scope).slice(0, 32)}`);
  const retry = payload["stop_hook_active"] === true || payload["stopHookActive"] === true ||
    (reader.id === "cursor" && typeof payload["loop_count"] === "number" && payload["loop_count"] > 0);
  if (reader.id === "cursor" && retry) {
    try {
      if (now - statSync(activePath).mtimeMs <= ACK_WINDOW_MS) {
        const active = readFileSync(activePath, "utf8");
        if (/^[a-f0-9]{64}$/.test(active)) return active;
      }
    } catch { /* Missing state leaves native retry protection in charge. */ }
  }

  const turn = field(payload, "prompt_id", "promptId", "turn_id", "turnId") ||
    reader.turnId?.(payload) || field(payload, "generation_id") ||
    // Gemini supplies the last question even when its transcript is unreadable.
    // Identical questions need a native ID or transcript position to be distinct.
    (field(payload, "prompt") ? `question:${hash(field(payload, "prompt")!)}` : "unknown");
  const id = hash(JSON.stringify([scope, turn]));
  if (reader.id === "cursor" && !retry) {
    try { writeFileSync(activePath, id, { mode: 0o600 }); }
    catch { /* A native loop_count still prevents repeated refusal. */ }
  }
  return id;
}
