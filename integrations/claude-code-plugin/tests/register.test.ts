import { describe, expect, test, tier, type TestBody } from 'claude-code/testing'

import { readPassages } from '../hooks/wire'

tier('user')

/** One output fixture answers either local commands or streaming model checks. */
function onProcess(on: Parameters<TestBody>[1], respond: (engine: Parameters<TestBody>[0], event: { argv: readonly string[]; init?: { stdin?: string } }) => { value?: { exitCode: number; stdout: string; stderr: string }; deny?: string }) {
  on('process.run', ($, e) => respond($, e))
  on('process.spawn', async function* ($, e) {
    const result = respond($, { argv: e.argv, init: { stdin: e.input } })
    if (result.value === undefined) throw new Error(result.deny ?? 'Process refused')
    if (result.value.stdout !== '') yield { stream: 'stdout', text: result.value.stdout }
    if (result.value.stderr !== '') yield { stream: 'stderr', text: result.value.stderr }
    return { value: { code: result.value.exitCode, signal: null } }
  })
}

const RUN = {
  exitCode: 0,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
  stream: 'stdout' as const,
}

const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      '"Furthermore" (furthermore): start the sentence with its own point.',
  },
})

/** The reason the CLI prints for an advisory finding, as `formatReason` lays it out. */
const ASK_REASON = [
  'This file contains writing that reads as machine-generated:',
  '',
  '  line 3: "Furthermore" (furthermore) Start the sentence with its own point.',
  '  line 3: "leverage" (leverage) Use \'use\'.',
  '',
  'Rewrite the quoted text in plain, direct language.',
  'Full ruleset: docs/writing-style.md',
  '',
  'Narrower ways to allow this, in order of preference:',
  '  1. <!-- plain-english-disable-next-line furthermore -->',
  '  2. add the path to `exclude` in .plain-english.yml',
  '  3. lower the rule to `severity: warn` in .plain-english.yml',
  '',
  "Last resort, and the human's call, not yours: touch .plain-english-ack-docs",
  '  It waives this channel for 10 minutes, then expires on its own.',
].join('\n')

const ASK = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: ASK_REASON,
  },
})

const BLOCK = JSON.stringify({
  decision: 'block',
  reason: 'reply-length: 300 words of prose, over 250.',
})

const PANE = {
  plugin: 'plain-english', component: 'Pane', requestId: 'plain-english-review',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'Plain English findings', isFocused: true, bodyColumns: 60,
    placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

describe('register', () => {
  test('runs write and reply model checks through the descendant cancellation wrapper', async ($, on) => {
    const calls: string[][] = []
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, ($, e) => {
      calls.push([...e.argv])
      return { value: { ...RUN, stdout: '' } }
    })
    on('tool.call', () => ({ result: 'written' }))
    on('classic.Stop', () => ({}))
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Clear words.' })
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Clear words.' })
    expect(calls.length).toBe(2)
    for (const argv of calls) {
      expect(argv[1]?.endsWith('/hooks/run-checker.mjs')).toBe(true)
      expect(argv[2]?.endsWith('/dist/cli.mjs')).toBe(true)
    }
    expect(calls[0]?.slice(3)).toEqual(['hook', 'docs', '--agent', 'claude-code'])
    expect(calls[1]?.slice(3)).toEqual(['hook', 'chat', '--agent', 'claude-code'])
  })
  test('counts checker output limits in bytes and reports unavailable', async ($, on) => {
    let logged = ''
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: '🙂'.repeat(1_048_577) } }))
    on('ui.log', ($, e) => { logged = e.text; return { value: undefined } })
    on('tool.call', () => ({ result: 'written' }))
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Clear words.' })
    expect(logged).toContain('checker output exceeded 4 MB')
  })
  test('approval does not save an exception for a rule removed since the finding', async ($, on) => {
    let saved = false
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, ($, e) => ({ value: e.argv.includes('explain')
      ? { ...RUN, exitCode: 2, stdout: '', stderr: 'no rule old-custom-rule' }
      : { ...RUN, stdout: ASK.replaceAll('furthermore', 'old-custom-rule') } }))
    on('fs.exists', () => ({ value: false }))
    on('fs.stat', ($, e) => ({ value: { kind: 'dir', isLink: false, size: 0, mtimeMs: 0, realPath: e.path } }))
    on('fs.write', () => { saved = true; return { value: undefined } })
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'written' }
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      return { result: { answers: { [String(question['question'])]: 'Approve for this project' } } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'exception-reason', text: 'Team vocabulary' })
    await ui.press({ key: 'approve-term-0' })
    expect(saved).toBe(false)
    expect(await ui.find({ type: 'Text', text: /no rule old-custom-rule/ })).toBeDefined()
    await ui.unmount()
  })
  test('approval rechecks the project destination after confirmation before creating a config', async ($, on) => {
    let confirmed = false
    let saved = false
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('fs.exists', () => ({ value: false }))
    on('fs.stat', () => ({ value: { kind: 'dir', isLink: confirmed, size: 0, mtimeMs: 0, realPath: confirmed ? '/elsewhere' : '/repo' } }))
    on('fs.write', () => { saved = true; return { value: undefined } })
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'written' }
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      if (!String(question['question']).includes('project-wide')) return { deny: 'dismissed' }
      confirmed = true
      return { result: { answers: { [String(question['question'])]: 'Approve for this project' } } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'exception-reason', text: 'Team vocabulary' })
    await ui.press({ key: 'approve-term-0' })
    expect(confirmed).toBe(true)
    expect(saved).toBe(false)
    expect(await ui.find({ type: 'Text', text: /project directory changed/ })).toBeDefined()
    await ui.unmount()
  })
  test('approval refuses to shadow an inherited project configuration', async ($, on) => {
    let saved = false
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo/sub' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('fs.exists', ($, e) => ({ value: e.path === '/repo/.plain-english.yaml' }))
    on('fs.stat', ($, e) => ({ value: { kind: 'dir', isLink: false, size: 0, mtimeMs: 0, realPath: e.path } }))
    on('fs.write', () => { saved = true; return { value: undefined } })
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'written' }
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      return { result: { answers: { [String(question['question'])]: 'Approve for this project' } } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/sub/a.md', content: 'Furthermore.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'exception-reason', text: 'Team vocabulary' })
    await ui.press({ key: 'approve-term-0' })
    expect(saved).toBe(false)
    expect(await ui.find({ type: 'Text', text: /inherited configuration/ })).toBeDefined()
    await ui.unmount()
  })
  test('oversized project guidance leaves the existing context intact and explains the skip', async ($, on) => {
    let notice = ''
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: 'x'.repeat(32_769) } }))
    on('ui.log', ($, e) => {
      notice = e.text
      return { value: undefined }
    })
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const blocks = [{ name: 'claudeMd', text: 'Keep the coding instructions.' }]
    const context = await $.prompt.context({ blocks })
    expect(context.blocks).toEqual(blocks)
    expect(notice).toContain('too large')
  })
  test('an unexpected response shape is unavailable rather than a clean check', async ($, on) => {
    let logged = ''
    let stdout = '[]'
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout } }))
    on('ui.log', ($, e) => {
      logged = e.text
      return { value: undefined }
    })
    on('tool.call', () => ({ result: 'written' }))
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'x' })).result).toBe('written')
    expect(logged).toContain('check unavailable')
    stdout = '{"unexpected": true}'
    logged = ''
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'x' })
    expect(logged).toContain('check unavailable')
  })
  test('project writing guidance joins context without replacing existing instructions', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    let args: string[] = []
    onProcess(on, ($, e) => {
      args = [...e.argv]
      return { value: { ...RUN, stdout: 'Our readers know BuildKit. Preserve approved quotations.' } }
    })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    const base = { name: 'claudeMd', text: 'Keep the coding instructions.' }
    const context = await $.prompt.context({ blocks: [base], instructionFiles: [] })
    expect(context.blocks).toEqual([base, { name: 'plainEnglishProject', text: 'Our readers know BuildKit. Preserve approved quotations.' }])
    expect(context.instructionFiles).toEqual([])
    expect(args.slice(2)).toEqual(['guidance'])
  })
  test('review also shows a refused reply without offering a one-time write bypass', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: JSON.stringify({ decision: 'block', reason: ASK_REASON }) } }))
    on('classic.Stop', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Furthermore.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Most recent finding in chat/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Furthermore/ })).toBeDefined()
    expect(await ui.find({ key: 'keep-once' })).toBeUndefined()
    await ui.unmount()
  })
  test('repair and review never weaken a required refusal', async ($, on) => {
    let dialogs = 0
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: DENY } }))
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') dialogs += 1
      return { result: 'written' }
    })
    await $.command.run({ command: 'plain-english', args: 'repair on' })
    const call = { tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' }
    expect((await $.tool.call(call)).deny).toContain('Furthermore')
    expect((await $.tool.call(call)).deny).toContain('Furthermore')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'keep-once' })).toBeUndefined()
    expect(dialogs).toBe(0)
    await ui.unmount()
  })
  test('a manual check that cannot start returns an unavailable notice', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ deny: 'node not found' }))
    const answer = await $.command.run({ command: 'plain-english', args: 'docs' })
    expect(answer.text).toContain('check unavailable')
  })
  test('a failed background check allows work but reports unavailable', async ($, on) => {
    const notices: string[] = []
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, exitCode: 2, stdout: '', stderr: 'Invalid configuration' } }))
    on('ui.log', ($, e) => {
      notices.push(e.text)
      return { value: undefined }
    })
    on('tool.call', () => ({ result: 'written' }))
    const answer = await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })
    expect(answer.result).toBe('written')
    expect(notices.join('\n')).toContain('check unavailable')
    expect(notices.join('\n')).toContain('Invalid configuration')
  })
  test('a scoped comment is copied only after a valid reason is supplied', async ($, on) => {
    let copied = ''
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', () => ({ deny: 'dismissed' }))
    on('ui.copy', ($, e) => {
      copied = e.text
      return { value: { isCopied: true } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'copy-exception-0' })
    expect(copied).toBe('')
    await ui.input({ key: 'exception-reason', text: 'Quoted customer wording' })
    await ui.press({ key: 'copy-exception-0' })
    expect(copied).toBe('<!-- plain-english-disable-next-line furthermore: Quoted customer wording -->')
    await ui.unmount()
  })
  test('term approval requires a reason and confirmation before saving a scoped exception', async ($, on) => {
    let saved = ''
    let dialogs = 0
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('fs.exists', () => ({ value: true }))
    on('fs.stat', ($, e) => ({ value: { kind: e.path === '/repo' ? 'dir' : 'file', isLink: false, size: 20, mtimeMs: 0, realPath: e.path } }))
    on('fs.read', () => ({ value: 'extends: default\nchat:\n  failOn: never\n' }))
    on('fs.write', ($, e) => {
      saved = String(e.text)
      return { value: undefined }
    })
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'written' }
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      if (!String(question['question']).includes('project-wide')) return { deny: 'dismissed' }
      dialogs += 1
      return { result: { answers: { [String(question['question'])]: 'Approve for this project' } } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'approve-term-0' })
    expect(saved).toBe('')
    expect(dialogs).toBe(0)
    await ui.input({ key: 'exception-reason', text: 'Our readers use this term' })
    await ui.press({ key: 'approve-term-0' })
    expect(await ui.find({ type: 'Text', text: /^Project vocabulary was not changed:/ })).toBeUndefined()
    expect(dialogs).toBe(1)
    expect(saved).toContain('failOn: never')
    expect(saved).toContain('Furthermore')
    expect(saved).toContain('furthermore')
    expect(saved).toContain('Our readers use this term')
    await ui.unmount()
  })
  test('keeping once permits only the identical advisory write and consumes approval', async ($, on) => {
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', ($, e) => e.tool === 'AskUserQuestion' ? { deny: 'dismissed' } : { result: 'written' })
    const call = { tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' }
    await $.tool.call(call)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'keep-once' })
    const otherAgent = await $.tool.call({ ...call, agentId: 'helper' })
    expect(otherAgent.deny).toContain('Furthermore')
    const changed = await $.tool.call({ ...call, content: 'Furthermore, changed.' })
    expect(changed.deny).toContain('Furthermore')
    const allowed = await $.tool.call(call)
    expect(allowed.result).toBe('written')
    const consumed = await $.tool.call(call)
    expect(consumed.deny).toContain('Furthermore')
    await ui.unmount()
  })
  test('review opens a pane containing the current quoted findings', async ($, on) => {
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', () => ({ deny: 'no one to ask' }))
    let opened = ''
    on('ui.open', ($, e) => {
      opened = e.id
      return { value: { isPlaced: true } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })
    await $.command.run({ command: 'plain-english', args: 'review' })
    expect(opened).toBe('plain-english-review')
    const tree = await $.ui.render({ component: 'Pane', requestId: opened, surface: 'terminal', props: {} })
    const shown = JSON.stringify(tree)
    expect(shown).toContain('2 findings')
    expect(shown).toContain('Furthermore')
    expect(shown).toContain('Keep this write once')
  })
  test('shell-written Markdown uses the shared docs check', async ($, on) => {
    let args: string[] = []
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, ($, e) => {
      args = [...e.argv]
      return { value: { ...RUN, stdout: DENY } }
    })
    on('tool.call', () => ({ result: 'written' }))
    const answer = await $.tool.call({ tool: 'Bash', command: 'printf "%s" "Furthermore." > "notes.md"' })
    expect(answer.deny).toContain('Furthermore')
    expect(args.slice(3)).toEqual(['hook', 'docs', '--agent', 'claude-code'])
  })
  test('manual paths preserve quoted spaces and flag-looking filenames', async ($, on) => {
    let args: string[] = []
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, ($, e) => {
      args = [...e.argv]
      return { value: { ...RUN, stdout: '' } }
    })
    await $.command.run({ command: 'plain-english', args: '"docs/Release notes.md" \'-draft.md\'' })
    expect(args.slice(2)).toEqual(['lint', 'docs/Release notes.md', './-draft.md'])
  })
  test('repair mode gives one rewrite attempt, then asks on repeat', async ($, on) => {
    let dialogs = 0
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'written' }
      dialogs += 1
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      return { result: { answers: { [String(question['question'])]: 'Save it as it is' } } }
    })
    await $.command.run({ command: 'plain-english', args: 'repair on' })
    const call = { tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' }
    const first = await $.tool.call(call)
    expect(first.deny).toContain('Rewrite attempt 1 of 1')
    expect(dialogs).toBe(0)
    const repeated = await $.tool.call({ ...call, content: 'Furthermore, updated.' })
    expect(repeated.deny).toBeUndefined()
    expect(dialogs).toBe(1)
    const later = await $.tool.call({ ...call, content: 'Furthermore, a later write.' })
    expect(later.deny).toContain('Rewrite attempt 1 of 1')
    expect(dialogs).toBe(1)
  })
  test('an empty failed manual check reports unavailable, not clean', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, exitCode: 2, stdout: '' } }))
    const answer = await $.command.run({ command: 'plain-english', args: 'docs' })
    expect(answer.text).toContain('check unavailable')
    expect(answer.text).not.toContain('no findings')
  })
  test('a Markdown write the adapter refuses is denied with its reason', async ($, on) => {
    const argv: string[][] = []
    const stdin: string[] = []
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, ($, e) => {
      argv.push([...e.argv])
      stdin.push(e.init?.stdin ?? '')
      return { value: { ...RUN, stdout: DENY } }
    })
    on('tool.call', () => ({ result: 'written' }))

    const result = await $.tool.call({
      tool: 'Write',
      file_path: '/repo/docs/a.md',
      content: 'Furthermore, the build is slow.',
    })

    expect(result.deny).toContain('Furthermore')
    expect(argv[0]?.slice(3)).toEqual(['hook', 'docs', '--agent', 'claude-code'])
    const payload = JSON.parse(stdin[0] ?? '{}')
    expect(payload.tool_name).toBe('Write')
    expect(payload.tool_input).toEqual({
      file_path: '/repo/docs/a.md',
      content: 'Furthermore, the build is slow.',
    })
    expect(payload.cwd).toBe('/repo')
  })

  test('a source file write never reaches the adapter', async ($, on) => {
    let runs = 0
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => {
      runs += 1
      return { value: { ...RUN, stdout: '' } }
    })
    on('tool.call', () => ({ result: 'written' }))

    const result = await $.tool.call({
      tool: 'Write',
      file_path: '/repo/src/a.ts',
      content: 'x',
    })

    expect(result.deny).toBeUndefined()
    expect(runs).toBe(0)
  })

  test('a read-only shell command never reaches the adapter', async ($, on) => {
    let runs = 0
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => {
      runs += 1
      return { value: { ...RUN, stdout: '' } }
    })
    on('tool.call', () => ({ result: 'ok' }))

    await $.tool.call({ tool: 'Bash', command: 'git status' })

    expect(runs).toBe(0)
  })

  test('a commit the adapter refuses is denied; one it allows runs', async ($, on) => {
    let stdout = DENY
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout } }))
    on('tool.call', () => ({ result: 'committed' }))

    const refused = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Furthermore"' })
    expect(refused.deny).toContain('Furthermore')

    stdout = ''
    const allowed = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Fix the build"' })
    expect(allowed.deny).toBeUndefined()
  })

  test('a reply the adapter blocks holds the turn with the reason', async ($, on) => {
    const stdin: string[] = []
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, ($, e) => {
      stdin.push(e.init?.stdin ?? '')
      return { value: { ...RUN, stdout: BLOCK } }
    })
    let reachedSettings = false
    on('classic.Stop', () => {
      reachedSettings = true
      return {}
    })

    const result = await $.classic.Stop({
      stop_hook_active: false,
      last_assistant_message: 'A long reply.',
    })

    expect(result.block).toBe('reply-length: 300 words of prose, over 250.')
    expect(reachedSettings, 'a block never runs the settings hooks beneath').toBe(false)
    expect(JSON.parse(stdin[0] ?? '{}').last_assistant_message).toBe('A long reply.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Latest finding' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0 findings' })).toBeUndefined()
    await ui.unmount()
  })

  test('a reply the adapter passes goes on to the settings hooks', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: '' } }))
    let reachedSettings = false
    on('classic.Stop', () => {
      reachedSettings = true
      return {}
    })

    const result = await $.classic.Stop({
      stop_hook_active: false,
      last_assistant_message: 'Fine.',
    })

    expect(result.block).toBeUndefined()
    expect(reachedSettings).toBe(true)
  })

  test('an advisory finding asks the person in their own terms and saves on yes', async ($, on) => {
    const dialogs: Record<string, unknown>[] = []
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'written' }
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      dialogs.push(question)
      return { result: { answers: { [String(question['question'])]: 'Save it as it is' } } }
    })

    const result = await $.tool.call({
      tool: 'Write',
      file_path: '/repo/docs/guide.md',
      content: 'Furthermore, we leverage the cache.',
    })

    expect(result.deny).toBeUndefined()
    expect(result.result).toBe('written')
    expect(dialogs).toHaveLength(1)
    const question = String(dialogs[0]?.['question'])
    expect(question).toContain('plain-english found 2 passages in docs/guide.md')
    expect(question).toContain('line 3: "Furthermore" (furthermore) Start the sentence with its own point.')
    expect(question, 'the second passage is counted, not shown').not.toContain('leverage')
    expect(question, 'the model guidance stays out of the dialog').not.toContain('Narrower ways')
    expect(question).toContain('Save the file as it is?')
    expect(dialogs[0]?.['header']).toBe('Prose check')
    const options = dialogs[0]?.['options'] as { label: string }[]
    expect(options.map((o) => o.label)).toEqual(['Save it as it is', 'Refuse so Claude rewrites'])
  })

  test('a refusal in the dialog denies the write with the guidance for the model', async ($, on) => {
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', ($, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'committed' }
      const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
      expect(String(question['question'])).toContain('the commit message')
      expect(String(question['question'])).toContain('Run the command as it is?')
      return { result: { answers: { [String(question['question'])]: 'Refuse so Claude rewrites' } } }
    })

    const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Furthermore"' })

    expect(result.deny).toContain('The user was asked and refused this write.')
    expect(result.deny).toContain('Narrower ways to allow this')
  })

  test('a dialog nobody can answer refuses', async ($, on) => {
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') return { deny: 'no one to ask' }
      return { result: 'written' }
    })

    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'x' })

    expect(result.deny).toContain('Furthermore')
    expect(result.deny).toContain('No approval was received')
  })

  test('readPassages reads the quoted lines and nothing else', async () => {
    const passages = readPassages(ASK_REASON)
    expect(passages).toEqual([
      {
        line: 3,
        match: 'Furthermore',
        ruleId: 'furthermore',
        hint: 'Start the sentence with its own point.',
      },
      { line: 3, match: 'leverage', ruleId: 'leverage', hint: "Use 'use'." },
    ])
    expect(readPassages('plain-english refused this write.')).toEqual([])
  })

  test('an adapter that throws lets the write through', async ($, on) => {
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    onProcess(on, () => {
      throw new Error('node: not found')
    })
    on('tool.call', () => ({ result: 'written' }))

    const result = await $.tool.call({
      tool: 'Write',
      file_path: '/repo/a.md',
      content: 'Furthermore.',
    })

    expect(result.deny).toBeUndefined()
  })

  test('/plain-english lints the working tree and answers the findings', async ($, on) => {
    const argv: string[][] = []
    on('session.cwd', () => ({ value: '/repo' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    onProcess(on, ($, e) => {
      argv.push([...e.argv])
      return { value: { ...RUN, stdout: 'docs/a.md\n  3:1 block "Furthermore"\n' } }
    })

    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const { text } = await $.command.run({
      command: 'plain-english',
      args: 'docs',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    expect(text).toContain('Furthermore')
    expect(argv[0]?.slice(2)).toEqual(['lint', 'docs'])
  })
})
