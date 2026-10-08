// Host cancellation must reach the CLI and its synchronous model subprocess.
import { spawn, spawnSync } from 'node:child_process'

const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
const timeoutMs = Number(process.env.PLAIN_ENGLISH_CHECK_TIMEOUT_MS)
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
  process.stderr.write('plain-english: invalid checker timeout.\n')
  process.exit(2)
}
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
})

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
