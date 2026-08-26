/**
 * Every chat reader, keyed the same way `src/agents/registry.ts` keys profiles.
 *
 * Two registries rather than one field on `AgentProfile`, because they answer
 * different questions. Keeping transcript storage out of a hook protocol also
 * makes each side independently testable.
 */

import { claudeCodeChat } from "./claude-code.ts";
import { codexChat } from "./codex.ts";
import { copilotChat } from "./copilot.ts";
import { cursorChat } from "./cursor.ts";
import { geminiChat } from "./gemini.ts";
import { qwenChat } from "./qwen.ts";
import { vibeChat } from "./vibe.ts";
import type { ChatReader, ReadOptions, Reply } from "./reader.ts";

export const READERS: readonly ChatReader[] = [
  claudeCodeChat,
  codexChat,
  copilotChat,
  cursorChat,
  vibeChat,
  geminiChat,
  qwenChat,
];

export function readerFor(id: string): ChatReader | undefined {
  return READERS.find((r) => r.id === id);
}

export function readerIds(): string[] {
  return READERS.map((r) => r.id);
}

/** What one reader produced, including the reason it produced nothing. */
export interface ReaderResult {
  id: string;
  label: string;
  replies: Reply[];
  /** Present when the reader could not run. Never conflated with an empty list. */
  unavailable?: string;
}

/**
 * Run readers and keep the failures.
 *
 * The return shape is the point. A reader that could not run is not an empty
 * list: `docs/verifying-an-adapter.md` opens by naming that exact conflation,
 * where reading nothing and finding nothing look identical, and a caller that
 * printed "clean" over a store it never opened would be repeating it.
 */
export function readAll(readers: readonly ChatReader[], options: ReadOptions): ReaderResult[] {
  return readers.map((reader) => {
    const availability = reader.available();
    if (!availability.ok) {
      return { id: reader.id, label: reader.label, replies: [], unavailable: availability.why };
    }
    try {
      return { id: reader.id, label: reader.label, replies: reader.read(options) };
    } catch (e) {
      return {
        id: reader.id,
        label: reader.label,
        replies: [],
        unavailable: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

export type { ChatReader, ReadOptions, Reply } from "./reader.ts";
