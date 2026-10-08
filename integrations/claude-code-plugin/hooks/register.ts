import type { EngineInterface, Register } from 'claude-code'

import { approveTerm } from './approval.mjs'
import { classifyShellCommand } from './shell.mjs'
import { ISSUE_TOOLS } from './issue-tools.mjs'
import { askFor, noticeLine, oneLine, readChatVerdict, readPassages, readPaths, readToolVerdict, toolPayload } from './wire'

/** Files the docs channel judges. The CLI strips code and frontmatter itself. */
const MARKDOWN = /\.(md|markdown|mdx)$/i

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
 * and time inside `$.process.spawn` never counts against the hook's budget.
 */
const TOOL_TIMEOUT_MS = 20_000
const CHAT_TIMEOUT_MS = 60_000

/** Fixed CLI diagnostics only; checker stderr can otherwise contain private text. */
const SAFE_CHECK_NOTICES = new Set([
  'plain-english: extra model check could not start; pattern checks still apply.',
  'plain-english: extra model check timed out; pattern checks still apply.',
  'plain-english: extra model check failed; pattern checks still apply.',
  'plain-english: extra model check returned no usable answer; pattern checks still apply.',
  'plain-english: model usage capture unavailable.',
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

/** One question the checker handed back instead of a decision (ADR-006). */
interface ModelRequest { key: string; prompt: string; timeoutMs: number; deadline?: number; model?: string }

/** The mod's answer to one request, as the checker reads it back. */
interface ModelAnswer { key: string; text?: string; unavailable?: 'timed out' | 'failed'; usage?: Record<string, number> }

/** One run per model question, plus the run that decides: two questions at most. */
const MAX_CHECKER_RUNS = 3

/**
 * Runs the CLI's hook adapter on one payload and returns its stdout.
 *
 * The CLI hands each model question back instead of starting `claude -p`,
 * which saves about 5 seconds per question on 2.1.294. The mod asks the
 * session's model and runs the CLI again with every answer so far; the CLI
 * replays its decision and finds them (ADR-006). Where the call cannot be made
 * at all, the check runs once more the old way.
 */
async function adapter(
  $: EngineInterface,
  channel: Channel,
  payload: Record<string, unknown>,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const plain: Record<string, string> = { CLAUDE_PROJECT_DIR: cwd, PLAIN_ENGLISH_CHECK_TIMEOUT_MS: String(timeoutMs) }
  const variables = { ...plain, PLAIN_ENGLISH_MODEL_ROUTE: 'host' }
  const answers: ModelAnswer[] = []
  let deadline: number | undefined
  for (let run = 1; ; run++) {
    const input = run === 1 ? payload : { ...payload, plainEnglishModel: { deadline, answers } }
    const ran = await runChecker($, channel, input, cwd, variables, signal)
    const asked = modelRequest(ran.stdout)
    if (asked === undefined) return finish($, channel, ran)
    if (run === MAX_CHECKER_RUNS) throw new Error('check unavailable: the checker kept asking for a model answer.')
    deadline = asked.deadline
    const answer = await answerModel($, asked, signal)
    if (answer === undefined) return finish($, channel, await runChecker($, channel, payload, cwd, plain, signal))
    answers.push(answer)
  }
}

/** The request in a checker's stdout, or `undefined` for anything else. */
function modelRequest(stdout: string): ModelRequest | undefined {
  try {
    const request = (JSON.parse(stdout) as Record<string, unknown>)['plainEnglishModelRequest'] as Record<string, unknown> | undefined
    if (!request || typeof request['key'] !== 'string' || typeof request['prompt'] !== 'string' || typeof request['timeoutMs'] !== 'number') return undefined
    return {
      key: request['key'], prompt: request['prompt'], timeoutMs: request['timeoutMs'],
      ...(typeof request['deadline'] === 'number' ? { deadline: request['deadline'] } : {}),
      ...(typeof request['model'] === 'string' ? { model: request['model'] } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Asks the session's model one question. A provider failure becomes an answer
 * the checker reads as unavailable, so the pattern result stands, as it does
 * when `claude -p` fails. A call that could not be made at all (an engine
 * without it, or a request it refuses to send) returns `undefined`, and the
 * check runs the old way. A cancelled turn is not an answer: it ends the check.
 */
async function answerModel($: EngineInterface, asked: ModelRequest, signal: AbortSignal): Promise<ModelAnswer | undefined> {
  try {
    const model = asked.model ?? await $.session.model()
    const reply = await $.model.complete({ model, prompt: asked.prompt, timeoutMs: Math.max(1, Math.round(asked.timeoutMs)) }, { signal })
    if (reply.isAnswered) return { key: asked.key, text: reply.text, usage: { ...reply.usage } }
    signal.throwIfAborted()
    return { key: asked.key, unavailable: reply.reason === 'aborted' ? 'timed out' : 'failed' }
  } catch {
    signal.throwIfAborted()
    return undefined
  }
}

/** One CLI run: its output, held to the byte limits, and its exit code. */
async function runChecker(
  $: EngineInterface,
  channel: Channel,
  payload: Record<string, unknown>,
  cwd: string,
  variables: Record<string, string>,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  // The stream follows the dispatch's cancellation signal. The asynchronous
  // wrapper relays it to the CLI's group, including a synchronous model child.
  const stream = $.process.spawn({
    argv: ['node', `${$.plugin.root}/hooks/run-checker.mjs`, `${$.plugin.root}/${CLI}`, 'hook', channel, '--agent', 'claude-code'],
    cwd, env: variables, input: JSON.stringify(payload),
  })
  const ran = { stdout: '', stderr: '', exitCode: null as number | null }
  const bytes = { stdout: 0, stderr: 0 }
  const stop = () => { void stream.return({ code: null, signal: null }).catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const chunk = await stream.next()
      if (chunk.done) {
        ran.exitCode = chunk.value.code
        if (chunk.value.signal !== null) throw new Error(`check unavailable (signal ${chunk.value.signal}).`)
        break
      }
      bytes[chunk.value.stream] += new TextEncoder().encode(chunk.value.text).length
      if (bytes[chunk.value.stream] > 4_194_304) throw new Error('check unavailable: checker output exceeded 4 MB.')
      ran[chunk.value.stream] += chunk.value.text
    }
  } finally {
    signal.removeEventListener('abort', stop)
    await stream.return({ code: null, signal: null })
  }
  if (ran.exitCode !== 0) throw new Error(`check unavailable (exit ${ran.exitCode}). ${ran.stderr.trim()}`)
  return ran
}

/**
 * Checks the deciding run's answer and reports its notices. Only this run's
 * notices are logged: it replayed every earlier question, so it repeats theirs.
 */
function finish($: EngineInterface, channel: Channel, ran: { stdout: string; stderr: string }): string {
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
  for (const notice of new Set(ran.stderr.split(/\r?\n/).map(line => line.trim()))) {
    if (SAFE_CHECK_NOTICES.has(notice)) log($, notice)
  }
  return ran.stdout
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
  const stdout = await adapter($, 'chat', payload, cwd, CHAT_TIMEOUT_MS, next.signal)
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
    const stdout = await adapter($, channel, payload, here.cwd, TOOL_TIMEOUT_MS, next.signal)
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
      const ran = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'guidance'], { cwd, timeoutMs: 5_000 })
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`)
      const text = ran.stdout.trim()
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
      const ran = await $.process.run(['node', `${$.plugin.root}/${CLI}`, 'lint', ...paths.map(path => path.startsWith('-') ? `./${path}` : path)], {
        cwd,
        timeoutMs: 120_000,
      })
      const text = (ran.stdout + ran.stderr).trim()
      if (ran.exitCode !== 0 && (ran.exitCode !== 1 || text === '')) {
        return { text: `check unavailable (exit ${ran.exitCode}).${text === '' ? '' : '\n' + text}` }
      }
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
