import type { EngineInterface, Register } from 'claude-code'

import { WRITE_COMMAND, askFor, readChatVerdict, readToolVerdict, toolPayload } from './wire'

/** Files the docs channel judges. The CLI strips code and frontmatter itself. */
const MARKDOWN = /\.(md|mdx)$/i

/** The Linear MCP tools the issue channel judges, as `init` matches them. */
const ISSUE_TOOLS = /^mcp__linear__save_(issue|comment)$/

/**
 * The CLI as `scripts/build-plugin.mjs` bundles it on every `npm run build`:
 * one file with every dependency inlined, committed beside this module so an
 * install from the marketplace needs nothing else. The ruleset it reads sits
 * at `../rules/default.yml` relative to it, where `rules.ts` looks.
 */
const CLI = 'dist/cli.mjs'

/**
 * The CLI's own hook budget is half a second of matching; the chat judge may
 * shell to a model and take seconds. Both stay far under the ten-minute cap,
 * and time inside `$.process.run` never counts against the hook's budget.
 */
const TOOL_TIMEOUT_MS = 20_000
const CHAT_TIMEOUT_MS = 60_000

const COMMAND = 'plain-english'

type Channel = 'docs' | 'github' | 'issue' | 'chat'

/** Runs the CLI's hook adapter on one payload and returns its stdout. */
async function adapter(
  $: EngineInterface,
  channel: Channel,
  payload: Record<string, unknown>,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const variables: Record<string, string> = { CLAUDE_PROJECT_DIR: cwd }
  const ran = await $.process.run(
    ['node', `${$.plugin.root}/${CLI}`, 'hook', channel, '--agent', 'claude-code'],
    { cwd, env: variables, stdin: JSON.stringify(payload), timeoutMs },
  )
  return ran.stdout
}

async function session($: EngineInterface): Promise<{ id: string; cwd: string }> {
  const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  return { id, cwd }
}

/** Which write channel a tool call belongs to, or none. */
function channelOf(e: Readonly<Record<string, unknown>>): 'docs' | 'github' | 'issue' | undefined {
  const tool = String(e['tool'])
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    return MARKDOWN.test(String(e['file_path'] ?? '')) ? 'docs' : undefined
  }
  if (tool === 'Bash') {
    return WRITE_COMMAND.test(String(e['command'] ?? '')) ? 'github' : undefined
  }
  return ISSUE_TOOLS.test(tool) ? 'issue' : undefined
}

/**
 * The chat gate, shared by the two stop events: the reply as the event
 * carries it goes to the chat adapter. A block holds the turn with the
 * reason, as the settings hook's flat JSON does, and never runs the settings
 * hooks beneath, so a project that also installed them is judged once. A
 * pass hands on to them.
 *
 * Verified live on 2.1.293: the block holds the turn in an interactive
 * session and under `claude -p`, where a settings `Stop` block is ignored.
 */
async function judgeReply<E extends { last_assistant_message?: string }, R extends { block?: string }>(
  $: EngineInterface,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R | { block: string }> {
  const cwd = await $.session.cwd()
  const payload = e as unknown as Record<string, unknown>
  const stdout = await adapter($, 'chat', payload, cwd, CHAT_TIMEOUT_MS)
  const verdict = readChatVerdict(stdout)
  if (verdict.notice !== undefined) $.ui.log(verdict.notice)
  if (verdict.kind === 'block') return { block: verdict.reason }
  return next(e)
}

export const register: Register = on => {
  /**
   * One tool.call hook serves the three write channels, picked by tool name.
   * Fail-open: a `.catch` that calls `next(e)` lets the write through when the
   * adapter itself fails, which is the contract every plain-english hook has.
   */
  on('tool.call', async ($, e, next) => {
    const channel = channelOf(e)
    if (channel === undefined) return next(e)

    const here = await session($)
    const stdout = await adapter($, channel, toolPayload(e, here), here.cwd, TOOL_TIMEOUT_MS)
    const verdict = readToolVerdict(stdout)

    if (verdict.kind === 'deny') return { deny: verdict.reason }
    if (verdict.kind === 'ask') {
      // The settings hook's `ask` hands the decision to the person. So does
      // this, in the engine's own dialog, with a question written for them;
      // the model's guidance travels in the deny. Nobody to ask (a -p run)
      // refuses.
      const ask = askFor(channel, e, here.cwd, verdict.reason)
      let answer = ask.refuse
      try {
        answer = await $.ui.ask(ask.question, {
          header: ask.header,
          options: [ask.allow, ask.refuse],
        })
      } catch {
        // dismissed, or no one to ask
      }
      if (answer !== ask.allow) {
        return { deny: `The user was asked and refused this write.\n\n${verdict.reason}` }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Two registrations, not a loop: the validator reads each event name off the
  // source as a string literal, and a name held in a variable does not load.
  on('classic.Stop', ($, e, next) => judgeReply($, e, next)).catch(($, e, next) => next(e))
  on('classic.SubagentStop', ($, e, next) => judgeReply($, e, next)).catch(($, e, next) =>
    next(e),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Lint the working tree with plain-english and show the findings',
      argumentHint: '[paths]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const cwd = await $.session.cwd()
    const paths = e.args.trim() === '' ? ['.'] : e.args.trim().split(/\s+/)
    const ran = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'lint', ...paths], {
      cwd,
      timeoutMs: 120_000,
    })
    const text = (ran.stdout + ran.stderr).trim()
    return { text: text === '' ? 'plain-english: no findings.' : text }
  })
}
