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

/** Tokenize user paths without evaluating shell expressions or expanding variables. */
export function readPaths(input: string): string[] {
  const paths: string[] = []
  let word = ''
  let quote = ''
  let active = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (char === '\\' && quote !== "'") {
      if (++i >= input.length) throw new Error('A path ends with an unfinished escape.')
      word += input[i]
      active = true
    } else if (quote !== '') {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      active = true
    } else if (/\s/.test(char)) {
      if (active) paths.push(word)
      word = ''
      active = false
    } else {
      word += char
      active = true
    }
  }
  if (quote !== '') throw new Error('A quoted path is missing its closing quote.')
  if (active) paths.push(word)
  if (paths.some(path => path === '')) throw new Error('A path cannot be empty.')
  return paths.length === 0 ? ['.'] : paths
}

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

/** One quoted passage, as the CLI's reason lists them. */
export interface Passage {
  line: number
  match: string
  ruleId: string
  hint?: string
}

/**
 * A finding line as `formatReason` in the CLI prints it:
 * `  line 3: "Furthermore" (furthermore) Start the sentence with its own point.`
 * The CLI and this module ship in one bundle, so the shape cannot drift
 * between them unseen; a line that does not match is simply not a passage.
 */
const PASSAGE = /^\s+line (\d+): ("(?:[^"\\]|\\.)*") \(([\w-]+)\)(?: (.*))?$/

/** The passages quoted in a reason, in the order the CLI gave them. */
export function readPassages(reason: string): Passage[] {
  const passages: Passage[] = []
  for (const line of reason.split('\n')) {
    const m = PASSAGE.exec(line)
    if (m === null) continue
    let match = m[2] ?? '""'
    try {
      match = String(JSON.parse(match))
    } catch {
      // the quoted form is still readable
    }
    const passage: Passage = { line: Number(m[1]), match, ruleId: m[3] ?? '' }
    if (m[4] !== undefined && m[4] !== '') passage.hint = m[4]
    passages.push(passage)
  }
  return passages
}

/**
 * Text fit for `$.ui.log`, which draws one transcript row: line breaks and
 * other control characters become spaces. Claude Code 2.1.294 draws a line
 * break inside a row as U+FFFD (issue #80).
 */
export function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/**
 * The transcript row for a reply check's notice. The engine hands a mod's
 * block reason to the model and draws none of it, so this row is what the
 * person sees of a held reply. It names up to three quoted passages, or the
 * notice's first line when it quotes none, and points at the pane that holds
 * the whole finding.
 */
export function noticeLine(notice: string, held: boolean): string {
  const passages = readPassages(notice)
  const shown = passages.slice(0, 3).map(passage => `${JSON.stringify(passage.match)} (${passage.ruleId})`)
  const more = passages.length > shown.length ? ` and ${passages.length - shown.length} more` : ''
  const what = shown.length > 0
    ? `${shown.join(', ')}${more}.`
    : notice.split('\n').find(line => line.trim() !== '') ?? notice
  return oneLine(`${held ? 'held this reply for a rewrite' : 'advice on this reply'}: ${what} /plain-english review shows the full finding.`)
}

/** The dialog an advisory finding opens: its text, its chip and its two answers. */
export interface Ask {
  question: string
  header: string
  allow: string
  refuse: string
}

/** The chip beside the question; the engine allows twelve characters. */
const HEADER = 'Prose check'
const REFUSE = 'Refuse so Claude rewrites'

/** What was about to happen, and the thing it would have happened to. */
function subjectOf(
  channel: 'docs' | 'github' | 'issue',
  e: Readonly<Record<string, unknown>>,
  cwd: string,
): { subject: string; verb: string; allow: string } {
  if (channel === 'docs') {
    let path = String(e['file_path'] ?? 'a file')
    if (path.startsWith(`${cwd}/`)) path = path.slice(cwd.length + 1)
    return { subject: path, verb: 'Save the file as it is?', allow: 'Save it as it is' }
  }
  if (channel === 'github') {
    const command = String(e['command'] ?? '')
    let subject = 'the commit message'
    if (/\bgh\s+pr\b/i.test(command)) subject = 'the pull request text'
    else if (/\bgh\s+issue\b/i.test(command)) subject = 'the issue text'
    else if (/\bgh\s+release\b/i.test(command)) subject = 'the release notes'
    return { subject, verb: 'Run the command as it is?', allow: 'Run it as it is' }
  }
  return { subject: 'the Linear issue', verb: 'Send it as it is?', allow: 'Send it as it is' }
}

/**
 * The question a person sees when a finding is advisory.
 *
 * The CLI's reason is written for the model: how to rewrite, and the narrower
 * ways to get past the check. Shown to a person it reads as instructions to
 * somebody else, with the actual question tacked on at the end. This names the
 * plugin, the file or command, one quoted passage with its rule, and asks a
 * question the person can answer. The model's text stays in the deny reason.
 */
export function askFor(
  channel: 'docs' | 'github' | 'issue',
  e: Readonly<Record<string, unknown>>,
  cwd: string,
  reason: string,
): Ask {
  const { subject, verb, allow } = subjectOf(channel, e, cwd)
  const passages = readPassages(reason)
  const first = passages[0]
  const lines: string[] = []

  if (first === undefined) {
    lines.push(`plain-english found writing in ${subject} that breaks its rules.`)
  } else if (passages.length === 1) {
    lines.push(`plain-english found one passage in ${subject} that breaks its rules:`)
  } else {
    lines.push(
      `plain-english found ${passages.length} passages in ${subject} that break its rules. The first:`,
    )
  }
  if (first !== undefined) {
    const hint = first.hint === undefined ? '' : ` ${first.hint}`
    lines.push('', `line ${first.line}: "${first.match}" (${first.ruleId})${hint}`)
  }
  lines.push('', `Refusing hands Claude the findings and a way to fix each. ${verb}`)

  return { question: lines.join('\n'), header: HEADER, allow, refuse: REFUSE }
}
