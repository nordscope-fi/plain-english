/**
 * Which agent is on the other end of the pipe.
 *
 * `init` writes a shim that passes `--agent` explicitly, so in normal use this
 * is a lookup and nothing more. Detection exists for a config somebody wrote by
 * hand, and it is deliberately weak: four agents send a payload with the same
 * field names, so nothing in the JSON alone tells three of them apart. What
 * separates them is the environment they run in.
 *
 * Guessing wrong is not fatal. Every profile parses the shared snake_case
 * envelope, so a misdetected agent still reads the text correctly; only the
 * reply envelope would be wrong, and an agent that cannot parse the reply
 * treats the call as unhandled and carries on. Fail-open, as everywhere else.
 */

import type { AgentProfile } from "./profile.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import { cursor } from "./cursor.ts";
import { vibe } from "./vibe.ts";

/** Registration order is also the order `--help` lists them in. */
export const PROFILES: readonly AgentProfile[] = [claudeCode, copilot, codex, cursor, vibe];

export const DEFAULT_AGENT = claudeCode.id;

export function byId(id: string): AgentProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}

export function agentIds(): string[] {
  return PROFILES.map((p) => p.id);
}

/**
 * Pick a profile, most explicit signal first.
 *
 *   1. `--agent`, which is what every generated shim passes
 *   2. PLAIN_ENGLISH_AGENT, for wiring an agent this package has no profile for
 *   3. the payload's own shape, where it is distinctive
 *   4. an agent-specific environment variable
 *   5. Claude Code, because that is what the tool shipped with
 *
 * Throws on an unknown `--agent` value. A typo there should be an error rather
 * than a silent fall back to a protocol the caller did not ask for.
 */
export function resolveProfile(
  explicit: string | undefined,
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): AgentProfile {
  const named = explicit ?? env["PLAIN_ENGLISH_AGENT"];
  if (named) {
    const found = byId(named);
    if (!found) {
      throw new Error(`unknown agent '${named}'. Known agents: ${agentIds().join(", ")}`);
    }
    return found;
  }

  for (const p of PROFILES) {
    if (p.detect(raw)) return p;
  }
  return claudeCode;
}
