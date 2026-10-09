/**
 * Init-time cleanup of chat state 0.12.0 left in working trees. Node only, and
 * CLI only: the checker's core never deletes files (ADR-008).
 */
import { readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Remove the state files 0.12.0 left in a working tree.
 *
 * Called by `init`, which is already writing to this repository and is the one
 * moment the package has permission to tidy. Named by our own marker, so
 * nothing else can match.
 */
export function sweepLegacyState(projectDir: string): string[] {
  const removed: string[] = [];
  try {
    for (const name of readdirSync(projectDir)) {
      if (!name.startsWith(".plain-english-chat-")) continue;
      try {
        unlinkSync(resolve(projectDir, name));
        removed.push(name);
      } catch {
        // A file we cannot delete is not worth failing an install over.
      }
    }
  } catch {
    // An unreadable directory means nothing to sweep.
  }
  return removed;
}
