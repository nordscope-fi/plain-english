import type { EngineInterface, Register } from 'claude-code'

import { approveTerm } from './approval.mjs'
import { classifyShellCommand } from './shell.mjs'
import { askFor, readChatVerdict, readPassages, readPaths, readToolVerdict, toolPayload } from './wire'

/** Files the docs channel judges. The CLI strips code and frontmatter itself. */
const MARKDOWN = /\.(md|markdown|mdx)$/i

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
const PANE = 'plain-english-review'

type Channel = 'docs' | 'github' | 'issue' | 'chat'

interface ReviewFinding {
  channel: Channel
  reason: string
  strict: boolean
  event: Readonly<Record<string, unknown>>
  cwd: string
  key: string
}

/** Use the local effective config, or ask for a manual edit of an inherited one. */
async function approvalConfig($: EngineInterface, directory: string): Promise<{ path: string; exists: boolean }> {
  const separator = directory.includes('\\') ? '\\' : '/'
  const join = (dir: string, file: string) => `${dir.replace(/[\\/]$/, '')}${separator}${file}`
  for (const name of ['.plain-english.yml', '.plain-english.yaml']) {
    const path = join(directory, name)
    if (await $.fs.exists(path)) return { path, exists: true }
  }
  let ancestor = directory
  for (;;) {
    const cut = Math.max(ancestor.lastIndexOf('/'), ancestor.lastIndexOf('\\'))
    const parent = cut < 0 ? ancestor : cut === 0 ? separator : cut === 2 && /^[A-Za-z]:[\\/]/.test(ancestor) ? ancestor.slice(0, 3) : ancestor.slice(0, cut)
    if (parent === ancestor || parent === '') break
    ancestor = parent
    for (const name of ['.plain-english.yml', '.plain-english.yaml']) {
      if (await $.fs.exists(join(ancestor, name))) throw new Error('This project uses an inherited configuration. Add the scoped term to that configuration by hand; no child configuration was created.')
    }
  }
  return { path: join(directory, '.plain-english.yml'), exists: false }
}

/** Only a deliberate, confirmed user action can save project vocabulary. */
async function approveProjectTerm($: EngineInterface, finding: ReviewFinding, term: string, ruleId: string, reason: string): Promise<string> {
  try {
    const root = await $.fs.stat(finding.cwd, { resolve: true })
    if (root.realPath === undefined || root.kind !== 'dir') throw new Error('Cannot locate the project directory.')
    const { path, exists } = await approvalConfig($, root.realPath)
    if (exists) {
      const stat = await $.fs.stat(path, { resolve: true })
      if (stat.isLink || stat.kind !== 'file' || stat.realPath !== path) throw new Error('Review the linked configuration by hand.')
    }
    const original = exists ? await $.fs.read(path) : ''
    const updated = approveTerm(original, term, ruleId, reason)
    const explained = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'explain', ruleId], { cwd: root.realPath, timeoutMs: 5_000 })
    if (explained.exitCode !== 0 || explained.stdout.includes('(sentence shape)')) throw new Error(explained.stderr.trim() || 'This rule cannot be approved as project vocabulary.')
    const modelVocabulary = ruleId === 'unglossed-term' ? ' The extra model check and writing guidance will also treat this term as known vocabulary.' : ''
    const configName = path.split(/[\\/]/).pop()
    const answer = await $.ui.ask(`Approve ${JSON.stringify(term)} project-wide for the ${ruleId} rule? This waives that rule on every line containing this exact term, across the project. Other rules still apply.${modelVocabulary} This saves an exception in ${configName}. Reason: ${reason}`, {
      header: 'Approve term', options: ['Approve for this project', 'Cancel'],
    })
    if (answer !== 'Approve for this project') return 'Project vocabulary was not changed.'
    const currentRoot = await $.fs.stat(finding.cwd, { resolve: true })
    if (currentRoot.kind !== 'dir' || currentRoot.realPath !== root.realPath) throw new Error('The project directory changed. Review the destination again before saving.')
    const currentConfig = await approvalConfig($, root.realPath)
    if (currentConfig.path !== path || currentConfig.exists !== exists) throw new Error('The effective configuration changed. Review it again before saving.')
    const stillExists = await $.fs.exists(path)
    if (stillExists !== exists || (exists && await $.fs.read(path) !== original)) throw new Error('The configuration changed. Review it again before saving.')
    if (exists) {
      const stat = await $.fs.stat(path, { resolve: true })
      if (stat.isLink || stat.realPath !== path) throw new Error('The configuration destination changed.')
    }
    const stillExplained = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'explain', ruleId], { cwd: root.realPath, timeoutMs: 5_000 })
    if (stillExplained.exitCode !== 0 || stillExplained.stdout.includes('(sentence shape)')) throw new Error(stillExplained.stderr.trim() || 'This rule is no longer available for a vocabulary exception.')
    await $.fs.write(path, updated)
    $.ui.invalidate('prompt.context')
    return `Approved ${JSON.stringify(term)} for ${ruleId} across this project. Other rules still apply. Retry the checked write.`
  } catch (error) {
    return `Project vocabulary was not changed: ${String(error)}`
  }
}

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
  if (ran.exitCode !== 0) throw new Error(`check unavailable (exit ${ran.exitCode}). ${ran.stderr.trim()}`)
  if (ran.stdout.trim() !== '') {
    let parsed: unknown
    try { parsed = JSON.parse(ran.stdout) } catch { throw new Error('check unavailable: the checker returned an unreadable response.') }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('check unavailable: the checker returned an unexpected response.')
    const record = parsed as Record<string, unknown>
    if (channel === 'chat') {
      if (record['decision'] === 'block' && typeof record['reason'] === 'string') {
        // A refused reply.
      } else if (record['decision'] === undefined && typeof record['systemMessage'] === 'string') {
        // An allowed reply with advice.
      } else throw new Error('check unavailable: the reply checker returned an unknown decision.')
    } else {
      const specific = record['hookSpecificOutput'] as Record<string, unknown> | undefined
      if (specific === undefined || specific === null || typeof specific !== 'object' ||
        !['deny', 'ask'].includes(String(specific['permissionDecision'])) || typeof specific['permissionDecisionReason'] !== 'string') {
        throw new Error('check unavailable: the write checker returned an unknown decision.')
      }
    }
  }
  if (ran.stderr.trim() !== '') $.ui.log(`plain-english: ${ran.stderr.trim()}`)
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
    return classifyShellCommand(String(e['command'] ?? ''))
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
  record: (finding: ReviewFinding) => void,
): Promise<R | { block: string }> {
  const cwd = await $.session.cwd()
  const payload = e as unknown as Record<string, unknown>
  const stdout = await adapter($, 'chat', payload, cwd, CHAT_TIMEOUT_MS)
  const verdict = readChatVerdict(stdout)
  if (verdict.notice !== undefined) $.ui.log(verdict.notice)
  if (verdict.kind === 'block') {
    record({ channel: 'chat', reason: verdict.reason, strict: true, event: payload, cwd, key: '' })
    return { block: verdict.reason }
  }
  if (verdict.notice !== undefined) record({ channel: 'chat', reason: verdict.notice, strict: false, event: payload, cwd, key: '' })
  return next(e)
}

export const register: Register = on => {
  let repair = false
  const repairAttempts = new Set<string>()
  const keepOnce = new Set<string>()
  let actionNotice = ''
  let exceptionReason = ''
  let current: ReviewFinding | undefined
  /**
   * One tool.call hook serves the three write channels, picked by tool name.
   * Fail-open: a `.catch` that calls `next(e)` lets the write through when the
   * adapter itself fails, which is the contract every plain-english hook has.
   */
  on('tool.call', async ($, e, next) => {
    const channel = channelOf(e)
    if (channel === undefined) return next(e)

    const here = await session($)
    const payload = toolPayload(e, here)
    const key = JSON.stringify([here.id, channel, e['agentId'] ?? '', payload['tool_name'], payload['tool_input']])
    const stdout = await adapter($, channel, payload, here.cwd, TOOL_TIMEOUT_MS)
    const verdict = readToolVerdict(stdout)
    if (verdict.kind !== 'allow') {
      current = { channel, reason: verdict.reason, strict: verdict.kind === 'deny', event: e, cwd: here.cwd, key }
      $.ui.invalidate('ui.render')
    }

    const repairKey = `${channel}:${String(e['agentId'] ?? '')}:${String(e['file_path'] ?? e['tool'])}`
    if (verdict.kind === 'allow') repairAttempts.delete(repairKey)

    if (verdict.kind === 'deny') return { deny: verdict.reason }
    if (verdict.kind === 'ask') {
      if (keepOnce.delete(key)) {
        repairAttempts.delete(repairKey)
        return next(e)
      }
      if (repair && !repairAttempts.has(repairKey)) {
        repairAttempts.add(repairKey)
        return { deny: `Rewrite attempt 1 of 1. Correct the quoted passages and retry this write. If findings remain, the user decides.\n\n${verdict.reason}` }
      }
      // The settings hook's `ask` hands the decision to the person. So does
      // this, in the engine's own dialog, with a question written for them;
      // the model's guidance travels in the deny. Nobody to ask (a -p run)
      // refuses.
      const ask = askFor(channel, e, here.cwd, verdict.reason)
      let answer: string | undefined
      try {
        answer = await $.ui.ask(ask.question, {
          header: ask.header,
          options: [ask.allow, ask.refuse],
        })
      } catch {
        // dismissed, or no one to ask
      }
      if (answer !== ask.allow) {
        const decision = answer === ask.refuse ? 'The user was asked and refused this write.' : 'No approval was received. The dialog was unavailable, dismissed, or unanswered.'
        return { deny: `${decision}\n\n${verdict.reason}` }
      }
      repairAttempts.delete(repairKey)
    }
    return next(e)
  }).catch(($, e, next) => {
    $.ui.log(`plain-english: check unavailable; the write was allowed. ${next.error.message ?? 'The checker did not finish.'}`)
    return next(e)
  })

  // Two registrations, not a loop: the validator reads each event name off the
  // source as a string literal, and a name held in a variable does not load.
  on('classic.Stop', ($, e, next) => judgeReply($, e, next, finding => {
    current = finding
    $.ui.invalidate('ui.render')
  })).catch(($, e, next) => {
    $.ui.log(`plain-english: reply check unavailable; the reply was allowed. ${next.error.message ?? 'The checker did not finish.'}`)
    return next(e)
  })
  on('classic.SubagentStop', ($, e, next) => judgeReply($, e, next, finding => {
    current = finding
    $.ui.invalidate('ui.render')
  })).catch(($, e, next) => {
    $.ui.log(`plain-english: reply check unavailable; the reply was allowed. ${next.error.message ?? 'The checker did not finish.'}`)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Lint the working tree with plain-english and show the findings',
      argumentHint: '[paths | review | status | repair on/off]',
    })
    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const base = await next(e)
    try {
      const cwd = await $.session.cwd()
      const ran = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'guidance'], { cwd, timeoutMs: 5_000 })
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`)
      const text = ran.stdout.trim()
      if (new TextEncoder().encode(text).length > 32_768) throw new Error('Project writing guidance is too large (over 32 KB). Reduce project vocabulary or writing observations before loading it.')
      if (text === '') return base
      return { ...base, blocks: [...base.blocks.filter(block => block.name !== 'plainEnglishProject'), { name: 'plainEnglishProject', text }] }
    } catch (error) {
      $.ui.log(`plain-english: project writing guidance unavailable. ${String(error)}`)
      return base
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const cwd = await $.session.cwd()
    if (e.args.trim() === 'review') {
      await $.ui.open({ id: PANE, title: 'Plain English findings', focus: true, closeOnEscape: true })
      return {}
    }
    if (e.args.trim() === 'status') {
      return { text: `plain-english: repair ${repair ? 'on' : 'off'} for this session. ${current === undefined ? 'No recent findings.' : `${readPassages(current.reason).length} quoted findings in the most recent check.`} Extra model checks follow project configuration; this command does not change them.` }
    }
    if (e.args.trim() === 'repair on' || e.args.trim() === 'repair off') {
      repair = e.args.trim() === 'repair on'
      repairAttempts.clear()
      return { text: `plain-english: repair ${repair ? 'on' : 'off'} for this session. ${repair ? 'Advisory writes get one correction attempt before asking you. Required checks still refuse.' : 'Advisory writes ask you immediately.'}` }
    }
    let paths: string[]
    try {
      paths = readPaths(e.args)
    } catch (error) {
      return { text: `plain-english: ${String(error)}` }
    }
    try {
      const ran = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'lint', ...paths.map(path => path.startsWith('-') ? `./${path}` : path)], {
        cwd,
        timeoutMs: 120_000,
      })
      const text = (ran.stdout + ran.stderr).trim()
      if (ran.exitCode !== 0 && (ran.exitCode !== 1 || text === '')) {
        return { text: `plain-english: check unavailable (exit ${ran.exitCode}).${text === '' ? '' : '\n' + text}` }
      }
      return { text: text === '' ? 'plain-english: no findings.' : text }
    } catch (error) {
      return { text: `plain-english: check unavailable. ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const displayed = current
    const passages = current === undefined ? [] : readPassages(current.reason)
    return Box({ flexDirection: 'column', children: [
      Text({ bold: true, children: [passages.length === 0 && current !== undefined ? 'Latest finding' : `${passages.length} findings`] }),
      Text({ children: [`Repair ${repair ? 'on' : 'off'} for this session.`] }),
      Text({ children: [current === undefined ? 'No recent finding.' : `Most recent finding in ${String(current.event['file_path'] ?? current.channel)}.`] }),
      ...passages.map(passage => Text({ children: [`line ${passage.line}: ${JSON.stringify(passage.match)} (${passage.ruleId})${passage.hint === undefined ? '' : ' ' + passage.hint}`] })),
      ...(displayed === undefined ? [] : [Input({ key: 'exception-reason', label: 'Reason for an exception', value: exceptionReason, placeholder: 'Explain why this wording belongs here', onSubmit: text => {
        exceptionReason = text.trim()
        $.ui.invalidate('ui.render')
      } })]),
      ...passages.flatMap((passage, index) => {
        if (displayed === undefined || !/^[A-Za-z][\w .-]{0,79}$/.test(passage.match) || /(?:length|count|paragraph|sentence|structure)/.test(passage.ruleId)) return []
        return [Button({ key: `approve-term-${index}`, label: `Approve ${JSON.stringify(passage.match)} for this rule`, onPress: async () => {
          if (exceptionReason === '') actionNotice = 'Enter a reason and press Enter before approving a project term.'
          else actionNotice = await approveProjectTerm($, displayed, passage.match, passage.ruleId, exceptionReason)
          $.ui.invalidate('ui.render')
        } })]
      }),
      ...(displayed?.channel !== 'docs' ? [] : passages.map((passage, index) => Button({
        key: `copy-exception-${index}`, label: `Copy next-line exception for ${passage.ruleId}`, onPress: async () => {
          if (exceptionReason === '' || /[\r\n\x00-\x1f]|-->/.test(exceptionReason)) {
            actionNotice = 'Enter a one-line reason without comment markup, then press Enter.'
          } else {
            const comment = `<!-- plain-english-disable-next-line ${passage.ruleId}: ${exceptionReason} -->`
            const copied = await $.ui.copy({ text: comment })
            actionNotice = copied.isCopied
              ? `Copied ${comment}. Paste it immediately above the intended passage. This exempts one rule on the next line; no file was changed.`
              : `Clipboard unavailable. Paste ${comment} immediately above the intended passage.`
          }
          $.ui.invalidate('ui.render')
        },
      }))),
      Text({ children: [current?.channel === 'chat'
        ? current.strict ? 'Required reply checks refuse this reply. Correct it or add a justified project exception.' : 'The reply was allowed with advice. No temporary reply waiver was created.'
        : current?.strict ? 'Required checks refuse this write. Correct it or add a justified project exception.' : 'Keep this write once in the advisory decision dialog, or refuse so Claude rewrites.'] }),
      ...(displayed === undefined || displayed.strict || displayed.channel === 'chat' ? [] : [Button({ key: 'keep-once', label: 'Keep this write once', onPress: () => {
        keepOnce.add(displayed.key)
        actionNotice = 'Approved the identical write once for this session. Ask Claude to retry it. Changed text still gets checked.'
        $.ui.invalidate('ui.render')
      } })]),
      ...(actionNotice === '' ? [] : [Text({ children: [actionNotice] })]),
      ...(passages.length === 0 && current !== undefined ? [Text({ children: [current.reason] })] : []),
    ] })
  })
}
