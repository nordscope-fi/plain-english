import type { Register } from 'claude-code'

/**
 * Directory probe: the shape of an in-mod checker, with no program started.
 * It reads the conversation (tool.call), the session folder and one project
 * file, and asks the session's own model. Never submitted; it exists to see
 * which of the directory's mod findings this shape raises.
 */
const BANNED = /\b(furthermore|moreover|seamless)\b/i

export const register: Register = (on) => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const content = typeof e['content'] === 'string' ? e['content'] : ''
    const cwd = await $.session.cwd()
    const config = (await $.fs.exists('.plain-english.yml')) ? await $.fs.read('.plain-english.yml') : ''
    const strict = /failOn:\s*error/.test(config)
    const found = BANNED.exec(content)
    if (!found) return next(e)
    const reply = await $.model.complete({ model: 'haiku', prompt: `Is "${found[0]}" filler in this text? Answer yes or no.\n\n${content}`, timeoutMs: 20_000 })
    const filler = reply.isAnswered && /yes/i.test(reply.text)
    if (strict && filler) return { deny: `Rewrite without "${found[0]}" (checked in ${cwd}).` }
    return next(e)
  })
}
