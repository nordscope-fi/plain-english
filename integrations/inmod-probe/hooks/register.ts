import type { Register } from 'claude-code'
import { check } from './core/entry.mjs'

/**
 * Directory probe: the shape of an in-mod checker, with no program started.
 * It runs the real plain-english core (rules and Markdown parsing) on proposed
 * writes and finished replies, reads the reply transcript Claude Code names,
 * asks the session's own model, and writes the project config at a fixed
 * path. Never submitted; it exists to see which directory findings this
 * shape raises.
 */
let rules: string | undefined

export const register: Register = (on) => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    rules ??= await $.fs.read(`${$.plugin.root}/rules/default.yml`)
    const content = typeof e['content'] === 'string' ? e['content'] : ''
    const cwd = await $.session.cwd()
    const found = check(rules, content)
    if (found.length === 0) return next(e)
    const reply = await $.model.complete({ model: 'haiku', prompt: `Is this filler? Answer yes or no.\n\n${content}`, timeoutMs: 20_000 })
    if (reply.isAnswered && /yes/i.test(reply.text) && content.includes('APPROVE-PROBE')) {
      const existing = (await $.fs.exists('.plain-english.yml')) ? await $.fs.read('.plain-english.yml') : 'version: 1\n'
      await $.fs.write('.plain-english.yml', `${existing}# approved in ${cwd}\n`)
    }
    return { deny: `Found: ${found.join(', ')}` }
  })

  on('classic.Stop', async ($, e, next) => {
    rules ??= await $.fs.read(`${$.plugin.root}/rules/default.yml`)
    const path = typeof e['transcript_path'] === 'string' ? e['transcript_path'] : undefined
    const transcript = path ? await $.fs.read(path) : ''
    const last = transcript.trim().split('\n').at(-1) ?? ''
    const found = check(rules, last)
    return found.length ? { decision: 'block', reason: `Rewrite: ${found.join(', ')}` } : next(e)
  })
}
