/** Native user-turn identities, including Cursor's generation-changing retries. */
import type { CheckerIo } from "../io.ts";
import { nodeIo } from "../node-io.ts";
import { sha256 } from "../sha256.ts";
import { ACK_WINDOW_MS } from "../adapters/hook.ts";
import { field, type ChatReader, type Reply } from "./reader.ts";

const hash = sha256;

export function chatTurnId(
  payload: Record<string, unknown>, reader: ChatReader, reply: Reply, projectDir: string, now?: number, io: CheckerIo = nodeIo,
): string {
  const at = now ?? io.now();
  const session = field(payload, "conversation_id", "conversationId", "session_id", "sessionId") ||
    reply.session || reply.source;
  const scope = JSON.stringify([io.path.resolve(io.cwd, projectDir), reader.id, session]);
  const activeKey = `plain-english-turn-${hash(scope).slice(0, 32)}`;
  const retry = payload["stop_hook_active"] === true || payload["stopHookActive"] === true ||
    (reader.id === "cursor" && typeof payload["loop_count"] === "number" && payload["loop_count"] > 0);
  if (reader.id === "cursor" && retry) {
    // Missing state leaves native retry protection in charge.
    const active = io.state.get(activeKey);
    if (active && at - active.at <= ACK_WINDOW_MS && /^[a-f0-9]{64}$/.test(active.value)) return active.value;
  }

  const turn = field(payload, "prompt_id", "promptId", "turn_id", "turnId") ||
    reader.turnId?.(payload, io) || field(payload, "generation_id") ||
    // Gemini supplies the last question even when its transcript is unreadable.
    // Identical questions need a native ID or transcript position to be distinct.
    (field(payload, "prompt") ? `question:${hash(field(payload, "prompt")!)}` : "unknown");
  const id = hash(JSON.stringify([scope, turn]));
  if (reader.id === "cursor" && !retry) {
    // A native loop_count still prevents repeated refusal if this fails.
    io.state.set(activeKey, id);
  }
  return id;
}
