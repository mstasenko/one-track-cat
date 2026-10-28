import { spawn } from 'node:child_process'
import type { UpscaleMode } from '../types'
import { progressMetrics, type ModelDownloadProgress } from './model-download'

export type UpscalePackWorker = (executable: string, args: string[], signal: AbortSignal,
  onProgress?: (progress: ModelDownloadProgress) => void) => Promise<void>

const defaultFlashMode: UpscaleMode = 'turbo'

function isFlashMode(value: unknown): value is UpscaleMode {
  return value === 'turbo' || value === 'base'
}

export function normalizeFlashMode(value: unknown): UpscaleMode {
  if (value === undefined) return defaultFlashMode
  if (!isFlashMode(value)) throw new Error('FlashVSR+ mode must be turbo or base')
  return value
}

export function cancelled(): Error {
  const error = new Error('AI model preparation cancelled')
  error.name = 'AbortError'
  return error
}

// AbortSignal changes while awaiting IO. A fresh read behind this function
// prevents TypeScript from retaining a stale `aborted === false` narrowing.
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

export const runPackWorker: UpscalePackWorker = (executable, args, signal, onProgress) => new Promise((resolve, reject) => {
  if (isAborted(signal)) { reject(cancelled()); return }
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  let pending = ''
  let diagnostic = ''
  let failure: Error | undefined
  let progressPhase: unknown
  let progressTotal = 0
  let progressDone = 0
  let progressInitial = 0
  let progressStarted = process.hrtime.bigint()
  const stop = (): void => { child.kill('SIGTERM') }
  const fail = (error: Error): void => { failure ??= error; stop() }
  const line = (value: string): void => {
    if (!value.startsWith('{')) { diagnostic = (diagnostic + value + '\n').slice(-8192); return }
    try {
      const event = JSON.parse(value) as Record<string, unknown>
      if ((event.phase !== 'preparing' && event.phase !== 'verifying') ||
          typeof event.name !== 'string' || !/^[A-Za-z0-9_.-]{1,192}$/u.test(event.name) ||
          typeof event.done !== 'number' || !Number.isSafeInteger(event.done) || event.done < 0 ||
          typeof event.total !== 'number' || !Number.isSafeInteger(event.total) || event.total <= 0 ||
          event.total > 32 * 1024 ** 3 || event.done > event.total) throw new Error('Invalid native model progress')
      if (event.phase !== progressPhase || event.total !== progressTotal || event.done < progressDone) {
        progressStarted = process.hrtime.bigint()
        progressInitial = event.done
      }
      progressPhase = event.phase
      progressTotal = event.total
      progressDone = event.done
      onProgress?.({
        phase: event.phase, name: event.name,
        ...progressMetrics(event.done, event.total, progressStarted, event.done - progressInitial)
      })
    } catch (error) { fail(error instanceof Error ? error : new Error('Invalid native model progress')) }
  }
  child.stdout.on('data', (data: Buffer) => {
    if (data.length) fail(new Error('Unexpected native preparation stdout'))
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (data: string) => {
    pending += data
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      if (newline > 16384) { fail(new Error('Native model progress exceeded its bound')); pending = ''; return }
      line(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
    }
    if (pending.length > 16384) { fail(new Error('Native model progress exceeded its bound')); pending = '' }
  })
  child.once('error', (error) => { failure ??= error })
  child.once('close', (code, killedBy) => {
    signal.removeEventListener('abort', stop)
    if (pending) line(pending)
    if (isAborted(signal)) reject(cancelled())
    else if (failure) reject(failure)
    else if (code !== 0 || killedBy) reject(new Error(diagnostic.trim() || 'Native model preparation failed'))
    else resolve()
  })
  signal.addEventListener('abort', stop, { once: true })
  if (isAborted(signal)) stop()
})
