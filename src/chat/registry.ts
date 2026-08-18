/**
 * Every chat reader, keyed the same way `src/agents/registry.ts` keys profiles.
 *
 * Two registries rather than one field on `AgentProfile`, because they answer
 * different questions and one of the four has an entry in only one of them.
 * Cursor has a reader and no gate; a profile with a null reader would say the
 * opposite of what is true.
 */

import { claudeCodeChat } from "./claude-code.ts";
import { codexChat } from "./codex.ts";
import { copilotChat } from "./copilot.ts";
import { cursorChat } from "./cursor.ts";
import type { ChatReader, ReadOptions, Reply } from "./reader.ts";

export const READERS: readonly ChatReader[] = [
  claudeCodeChat,
  codexChat,
  copilotChat,
  cursorChat,
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
