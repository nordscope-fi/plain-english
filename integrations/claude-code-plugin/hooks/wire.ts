/**
 * The wire between the mod and the bundled CLI.
 *
 * The CLI's `hook <channel> --agent claude-code` reads one settings-hook
 * payload on stdin and prints Claude Code's own hook JSON: nothing when the
 * write may go ahead, `hookSpecificOutput.permissionDecision` for a tool
 * call, a flat `{ decision: "block", reason }` for a stop event. This file
 * builds the payload and reads the answer back, so `register.ts` holds the
 * hooks alone. Every reader here fails towards allowing: a linter is never
 * the reason a write cannot happen.
 */

/** What a pre-tool answer comes to once read. */
export type ToolVerdict =
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

/** What a stop answer comes to once read. */
export type ChatVerdict =
  | { kind: 'pass'; notice?: string }
  | { kind: 'block'; reason: string; notice?: string }

/** Commands the github channel judges; every other Bash call is skipped here. */
export const WRITE_COMMAND =
  /(^|[;&|]\s*)(git\s+commit\b|gh\s+pr\s+(create|edit|comment|review)\b|gh\s+issue\s+(create|edit|comment)\b|gh\s+release\s+(create|edit)\b)/i

/** The three keys `tool.call` carries beside the tool's own arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId'])

/**
 * A PreToolUse payload as a settings hook would read it on stdin, built from
 * a `tool.call` event: the tool's arguments are every field but the reserved.
 */
export function toolPayload(
  e: Readonly<Record<string, unknown>>,
  session: { id: string; cwd: string },
): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) {
    if (!RESERVED.has(key)) input[key] = value
  }
  return {
    hook_event_name: 'PreToolUse',
    session_id: session.id,
    cwd: session.cwd,
    tool_name: String(e['tool']),
    tool_use_id: e['tool_use_id'],
    tool_input: input,
  }
}

function parse(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim()
  if (text === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Reads a pre-tool answer. Anything unreadable allows. */
export function readToolVerdict(stdout: string): ToolVerdict {
  const out = parse(stdout)
  const specific = out?.['hookSpecificOutput']
  if (specific === null || typeof specific !== 'object') return { kind: 'allow' }
  const record = specific as Record<string, unknown>
  const decision = asString(record['permissionDecision'])
  const reason =
    asString(record['permissionDecisionReason']) ?? 'plain-english refused this write.'
  if (decision === 'deny') return { kind: 'deny', reason }
  if (decision === 'ask') return { kind: 'ask', reason }
  return { kind: 'allow' }
}

/** Reads a stop answer. Anything unreadable passes. */
export function readChatVerdict(stdout: string): ChatVerdict {
  const out = parse(stdout)
  if (out === undefined) return { kind: 'pass' }
  const notice = asString(out['systemMessage'])
  if (out['decision'] === 'block') {
    const reason = asString(out['reason']) ?? 'plain-english held this reply.'
    return notice === undefined ? { kind: 'block', reason } : { kind: 'block', reason, notice }
  }
  return notice === undefined ? { kind: 'pass' } : { kind: 'pass', notice }
}
