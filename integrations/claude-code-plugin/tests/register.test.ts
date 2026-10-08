import { describe, expect, test, tier } from 'claude-code/testing'

import { readPassages } from '../hooks/wire'

tier('user')

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

describe('register', () => {
  test('a Markdown write the adapter refuses is denied with its reason', async ($, on) => {
    const argv: string[][] = []
    const stdin: string[] = []
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', ($, e) => {
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
    expect(argv[0]?.slice(2)).toEqual(['hook', 'docs', '--agent', 'claude-code'])
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
    on('process.run', () => {
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
    on('process.run', () => {
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
    on('process.run', () => ({ value: { ...RUN, stdout } }))
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
    on('process.run', ($, e) => {
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
  })

  test('a reply the adapter passes goes on to the settings hooks', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', () => ({ value: { ...RUN, stdout: '' } }))
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
    on('process.run', () => ({ value: { ...RUN, stdout: ASK } }))
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
    on('process.run', () => ({ value: { ...RUN, stdout: ASK } }))
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
    on('process.run', () => ({ value: { ...RUN, stdout: ASK } }))
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') return { deny: 'no one to ask' }
      return { result: 'written' }
    })

    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/a.md', content: 'x' })

    expect(result.deny).toContain('Furthermore')
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
    on('process.run', () => {
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
    on('process.run', ($, e) => {
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
