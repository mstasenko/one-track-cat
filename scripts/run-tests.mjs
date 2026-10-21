import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

function forwardLines(input, target, onLine) {
  if (!input) return Promise.resolve()
  // Reporters may split text and its newline across writes; capture one whole row.
  const reader = createInterface({ input, crlfDelay: Infinity })
  reader.on('line', (line) => {
    onLine?.(line)
    target.write(`${line}\n`)
  })
  return new Promise((resolve) => reader.once('close', resolve))
}

export async function run(command, args, total = false) {
  const counts = [0, 0, 0]
  const collect = total ? (line) => {
    // Only our complete suite footer is countable, never individual result rows.
    const match = /^Results: (\d+) passed, (\d+) failed, (\d+) skipped$/.exec(line)
    if (match) counts.forEach((_, index) => { counts[index] += Number(match[index + 1]) })
  } : undefined
  const environment = { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1', PLAYWRIGHT_FORCE_TTY: '0' }
  delete environment.NO_COLOR
  if (environment.FORCE_COLOR === '0') environment.NO_COLOR = '1'
  const child = spawn(command, args, { env: environment, stdio: ['inherit', 'pipe', 'pipe'] })
  const output = forwardLines(child.stdout, process.stdout, collect)
  const errors = forwardLines(child.stderr, process.stderr, collect)
  const signals = ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => child.kill(signal)])
  signals.forEach(([signal, handler]) => process.on(signal, handler))
  const status = await new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`${error.message}\n`)
      resolve(1)
    })
    child.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
  signals.forEach(([signal, handler]) => process.removeListener(signal, handler))
  await Promise.all([output, errors])
  if (total) {
    const [passed, failed, skipped] = counts
    process.stdout.write(`Grand total: ${passed + failed} run, ${passed} passed, ${failed} failed, ${skipped} skipped\n`)
    if (status !== 0) process.stderr.write('Test command failed; totals include completed suites only.\n')
  }
  return status
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arguments_ = process.argv.slice(2)
  const total = arguments_[0] === '--total'
  if (total) arguments_.shift()
  const [command, ...args] = arguments_
  if (!command) throw new Error('Usage: node scripts/run-tests.mjs [--total] <command> [arguments...]')
  process.exitCode = await run(command, args, total)
}
