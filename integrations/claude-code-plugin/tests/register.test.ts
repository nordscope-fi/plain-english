import { describe, expect, test, tier, type TestBody } from 'claude-code/testing'

import { readPassages } from '../hooks/wire'

tier('user')

type On = Parameters<TestBody>[1]

/**
 * The test engine works in the plugin's folder, so a fixed-path write from the
 * mod lands there; approval tests put their project in it.
 */
const PLUGIN = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '')

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** A project whose rules refuse rather than ask. */
const STRICT = 'version: 1\nextends: default\nfailOn: error\n'

/**
 * A project on a fake disk, as the mod's `$.fs` calls see it. The mod runs the
 * checker in its own process (ADR-008), so a test gives it files rather than
 * a checker's output, and the real checker decides.
 */
function project(on: On, files: Record<string, string> = {}, cwd = '/repo') {
  const disk = new Map(Object.entries(files).map(([path, text]) => [path.startsWith('/') ? path : `${cwd}/${path}`, text]))
  const writes: { path: string; text: string }[] = []
  const reads: string[] = []
  const at = (path: string) => path.startsWith('/') ? path : `${cwd}/${path}`
  // The session's folder and its parents exist even with no file in them.
  const isDir = (path: string) => path === '/' || `${cwd}/`.startsWith(`${path.replace(/\/$/, '')}/`) ||
    [...disk.keys()].some(file => file.startsWith(`${path.replace(/\/$/, '')}/`))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('fs.read', ($, e) => {
    reads.push(at(e.path))
    return disk.has(at(e.path)) ? { value: disk.get(at(e.path))! } : { deny: `ENOENT: ${at(e.path)}` }
  })
  on('fs.stat', ($, e) => {
    const path = at(e.path)
    const kind = disk.has(path) ? 'file' as const : isDir(path) ? 'dir' as const : undefined
    if (kind === undefined) return { deny: `ENOENT: ${path}` }
    return { value: { kind, size: disk.get(path)?.length ?? 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: path } : {}) } }
  })
  on('fs.list', ($, e) => {
    const path = at(e.path).replace(/\/$/, '')
    if (!isDir(path)) return { deny: `ENOTDIR: ${path}` }
    const names = new Set([...disk.keys()].filter(file => file.startsWith(`${path}/`)).map(file => file.slice(path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: disk.has(`${path}/${name}`) ? 'file' as const : 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.write', ($, e) => {
    writes.push({ path: at(e.path), text: e.text })
    disk.set(at(e.path), e.text)
    return { value: undefined }
  })
  return { disk, writes, reads }
}

/** The session's model, answering each question in turn; the last answer repeats. */
function model(on: On, ...answers: string[]) {
  const asked: { prompt: string; model: string; timeoutMs: number }[] = []
  on('model.complete', ($, e) => {
    asked.push({ prompt: String(e.prompt), model: String(e.model), timeoutMs: Number(e.timeoutMs) })
    return { value: { isAnswered: true, text: answers[Math.min(asked.length - 1, answers.length - 1)] ?? '{"ok": true}', usage: USAGE } }
  })
  return asked
}

/** Every transcript row the mod writes. */
function rows(on: On) {
  const logged: string[] = []
  on('ui.log', ($, e) => { logged.push(e.text); return { value: undefined } })
  return logged
}

/** Answers the engine's question dialog, and records each question. */
function dialog(on: On, answer: (question: string) => string | undefined, result: unknown = 'written') {
  const asked: Record<string, unknown>[] = []
  on('tool.call', ($, e) => {
    if (e.tool !== 'AskUserQuestion') return { result }
    const question = (e as { questions: Record<string, unknown>[] }).questions[0] ?? {}
    asked.push(question)
    const chosen = answer(String(question['question']))
    return chosen === undefined ? { deny: 'dismissed' } : { result: { answers: { [String(question['question'])]: chosen } } }
  })
  return asked
}

const PANE = {
  plugin: 'plain-english', component: 'Pane', requestId: 'plain-english-review',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'Plain English findings', isFocused: true, bodyColumns: 60,
    placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** A reply long enough to fail the reply-length count, in plain prose. */
const LONG_REPLY = Array.from({ length: 40 }, (_, i) => `Step ${i + 1} moves the cache file into the build folder and checks it again.`).join(' ')

describe('register', () => {
  test('checks a write, a reply, guidance and a lint without starting a program', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT, 'docs/a.md': 'Clear words.\n' })
    model(on)
    const started: string[] = []
    on('process.run', ($, e) => { started.push(String(e.argv)); return { deny: 'no programs' } })
    on('process.spawn', async function* ($, e) { started.push(String(e.argv)); throw new Error('no programs') })
    on('classic.Stop', () => ({}))
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    dialog(on, () => undefined)
    await $.tool.call({ tool: 'Write', file_path: '/repo/docs/b.md', content: 'Furthermore, the build is slow.' })
    await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Fine.' })
    await $.prompt.context({ blocks: [] })
    await $.command.run({ command: 'plain-english', args: 'docs' })
    expect(started).toEqual([])
  })

  test('a Markdown write the project\'s rules refuse is denied with its reason', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT })
    on('tool.call', () => ({ result: 'written' }))
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/docs/a.md', content: 'Furthermore, the build is slow.' })
    expect(result.deny).toContain('"Furthermore" (furthermore)')
  })

  test('a source file write never reaches the checker', async ($, on) => {
    const { reads } = project(on)
    on('tool.call', () => ({ result: 'written' }))
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'x' })
    expect(result.deny).toBeUndefined()
    expect(reads).toEqual([])
  })

  test('a read-only shell command never reaches the checker', async ($, on) => {
    const { reads } = project(on)
    on('tool.call', () => ({ result: 'ok' }))
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(reads).toEqual([])
  })

  test('a commit the rules refuse is denied; a clean one runs', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT })
    model(on)
    on('tool.call', () => ({ result: 'committed' }))
    const refused = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Furthermore, we leverage the cache"' })
    expect(refused.deny).toContain('Furthermore')
    const allowed = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Fix the build"' })
    expect(allowed.deny).toBeUndefined()
  })

  test('shell-written Markdown uses the shared docs check', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT })
    on('tool.call', () => ({ result: 'written' }))
    const answer = await $.tool.call({ tool: 'Bash', command: 'printf "%s" "Furthermore, the build is slow." > "notes.md"' })
    expect(answer.deny).toContain('Furthermore')
  })

  test('an advisory finding asks the person in their own terms and saves on yes', async ($, on) => {
    project(on)
    const asked = dialog(on, () => 'Save it as it is')
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/docs/guide.md', content: 'Furthermore, we leverage the cache.' })
    expect(result.deny).toBeUndefined()
    expect(result.result).toBe('written')
    expect(asked).toHaveLength(1)
    const question = String(asked[0]?.['question'])
    expect(question).toContain('plain-english found 2 passages in docs/guide.md')
    expect(question).toContain('line 1: "Furthermore" (furthermore)')
    expect(question, 'the second passage is counted, not shown').not.toContain('leverage')
    expect(question, 'the model guidance stays out of the dialog').not.toContain('Narrower ways')
    expect(question).toContain('Save the file as it is?')
    expect(asked[0]?.['header']).toBe('Prose check')
    expect((asked[0]?.['options'] as { label: string }[]).map(option => option.label)).toEqual(['Save it as it is', 'Refuse so Claude rewrites'])
  })

  test('a refusal in the dialog denies the write with the guidance for the model', async ($, on) => {
    project(on)
    const asked = dialog(on, () => 'Refuse so Claude rewrites', 'committed')
    const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Furthermore, we leverage the cache"' })
    expect(String(asked[0]?.['question'])).toContain('the commit message')
    expect(String(asked[0]?.['question'])).toContain('Run the command as it is?')
    expect(result.deny).toContain('The user was asked and refused this write.')
    expect(result.deny).toContain('Narrower ways to allow this')
  })

  test('a dialog nobody can answer refuses', async ($, on) => {
    project(on)
    on('tool.call', ($, e) => e.tool === 'AskUserQuestion' ? { deny: 'no one to ask' } : { result: 'written' })
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' })
    expect(result.deny).toContain('Furthermore')
    expect(result.deny).toContain('No approval was received')
  })

  // Issue #116: on 2.1.294 a typed answer resolves `$.ui.ask` to the typed
  // text, while "Chat about this" and Esc both reject the same way.
  test('a typed answer to the write approval reaches the model as the person\'s words', async ($, on) => {
    project(on)
    dialog(on, () => 'Keep it, the quote is from the customer')
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' })
    expect(result.deny).toContain('The user answered instead of choosing: "Keep it, the quote is from the customer"')
    expect(result.deny).not.toContain('dismissed')
  })

  // ADR-006: a clean write gets one model question, asked through the
  // session's own model, and the answer decides.
  test('a model question from the checker is answered in the session', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT })
    const asked = model(on, '{"ok": false, "reason": "Lead with the point."}')
    on('tool.call', () => ({ result: 'written' }))
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/docs/a.md', content: 'The cache holds parsed results for an hour.' })
    expect(result.deny).toBe('Lead with the point.')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.model).toBe('claude-test')
    expect(asked[0]!.prompt).toContain('The cache holds parsed results for an hour.')
    expect(asked[0]!.timeoutMs).toBeGreaterThan(0)
  })

  test('a provider error or a call that cannot be made leaves the pattern result, with one notice', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT })
    const logged = rows(on)
    const replies: unknown[] = [
      { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
    ]
    on('model.complete', () => {
      const reply = replies.shift()
      if (reply === undefined) throw new Error('model not allowed')
      return { value: reply as never }
    })
    on('tool.call', () => ({ result: 'written' }))
    const call = { tool: 'Write', file_path: '/repo/docs/a.md', content: 'The cache holds parsed results for an hour.' }
    expect((await $.tool.call(call)).result).toBe('written')
    expect((await $.tool.call(call)).result).toBe('written')
    expect(logged).toEqual([
      'extra model check failed; pattern checks still apply.',
      'extra model check failed; pattern checks still apply.',
    ])
  })

  test('a long reply gets two model questions in a row, and the answers decide', async ($, on) => {
    project(on)
    const asked = model(on, '{"ok": true}', '{"ok": true}')
    let reachedSettings = false
    on('classic.Stop', () => { reachedSettings = true; return {} })
    const result = await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: LONG_REPLY })
    expect(asked).toHaveLength(2)
    expect(result.block).toBeUndefined()
    expect(reachedSettings).toBe(true)
  })

  test('a reply the rules block holds the turn with the reason', async ($, on) => {
    project(on)
    let reachedSettings = false
    on('classic.Stop', () => { reachedSettings = true; return {} })
    const result = await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Furthermore, we leverage the cache.' })
    expect(result.block).toContain('"Furthermore" (furthermore)')
    expect(reachedSettings, 'a block never runs the settings hooks beneath').toBe(false)
  })

  test('a reply the rules pass goes on to the settings hooks', async ($, on) => {
    project(on)
    model(on)
    let reachedSettings = false
    on('classic.Stop', () => { reachedSettings = true; return {} })
    const result = await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Fine.' })
    expect(result.block).toBeUndefined()
    expect(reachedSettings).toBe(true)
  })

  // Issue #80: `$.ui.log` draws one row, and 2.1.294 shows each line break in
  // it as U+FFFD. The engine does not draw a mod's block reason to the person,
  // so this row is all they see of a held reply.
  test('a held reply is reported in one transcript row, with the full reason kept for the model', async ($, on) => {
    project(on)
    const logged = rows(on)
    on('classic.Stop', () => ({}))
    const result = await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Furthermore, we leverage the cache.' })
    expect(result.block).toContain('\n')
    expect(logged).toEqual(['held this reply for a rewrite: "Furthermore" (furthermore), "leverage" (leverage). /plain-english review shows the full finding.'])
  })

  test('advice on an allowed reply is one transcript row', async ($, on) => {
    project(on, { '.plain-english.yml': 'version: 1\nextends: default\nchat:\n  failOn: never\n' })
    model(on)
    const logged = rows(on)
    let reachedSettings = false
    on('classic.Stop', () => { reachedSettings = true; return {} })
    const result = await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Furthermore, we leverage the cache.' })
    expect(result.block).toBeUndefined()
    expect(reachedSettings).toBe(true)
    expect(logged).toEqual(['advice on this reply: "Furthermore" (furthermore), "leverage" (leverage). /plain-english review shows the full finding.'])
  })

  test('a held reply with no quoted passage reports its first line', async ($, on) => {
    project(on, { '.plain-english.yml': 'version: 1\nextends: default\nmodelChecks: false\n' })
    const logged = rows(on)
    on('classic.Stop', () => ({}))
    const result = await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: LONG_REPLY })
    expect(result.block).toBeDefined()
    expect(logged).toEqual([expect.stringMatching(/^held this reply for a rewrite: /)])
    expect(logged[0]).toMatch(/^held this reply for a rewrite: \S/)
    expect(logged[0]).not.toMatch(/[\r\n]/)
  })

  test('an unavailable check is reported in one row and lets the work through', async ($, on) => {
    const logged = rows(on)
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => { throw new Error('first line\nsecond line\r\nthird') })
    on('tool.call', () => ({ result: 'written' }))
    on('classic.Stop', () => ({}))
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore.' })).result).toBe('written')
    expect((await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Furthermore.' })).block).toBeUndefined()
    expect(logged.length).toBe(2)
    for (const line of logged) {
      expect(line).toContain('check unavailable')
      expect(line).not.toMatch(/[\r\n]/)
    }
  })

  test('approval refuses to shadow an inherited configuration and asks nothing', async ($, on) => {
    const { writes } = project(on, { '/repo/.plain-english.yml': 'version: 1\nextends: default\n' }, '/repo/sub')
    const asked = dialog(on, question => question.includes('project-wide') ? 'Approve for this project' : undefined)
    await $.tool.call({ tool: 'Write', file_path: '/repo/sub/a.md', content: 'Furthermore, the build is slow.' })
    asked.length = 0
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'exception-reason', text: 'Team vocabulary' })
    await ui.press({ key: 'approve-term-0' })
    expect(asked).toEqual([])
    expect(writes).toEqual([])
    expect(await ui.find({ type: 'Text', text: /inherited configuration/ })).toBeDefined()
    await ui.unmount()
  })

  test('term approval requires a reason and confirmation, then saves a scoped exception', async ($, on) => {
    const { writes } = project(on, {}, PLUGIN)
    const asked = dialog(on, question => question.includes('project-wide') ? 'Approve for this project' : undefined)
    await $.tool.call({ tool: 'Write', file_path: `${PLUGIN}/a.md`, content: 'Furthermore, the build is slow.' })
    asked.length = 0
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'approve-term-0' })
    expect(asked).toEqual([])
    expect(writes).toEqual([])
    await ui.input({ key: 'exception-reason', text: 'Our readers use this term' })
    await ui.press({ key: 'approve-term-0' })
    expect(asked).toHaveLength(1)
    expect(writes.map(write => write.path)).toEqual([`${PLUGIN}/.plain-english.yml`])
    expect(writes[0]!.text).toContain('Approved in Plain English review: Our readers use this term')
    expect(writes[0]!.text).toContain('Furthermore')
    expect(writes[0]!.text).toContain('- furthermore')
    expect(await ui.find({ type: 'Text', text: /^Approved "Furthermore" for furthermore/ })).toBeDefined()
    await ui.unmount()
  })

  test('approval writes nothing when the configuration changed after the check', async ($, on) => {
    const { disk, writes } = project(on, { '.plain-english.yml': 'version: 1\nextends: default\n' }, PLUGIN)
    dialog(on, question => {
      if (!question.includes('project-wide')) return undefined
      disk.set(`${PLUGIN}/.plain-english.yml`, 'version: 1\nextends: default\nexclude: ["drafts/**"]\n')
      return 'Approve for this project'
    })
    await $.tool.call({ tool: 'Write', file_path: `${PLUGIN}/a.md`, content: 'Furthermore, the build is slow.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'exception-reason', text: 'Team vocabulary' })
    await ui.press({ key: 'approve-term-0' })
    expect(writes).toEqual([])
    expect(await ui.find({ type: 'Text', text: /configuration changed/ })).toBeDefined()
    await ui.unmount()
  })

  test('project writing guidance joins context without replacing existing instructions', async ($, on) => {
    project(on, { '.plain-english.yml': 'version: 1\nextends: default\nallow:\n  - pattern: "BuildKit"\n    rules: [unglossed-term]\n    semantic: true\n' })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    const base = { name: 'claudeMd', text: 'Keep the coding instructions.' }
    const context = await $.prompt.context({ blocks: [base], instructionFiles: [] })
    expect(context.blocks[0]).toEqual(base)
    expect(context.blocks[1]?.name).toBe('plainEnglishProject')
    expect(context.blocks[1]?.text).toContain('BuildKit')
    expect(context.instructionFiles).toEqual([])
  })

  test('oversized project guidance leaves the existing context intact and explains the skip', async ($, on) => {
    const terms = Array.from({ length: 2500 }, (_, i) => `  - pattern: "Product${String(i).padStart(5, '0')}Name"\n    semantic: true\n`).join('')
    project(on, { '.plain-english.yml': `version: 1\nextends: default\nallow:\n${terms}` })
    const logged = rows(on)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const blocks = [{ name: 'claudeMd', text: 'Keep the coding instructions.' }]
    const context = await $.prompt.context({ blocks })
    expect(context.blocks).toEqual(blocks)
    expect(logged.join('\n')).toContain('too large')
  })

  test('review also shows a refused reply without offering a one-time write bypass', async ($, on) => {
    project(on)
    on('classic.Stop', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, cwd: '/repo', last_assistant_message: 'Furthermore, we leverage the cache.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Most recent finding in chat/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Furthermore/ })).toBeDefined()
    expect(await ui.find({ key: 'keep-once' })).toBeUndefined()
    await ui.unmount()
  })

  test('repair and review never weaken a required refusal', async ($, on) => {
    project(on, { '.plain-english.yml': STRICT })
    const asked = dialog(on, () => 'Save it as it is')
    await $.command.run({ command: 'plain-english', args: 'repair on' })
    const call = { tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' }
    expect((await $.tool.call(call)).deny).toContain('Furthermore')
    expect((await $.tool.call(call)).deny).toContain('Furthermore')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'keep-once' })).toBeUndefined()
    expect(asked).toEqual([])
    await ui.unmount()
  })

  test('a scoped comment is copied only after a valid reason is supplied', async ($, on) => {
    project(on)
    dialog(on, () => undefined)
    let copied = ''
    on('ui.copy', ($, e) => { copied = e.text; return { value: { isCopied: true } } })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'copy-exception-0' })
    expect(copied).toBe('')
    await ui.input({ key: 'exception-reason', text: 'Quoted customer wording' })
    await ui.press({ key: 'copy-exception-0' })
    expect(copied).toBe('<!-- plain-english-disable-next-line furthermore: Quoted customer wording -->')
    await ui.unmount()
  })

  test('keeping once permits only the identical advisory write and consumes approval', async ($, on) => {
    project(on)
    dialog(on, () => undefined)
    const call = { tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' }
    await $.tool.call(call)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'keep-once' })
    expect((await $.tool.call({ ...call, agentId: 'helper' })).deny).toContain('Furthermore')
    expect((await $.tool.call({ ...call, content: 'Furthermore, changed.' })).deny).toContain('Furthermore')
    expect((await $.tool.call(call)).result).toBe('written')
    expect((await $.tool.call(call)).deny).toContain('Furthermore')
    await ui.unmount()
  })

  test('review opens a pane containing the current quoted findings', async ($, on) => {
    project(on)
    on('tool.call', () => ({ deny: 'no one to ask' }))
    let opened = ''
    on('ui.open', ($, e) => { opened = e.id; return { value: { isPlaced: true } } })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, we leverage the cache.' })
    await $.command.run({ command: 'plain-english', args: 'review' })
    expect(opened).toBe('plain-english-review')
    const shown = JSON.stringify(await $.ui.render({ component: 'Pane', requestId: opened, surface: 'terminal', props: {} }))
    expect(shown).toContain('2 findings')
    expect(shown).toContain('Furthermore')
    expect(shown).toContain('Keep this write once')
  })

  test('repair mode gives one rewrite attempt, then asks on repeat', async ($, on) => {
    project(on)
    const asked = dialog(on, () => 'Save it as it is')
    await $.command.run({ command: 'plain-english', args: 'repair on' })
    const call = { tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' }
    expect((await $.tool.call(call)).deny).toContain('Rewrite attempt 1 of 1')
    expect(asked).toHaveLength(0)
    expect((await $.tool.call({ ...call, content: 'Furthermore, the build is slower.' })).deny).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect((await $.tool.call({ ...call, content: 'Furthermore, a later write.' })).deny).toContain('Rewrite attempt 1 of 1')
    expect(asked).toHaveLength(1)
  })

  test('/plain-english lints the working tree and answers the findings', async ($, on) => {
    project(on, { 'docs/a.md': 'Furthermore, the build is slow.\n', 'docs/b.md': 'Clear words.\n', 'node_modules/x/c.md': 'Furthermore.\n' })
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const { text } = await $.command.run({
      command: 'plain-english', args: 'docs',
      origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
    })
    expect(text).toContain('docs/a.md')
    expect(text).toContain('"Furthermore"')
    expect(text).not.toContain('docs/b.md')
    expect(text).toContain('across 2 files')
  })

  test('manual paths preserve quoted spaces and flag-looking filenames', async ($, on) => {
    project(on, { 'docs/Release notes.md': 'Furthermore, the build is slow.\n', '-draft.md': 'We leverage the cache.\n' })
    const { text } = await $.command.run({ command: 'plain-english', args: '"docs/Release notes.md" \'-draft.md\'' })
    expect(text).toContain('docs/Release notes.md')
    expect(text).toContain('-draft.md')
    expect(text).toContain('"leverage"')
  })

  test('a manual check of a missing path says so', async ($, on) => {
    project(on)
    const { text } = await $.command.run({ command: 'plain-english', args: 'missing.md' })
    expect(text).toContain('no such path: missing.md')
  })

  // Claude Code 2.1.294 prints a command's text after the plugin's name, so
  // text that starts with the name reads "plain-english: plain-english: ...".
  test('command answers leave the plugin name to the engine', async ($, on) => {
    project(on, { 'docs/a.md': 'Clear words.\n' })
    for (const args of ['status', 'repair on', 'repair off', 'docs']) {
      const answer = await $.command.run({ command: 'plain-english', args })
      expect(answer.text, args).not.toMatch(/^plain-english:/)
    }
  })

  test('readPassages reads the quoted lines and nothing else', async () => {
    const reason = [
      'This file contains writing that reads as machine-generated:',
      '',
      '  line 3: "Furthermore" (furthermore) Start the sentence with its own point.',
      '  line 3: "leverage" (leverage) Use \'use\'.',
      '',
      'Rewrite the quoted text in plain, direct language.',
    ].join('\n')
    expect(readPassages(reason)).toEqual([
      { line: 3, match: 'Furthermore', ruleId: 'furthermore', hint: 'Start the sentence with its own point.' },
      { line: 3, match: 'leverage', ruleId: 'leverage', hint: "Use 'use'." },
    ])
    expect(readPassages('plain-english refused this write.')).toEqual([])
  })

  test('approval saves nothing when Claude Code works in another folder', async ($, on) => {
    const { writes } = project(on)
    const asked = dialog(on, question => question.includes('project-wide') ? 'Approve for this project' : undefined)
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'Furthermore, the build is slow.' })
    asked.length = 0
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'exception-reason', text: 'Team vocabulary' })
    await ui.press({ key: 'approve-term-0' })
    expect(asked).toHaveLength(1)
    expect(writes).toEqual([])
    expect(await ui.find({ type: 'Text', text: /different folder/ })).toBeDefined()
    await ui.unmount()
  })
})
