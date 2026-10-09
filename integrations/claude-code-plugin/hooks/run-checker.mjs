// Host cancellation must reach the CLI and its synchronous model subprocess.
//
// The mod starts this wrapper as `node hooks/run-checker.mjs <command...>` from
// the plugin folder. The command and its settings are fixed text, so the
// Claude directory can read each one in full. Everything that varies arrives
// as one JSON request on standard input: `cwd`, the project folder; `paths`,
// the paths the person typed; `route: "host"` when the mod answers model
// questions itself; and `input`, what the CLI reads on its own standard input.
// The wrapper finds the CLI beside itself and runs it with that request.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.mjs')

function fail(message) {
  process.stderr.write(`plain-english: ${message}\n`)
  process.exit(2)
}

let request = {}
try {
  const raw = process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
  request = raw.trim() === '' ? {} : JSON.parse(raw)
} catch {
  fail('the checker request is not readable JSON.')
}
if (request === null || typeof request !== 'object' || Array.isArray(request)) fail('the checker request must be an object.')
const { cwd, paths = [], route, input = '' } = request
if (cwd !== undefined && typeof cwd !== 'string') fail('the checker request has an invalid project folder.')
if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) fail('the checker request has an invalid list of paths.')
if (route !== undefined && route !== 'host') fail('the checker request has an unknown model route.')
if (typeof input !== 'string') fail('the checker request has an invalid input.')

const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
const timeoutMs = Number(process.env.PLAIN_ENGLISH_CHECK_TIMEOUT_MS)
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) fail('invalid checker timeout.')
const child = spawn(process.execPath, [cli, ...process.argv.slice(2), ...paths], {
  cwd: cwd || process.cwd(),
  env: {
    ...process.env,
    ...(cwd ? { CLAUDE_PROJECT_DIR: cwd } : {}),
    ...(route === 'host' ? { PLAIN_ENGLISH_MODEL_ROUTE: 'host' } : {}),
  },
  stdio: ['pipe', 'inherit', 'inherit'],
  detached: process.platform !== 'win32',
})
child.stdin.on('error', () => {})
child.stdin.end(input)

function terminate(signal) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function removeHandlers() {
  clearTimeout(deadline)
  for (const signal of signals) process.removeListener(signal, handlers[signal])
}

const handlers = Object.fromEntries(signals.map(signal => [signal, () => {
  terminate(signal)
  removeHandlers()
  if (process.platform === 'win32') process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal])
  else process.kill(process.pid, signal)
}]))
for (const signal of signals) process.once(signal, handlers[signal])
const deadline = setTimeout(() => {
  terminate('SIGTERM')
  removeHandlers()
  process.stderr.write(`plain-english: checker timed out after ${timeoutMs}ms.\n`)
  process.exit(2)
}, timeoutMs)

child.once('error', error => {
  removeHandlers()
  process.stderr.write(`plain-english: checker could not start. ${error.message}\n`)
  process.exit(2)
})
child.once('exit', (code, signal) => {
  removeHandlers()
  // No descendant is meant to outlive this check, even after an early CLI exit.
  terminate('SIGTERM')
  process.exit(code ?? (128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 1)))
})
