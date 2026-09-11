import type { ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { Readable } from 'node:stream'
import type { HardwareLabel, JobKind, JobPhase, JobProgress } from '../types'
import { estimateEtaSeconds, ffmpegProgress } from './progress'

interface ActiveJob {
  child: ChildProcessByStdio<null, Readable, Readable>
  cancelled: boolean
}

interface JobContext {
  id: string
  kind: JobKind
  duration: number
  startedAt: number
  phase: JobPhase
  hardwareLabel?: HardwareLabel
}

export interface JobRunOptions {
  phase?: JobPhase
  hardwareLabel?: HardwareLabel
  /** Continue an already-announced job without resetting its progress UI. */
  announce?: boolean
}

function broadcast(progress: JobProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('job:progress', progress)
  }
}

function prefixedMessage(prefix: string, message: string): string {
  return prefix ? `${prefix}: ${message}` : message
}

function consumeProgress(buffer: string, chunk: string, context: JobContext, messagePrefix: string): string {
  const lines = `${buffer}${chunk}`.split(/\r?\n/)
  const remainder = lines.pop() ?? ''
  for (const line of lines) {
    const progress = ffmpegProgress(line, context.duration)
    if (progress === null) continue
    const etaSeconds = estimateEtaSeconds(progress, context.startedAt)
    broadcast({
      id: context.id,
      kind: context.kind,
      state: 'running',
      progress,
      message: prefixedMessage(messagePrefix, `${Math.round(progress * 100)}%`),
      phase: context.phase,
      ...(context.hardwareLabel === undefined ? {} : { hardwareLabel: context.hardwareLabel }),
      ...(etaSeconds === undefined ? {} : { etaSeconds })
    })
  }
  return remainder
}

function failureDetail(code: number | null, stderr: string): string {
  return stderr.trim().split('\n').slice(-8).join('\n') || `Exited with code ${code}`
}

export class JobManager {
  private readonly active = new Map<string, ActiveJob>()
  private readonly pending = new Set<Promise<void>>()
  private closed = false
  private shutdownPromise: Promise<void> | undefined

  private requestCancellation(job: ActiveJob): void {
    if (job.cancelled) return
    job.cancelled = true
    job.child.kill('SIGINT')
  }

  private scheduleEscalation(id: string, job: ActiveJob): void {
    const timer = setTimeout(() => {
      if (this.active.get(id) === job) job.child.kill('SIGKILL')
    }, 3_000)
    timer.unref()
  }

  cancel(id: string): boolean {
    const job = this.active.get(id)
    if (!job) return false
    this.requestCancellation(job)
    if (this.closed) return true
    this.scheduleEscalation(id, job)
    return true
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    for (const [id, job] of this.active) {
      this.requestCancellation(job)
      this.scheduleEscalation(id, job)
    }
    this.shutdownPromise = Promise.allSettled([...this.pending]).then(() => undefined)
    return this.shutdownPromise
  }

  async run(
    executable: string,
    args: string[],
    kind: JobKind,
    duration: number,
    forcedId?: string,
    messagePrefix = '',
    options: JobRunOptions = {}
  ): Promise<void> {
    if (this.closed) throw new Error('Job manager is shutting down')
    const id = forcedId ?? randomUUID()
    if (options.announce !== false) {
      broadcast({
        id, kind, state: 'queued', progress: 0, message: prefixedMessage(messagePrefix, 'Queued'), phase: 'queued',
        ...(options.hardwareLabel === undefined ? {} : { hardwareLabel: options.hardwareLabel })
      })
    }

    const pending = new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const job: ActiveJob = { child, cancelled: false }
      this.active.set(id, job)
      let stderr = ''
      let stdoutBuffer = ''
      const context = {
        id, kind, duration, startedAt: Date.now(),
        phase: options.phase ?? (kind === 'export' ? 'encoding' : 'preparing'),
        hardwareLabel: options.hardwareLabel
      }
      let failedToStart = false

      if (options.announce !== false) {
        broadcast({
          id, kind, state: 'running', progress: 0, message: prefixedMessage(messagePrefix, 'Starting'), phase: 'starting',
          ...(options.hardwareLabel === undefined ? {} : { hardwareLabel: options.hardwareLabel })
        })
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer = consumeProgress(stdoutBuffer, chunk, context, messagePrefix)
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-64_000)
      })

      child.on('error', (error) => {
        failedToStart = true
        this.active.delete(id)
        broadcast({
          id,
          kind,
          state: 'failed',
          progress: 0,
          message: 'Could not start media processor'
        })
        reject(error)
      })

      child.on('close', (code) => {
        if (failedToStart) return
        this.active.delete(id)
        if (job.cancelled) {
          const error = new Error('Job cancelled')
          broadcast({ id, kind, state: 'cancelled', progress: 0, message: 'Cancelled' })
          reject(error)
          return
        }
        if (code !== 0) {
          const detail = failureDetail(code, stderr)
          broadcast({
            id,
            kind,
            state: 'failed',
            progress: 0,
            message: 'Media processing failed'
          })
          reject(new Error(detail))
          return
        }
        broadcast({
          id, kind, state: 'completed', progress: 1, message: prefixedMessage(messagePrefix, 'Complete'), phase: 'complete',
          ...(options.hardwareLabel === undefined ? {} : { hardwareLabel: options.hardwareLabel })
        })
        resolve()
      })
    })
    this.pending.add(pending)
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending)
    )
    return pending
  }
}

export const jobs = new JobManager()
