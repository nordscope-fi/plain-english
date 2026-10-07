import { describe, expect, test, tier } from 'claude-code/testing'

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
