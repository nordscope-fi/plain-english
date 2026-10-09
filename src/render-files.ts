/** Writing rendered files to disk. CLI only (ADR-008). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RenderTarget } from "./render.ts";

/** Write targets to disk. Returns the paths whose contents changed. */
export function writeTargets(targets: RenderTarget[]): string[] {
  const changed: string[] = [];
  for (const t of targets) {
    const existing = existsSync(t.path) ? readFileSync(t.path, "utf8") : null;
    if (existing === t.content) continue;
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, t.content, "utf8");
    changed.push(t.path);
  }
  return changed;
}
