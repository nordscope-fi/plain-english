import type { EngineInterface, Register } from 'claude-code'

import { classifyShellCommand } from './shell.mjs'
import { ISSUE_TOOLS } from './issue-tools.mjs'
import {
  approvalPlan, claudeCodeChat, claudeCodeHook, emptyFetched, formatText, hookCheck, lintTargets, lintText,
  ModelRequest, NeedFiles, pathsFor, projectGuidance, replay, replayIo, resolveRuleSet, stalledNotes, suppressedLine,
} from './core/plugin-core.mjs'
import DEFAULT_RULES from './core/default-rules.mjs'
import { askFor, noticeLine, oneLine, readChatVerdict, readPassages, readPaths, readToolVerdict, toolPayload } from './wire'

/** Files the docs channel judges. The checker strips code and frontmatter itself. */
const MARKDOWN = /\.(md|markdown|mdx)$/i


/** Fixed checker diagnostics only; anything else can contain private text. */
const SAFE_CHECK_NOTICES = new Set([
  'plain-english: extra model check could not start; pattern checks still apply.',
  'plain-english: extra model check timed out; pattern checks still apply.',
  'plain-english: extra model check failed; pattern checks still apply.',
  'plain-english: extra model check returned no usable answer; pattern checks still apply.',
  'plain-english: configuration unavailable; using local built-in pattern checks as advice only.',
])

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

/** What a file system answer from the checker's core looks like (ADR-008). */
interface FileFacts { kind: 'file' | 'directory' | 'link' | 'other'; mtimeMs: number; realPath?: string }
interface Fetched { reads: Map<string, string | null>; stats: Map<string, FileFacts | null>; lists: Map<string, string[] | null> }
interface Needed { reads: string[]; stats: string[]; lists: string[] }

/** One answer the mod got for a model question, keyed as the checker asked (ADR-006). */
interface ModelAnswer { key: string; text?: string; unavailable?: 'timed out' | 'failed'; usage?: Record<string, number> }

/** Values the checker keeps between checks, such as a turn's block state, for this session. */
const kept = new Map<string, { value: string; at: number }>()

/**
 * Runs part of the checker's core in this process (ADR-008). The core reads
 * files through a replay of what the mod has fetched; when it lacks a path it
 * throws `NeedFiles`, and the mod fetches every path it named and runs the
 * same work again. A model question comes back as `ModelRequest`; the mod asks
 * the session's model and runs again with the answer, as ADR-006 did with the
 * CLI. Notices are logged and kept values saved only from the run that
 * finishes: an earlier run worked from missing files, and its block record
 * would make the finishing run think the turn was already held.
 */
async function runCore<T>(
  $: EngineInterface,
  cwd: string,
  work: (io: unknown, answers: { answers: ModelAnswer[]; deadline?: number }) => T,
  signal: AbortSignal | undefined,
  rounds = 12,
): Promise<T> {
  const fetched: Fetched = emptyFetched()
  const host: { answers: ModelAnswer[]; deadline?: number } = { answers: [] }
  for (let round = 0; round < rounds; round++) {
    signal?.throwIfAborted()
    const notices: string[] = []
    const pending = new Map<string, { value: string; at: number }>()
    const io = replayIo({
      cwd,
      path: pathsFor(cwd),
      env: {},
      home: undefined,
      now: () => Date.now(),
      notice: (text: string) => { notices.push(text) },
      state: {
        get: (key: string) => pending.get(key) ?? kept.get(key),
        set: (key: string, value: string) => { pending.set(key, { value, at: Date.now() }); return true },
      },
      defaultRules: () => DEFAULT_RULES as string,
    }, fetched)
    try {
      const result = replay(io, (checked: unknown) => work(checked, host))
      for (const [key, value] of pending) kept.set(key, value)
      for (const notice of new Set(notices)) if (SAFE_CHECK_NOTICES.has(notice)) log($, notice)
      return result
    } catch (error) {
      if (error instanceof NeedFiles) {
        await fetchAll($, error as unknown as Needed, fetched)
        continue
      }
      if (error instanceof ModelRequest) {
        const asked = (error as unknown as { request: { key: string; prompt: string; timeoutMs: number } }).request
        host.answers.push(await answerModel($, asked, signal))
        continue
      }
      throw error
    }
  }
  throw new Error('check unavailable: the checker kept asking for files or model answers.')
}

/** Fetches every path one run lacked, at once. A path that cannot be read is recorded as missing. */
async function fetchAll($: EngineInterface, need: Needed, fetched: Fetched): Promise<void> {
  await Promise.all([
    ...need.reads.map(async path => {
      fetched.reads.set(path, await $.fs.read(path).catch(() => null))
    }),
    ...need.stats.map(async path => {
      const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
      fetched.stats.set(path, stat === undefined ? null : {
        kind: stat.isLink ? 'link' : stat.kind === 'dir' ? 'directory' : stat.kind,
        mtimeMs: stat.mtimeMs,
        ...(stat.realPath === undefined ? {} : { realPath: stat.realPath }),
      })
    }),
    ...need.lists.map(async path => {
      fetched.lists.set(path, await $.fs.list(path).then(entries => entries.map(entry => entry.name)).catch(() => null))
    }),
  ])
}

/**
 * Asks the session's model one question. A provider failure, and a call that
 * cannot be made at all, become an answer the checker reads as unavailable,
 * so the pattern result stands. A cancelled turn is not an answer: it ends the
 * check.
 */
async function answerModel($: EngineInterface, asked: { key: string; prompt: string; timeoutMs: number }, signal: AbortSignal | undefined): Promise<ModelAnswer> {
  try {
    const model = await $.session.model()
    const reply = await $.model.complete({ model, prompt: asked.prompt, timeoutMs: Math.max(1, Math.round(asked.timeoutMs)) }, signal ? { signal } : {})
    if (reply.isAnswered) return { key: asked.key, text: reply.text, usage: { ...reply.usage } }
    signal?.throwIfAborted()
    return { key: asked.key, unavailable: reply.reason === 'aborted' ? 'timed out' : 'failed' }
  } catch {
    signal?.throwIfAborted()
    return { key: asked.key, unavailable: 'failed' }
  }
}

/** One hook check, run in this process. Returns what the hook adapter prints. */
async function adapter(
  $: EngineInterface,
  channel: Channel,
  payload: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return runCore($, cwd, (io, host) => (hookCheck({
    channel, payload, profile: claudeCodeHook, reader: claudeCodeChat, io, host,
  }) as { stdout: string }).stdout, signal)
}

/** One step of a term approval (ADR-007), as the checker's core decides it. */
interface ApprovalStep { root: string; config: string; exists: boolean; hash: string; modelVocabulary: boolean }

/**
 * Runs one approval step. The checks run in the core against fresh file
 * answers; a `write` step that passes them saves through `$.fs.write` at a
 * fixed path, and only when Claude Code's working folder is the project root
 * the check named.
 */
async function approvalStep($: EngineInterface, cwd: string, request: Record<string, unknown>): Promise<ApprovalStep> {
  const plan = await runCore($, cwd, io => approvalPlan(cwd, request, (directory: string) => resolveRuleSet(directory, io), io) as {
    result: { ok: true } & ApprovalStep | { ok: false; message: string }
    write?: { path: string; exists: boolean; text: string }
  }, undefined)
  if (!plan.result.ok) throw new Error(plan.result.message)
  if (plan.write !== undefined) {
    // The write's path is fixed text, so it lands in Claude Code's own working
    // folder. Save only when that is the project root the check approved.
    const here = await $.fs.stat('.', { resolve: true }).catch(() => undefined)
    if (here?.realPath !== plan.result.root) {
      throw new Error(`Claude Code is working in a different folder from ${plan.result.root}, so nothing was saved. Add the term to ${plan.result.config} by hand.`)
    }
    if (plan.result.config === '.plain-english.yml') await $.fs.write('.plain-english.yml', plan.write.text)
    else if (plan.result.config === '.plain-english.yaml') await $.fs.write('.plain-english.yaml', plan.write.text)
    else throw new Error('This configuration cannot be written here.')
  }
  return plan.result
}

/** Only a deliberate, confirmed user action can save project vocabulary. */
async function approveProjectTerm($: EngineInterface, finding: ReviewFinding, term: string, ruleId: string, reason: string): Promise<string> {
  try {
    const request = { term, rule: ruleId, reason }
    const checked = await approvalStep($, finding.cwd, { ...request, phase: 'check' })
    const modelVocabulary = checked.modelVocabulary ? ' The extra model check and writing guidance will also treat this term as known vocabulary.' : ''
    const answer = await $.ui.ask(`Approve ${JSON.stringify(term)} project-wide for the ${ruleId} rule? This waives that rule on every line containing this exact term, across the project. Other rules still apply.${modelVocabulary} This saves an exception in ${checked.config}. Reason: ${reason}`, {
      header: 'Approve term', options: ['Approve for this project', 'Cancel'],
    })
    if (answer !== 'Approve for this project') return 'Project vocabulary was not changed.'
    await approvalStep($, finding.cwd, { ...request, phase: 'write', expect: checked })
    $.ui.invalidate('prompt.context')
    return `Approved ${JSON.stringify(term)} for ${ruleId} across this project. Other rules still apply. Retry the checked write.`
  } catch (error) {
    return `Project vocabulary was not changed: ${String(error)}`
  }
}

/**
 * What `plain-english lint` prints for these paths, run in this process: the
 * findings as text, the line for what `allow` hid, and any rule that ran out
 * of time. Linting waits for the round that lacks no file, since a run that
 * lacked one is discarded.
 */
function lintReport(cwd: string, paths: string[], io: unknown): string {
  const replay = io as { missing(): unknown }
  const ruleSet = resolveRuleSet(cwd, io)
  const empty = { findings: [], timedOut: [], suppressed: [] }
  const linted = lintTargets(paths, cwd, ruleSet, (text: string) => replay.missing() ? empty : lintText(text, ruleSet), io)
  if ('missing' in linted) return `plain-english: no such path: ${linted.missing}`
  const report = formatText(linted.all, cwd, 'file', io) + suppressedLine(linted.suppressed)
  const notes = stalledNotes(linted.stalled, cwd, io).join('\n')
  return `${report}${notes}`.trim()
}

/**
 * One transcript row. `$.ui.log` draws a single line: Claude Code 2.1.294
 * shows a line break inside it as U+FFFD and puts the plugin's name in front
 * of the row itself, so the text carries neither (issue #80).
 */
function log($: EngineInterface, text: string): void {
  $.ui.log(oneLine(text).replace(/^plain-english: /, ''))
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
  next: ((e: E) => Promise<R>) & { readonly signal: AbortSignal },
  record: (finding: ReviewFinding) => void,
): Promise<R | { block: string }> {
  const cwd = await $.session.cwd()
  const payload = e as unknown as Record<string, unknown>
  const stdout = await adapter($, 'chat', payload, cwd, next.signal)
  const verdict = readChatVerdict(stdout)
  if (verdict.notice !== undefined) log($, noticeLine(verdict.notice, verdict.kind === 'block'))
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
    const stdout = await adapter($, channel, payload, here.cwd, next.signal)
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
        const decision = answer === ask.refuse ? 'The user was asked and refused this write.'
          : answer ? `The user answered instead of choosing: ${JSON.stringify(answer)}`
          : 'No approval was received. The dialog was unavailable, dismissed, or unanswered.'
        return { deny: `${decision}\n\n${verdict.reason}` }
      }
      repairAttempts.delete(repairKey)
    }
    return next(e)
  }).catch(($, e, next) => {
    log($, `check unavailable; the write was allowed. ${next.error.message ?? 'The checker did not finish.'}`)
    return next(e)
  })

  // Two registrations, not a loop: the validator reads each event name off the
  // source as a string literal, and a name held in a variable does not load.
  on('classic.Stop', ($, e, next) => judgeReply($, e, next, finding => {
    current = finding
    $.ui.invalidate('ui.render')
  })).catch(($, e, next) => {
    log($, `reply check unavailable; the reply was allowed. ${next.error.message ?? 'The checker did not finish.'}`)
    return next(e)
  })
  on('classic.SubagentStop', ($, e, next) => judgeReply($, e, next, finding => {
    current = finding
    $.ui.invalidate('ui.render')
  })).catch(($, e, next) => {
    log($, `reply check unavailable; the reply was allowed. ${next.error.message ?? 'The checker did not finish.'}`)
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
      const text = (await runCore($, cwd, io => projectGuidance(resolveRuleSet(cwd, io), io) as string, undefined)).trim()
      if (new TextEncoder().encode(text).length > 32_768) throw new Error('Project writing guidance is too large (over 32 KB). Reduce project vocabulary or writing observations before loading it.')
      if (text === '') return base
      return { ...base, blocks: [...base.blocks.filter(block => block.name !== 'plainEnglishProject'), { name: 'plainEnglishProject', text }] }
    } catch (error) {
      log($, `project writing guidance unavailable. ${String(error)}`)
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
      return { text: `repair ${repair ? 'on' : 'off'} for this session. ${current === undefined ? 'No recent findings.' : `${readPassages(current.reason).length} quoted findings in the most recent check.`} Extra model checks follow project configuration; this command does not change them.` }
    }
    if (e.args.trim() === 'repair on' || e.args.trim() === 'repair off') {
      repair = e.args.trim() === 'repair on'
      repairAttempts.clear()
      return { text: `repair ${repair ? 'on' : 'off'} for this session. ${repair ? 'Advisory writes get one correction attempt before asking you. Required checks still refuse.' : 'Advisory writes ask you immediately.'}` }
    }
    let paths: string[]
    try {
      paths = readPaths(e.args)
    } catch (error) {
      return { text: String(error) }
    }
    try {
      // Each round of a walk fetches one level of the tree; the lint itself runs
      // once, in the round that lacks nothing.
      const text = await runCore($, cwd, io => lintReport(cwd, paths, io), undefined, 64)
      return { text: text === '' ? 'no findings.' : text }
    } catch (error) {
      return { text: `check unavailable. ${String(error)}` }
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
