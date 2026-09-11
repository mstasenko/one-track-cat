import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { BrowserWindow } from 'electron'
import type { HardwareLabel, JobPhase, JobProgress } from '../types'
import { estimateEtaSeconds, ffmpegProgress } from './progress'

export interface FaceCommand {
  executable: string
  args: string[]
  elevated?: boolean
  /** Keep native/GPU contexts on cooperative EOF instead of signalling them. */
  gpuWorker?: boolean
}

export class FaceAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FaceAuthorizationError'
  }
}

export interface FacePipelineOptions {
  label?: string
  message?: string
  authorizationMessage?: string
  hardwareLabel?: HardwareLabel
  encodingHardwareLabel?: HardwareLabel
  phase?: JobPhase
  onWorkerStderr?: (stream: Readable) => Promise<void>
  preparationStart?: number
  preparationEnd?: number
}

export type FacePipelineCommands =
  | [FaceCommand, FaceCommand, FaceCommand]
  | [FaceCommand, FaceCommand, FaceCommand, FaceCommand]

const active = new Map<string, () => void>()
const pending = new Map<string, Promise<void>>()
let shutdownRequested = false
const workerStartupMarker = 'otc-face-blur: starting'
const workerDeviceMarker = 'otc-face-blur: device='
const workerCacheMarker = 'otc-face-blur: mode=cached'
const workerInferenceMarker = 'otc-face-blur: mode=inference'
const workerStatusLineLimit = 4096
const preparationMarker = 'showinfo@otc_prepare'
const elevatedPreparationMessage = 'Preparing video; authorize GPU access if prompted…'
const videoPreparationMessage = 'Preparing video frames…'
const faceDetectionMessage = 'Masking faces…'
const cachedFaceMessage = 'Applying cached face analysis'

function phaseForLabel(label: string): JobPhase {
  return label.toLowerCase().includes('encod') ? 'encoding' : 'masking'
}

function workerHardwareLabel(line: string): HardwareLabel | undefined {
  const explicit = /\bhardware=(CPU|iGPU|dGPU)(?:\s|$)/.exec(line)?.[1]
  if (explicit === 'CPU' || explicit === 'iGPU' || explicit === 'dGPU') return explicit
  return /\bdevice=CPU(?:\s|$)/.test(line) ? 'CPU' : undefined
}

function faceAnalysisMessage(hardware: HardwareLabel | undefined): string {
  return hardware
    ? `Detecting faces using ${hardware}`
    : 'Detecting faces'
}

function report(progress: JobProgress): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('job:progress', progress)
}

function appendStderrDetail(detail: string, chunk: string): string {
  return `${detail}${chunk}`.split(/\r?\n/).filter((line) =>
    !line.startsWith('RCFACE1 ') && line !== workerStartupMarker && !line.startsWith(workerDeviceMarker)
      && !line.startsWith(workerCacheMarker) && !line.startsWith(workerInferenceMarker)
  ).join('\n').slice(-8000)
}

export function cancelFaceExport(id: string): boolean {
  const cancel = active.get(id)
  if (!cancel) return false
  cancel()
  return true
}

/** Cancels every face pipeline and waits for cooperative GPU/CPU teardown. */
export async function shutdownFaceExports(): Promise<void> {
  shutdownRequested = true
  for (const cancel of active.values()) cancel()
  await Promise.allSettled(pending.values())
}

function requiredChild(children: ChildProcessWithoutNullStreams[], index: number): ChildProcessWithoutNullStreams {
  const child = children[index]
  if (!child) throw new Error('Face processing pipeline child is missing')
  return child
}

/** Pipes exert backpressure: even a long 4K export keeps only a few frames in flight. */
export async function runFacePipeline(
  commands: FacePipelineCommands,
  id: string,
  duration: number,
  options: FacePipelineOptions = {}
): Promise<void> {
  if (shutdownRequested) throw new Error('Job cancelled')
  const label = options.label ?? 'Masking faces'
  const prefix = options.message ? `${options.message} ` : ''
  const encodingContext = options.phase === 'encoding' || options.encodingHardwareLabel !== undefined
  const encodingProcessingLabel = encodingContext
    ? options.encodingHardwareLabel ? `Encoding video using ${options.encodingHardwareLabel}`
      : label === 'Masking faces' ? 'Encoding video' : label
    : undefined
  const hasElevated = commands.some((command) => command.elevated === true)
  const initialMessage = options.message ?? (hasElevated
    ? elevatedPreparationMessage
    : encodingProcessingLabel ?? (label === 'Masking faces' ? faceDetectionMessage : `${label}…`))
  const defaultPhase = options.phase ?? (encodingContext ? 'encoding' : phaseForLabel(label))
  const processingPhase = encodingContext ? 'encoding' : 'masking'
  const initialPhase = hasElevated ? 'preparing' : defaultPhase
  const pipelineStartedAt = Date.now()
  const pipeline = new Promise<void>((resolve, reject) => {
    const children: (ChildProcessWithoutNullStreams | undefined)[] = []
    let failure: Error | undefined
    let remaining = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopping = false
    let settled = false
    let cancelled = false
    let stderrCapture: Promise<void> | undefined
    let finishStarted = false
    let statusCarry = ''
    let discardStatusLine = false
    let reportedVideoPreparation = false
    let lastAnalysisStatus: 'cached' | 'detected' | undefined
    let inferenceHardwareLabel = options.hardwareLabel
    let latestEncodedProgress = 0
    let maskingStarted = false
    let preparationCarry = ''
    let discardPreparationLine = false
    let lastPreparationPts: number | undefined
    let lastPreparationProgress = 0
    let reportedPreparationProgress = false
    let hardwareLabel = options.hardwareLabel
    let encodingHardwareLabel = options.encodingHardwareLabel
    let phase = initialPhase
    let phaseStartedAt = pipelineStartedAt
    let phaseStartProgress = 0
    const preparationStart = Number.isFinite(options.preparationStart) ? options.preparationStart : undefined
    const preparationEnd = Number.isFinite(options.preparationEnd) ? options.preparationEnd : undefined
    const preparationSpan = preparationStart !== undefined && preparationEnd !== undefined
      ? preparationEnd - preparationStart
      : 0
    const preparationEnabled = preparationSpan > 0
    const emit = (progress: JobProgress): void => {
      // An explicit undefined label clears a stale inference label when a later
      // frame is served by the cache. Omitting the property preserves it across
      // ordinary progress updates.
      if (Object.prototype.hasOwnProperty.call(progress, 'hardwareLabel')) {
        hardwareLabel = progress.hardwareLabel
      }
      const nextPhase = progress.phase ?? phase
      if (nextPhase !== phase) {
        phase = nextPhase
        phaseStartedAt = Date.now()
        phaseStartProgress = progress.progress
      }
      const phaseProgress = phaseStartProgress >= 1
        ? 0
        : Math.max(0, Math.min(1, (progress.progress - phaseStartProgress) / (1 - phaseStartProgress)))
      const etaSeconds = progress.state === 'running'
        ? estimateEtaSeconds(phaseProgress, phaseStartedAt)
        : undefined
      const emitted: JobProgress = { ...progress, phase }
      if (hardwareLabel === undefined) delete emitted.hardwareLabel
      else emitted.hardwareLabel = hardwareLabel
      if (Object.prototype.hasOwnProperty.call(progress, 'encodingHardwareLabel')) {
        encodingHardwareLabel = progress.encodingHardwareLabel
      }
      if (encodingHardwareLabel === undefined) delete emitted.encodingHardwareLabel
      else emitted.encodingHardwareLabel = encodingHardwareLabel
      if (etaSeconds === undefined) delete emitted.etaSeconds
      else emitted.etaSeconds = etaSeconds
      report(emitted)
    }
    emit({
      id, kind: 'export', state: 'running', progress: 0,
      message: initialMessage, phase: initialPhase,
      ...(encodingHardwareLabel === undefined ? {} : { encodingHardwareLabel })
    })
    const reportPreparationLine = (line: string): void => {
      if (!preparationEnabled || maskingStarted || settled || cancelled || !line.includes(preparationMarker)) return
      const match = /\bpts_time:\s*([^\s]+)/.exec(line)
      if (!match) return
      const pts = Number(match[1])
      if (!Number.isFinite(pts) || (lastPreparationPts !== undefined && pts - lastPreparationPts < 1)) return
      lastPreparationPts = pts
      if (preparationStart === undefined) return
      const rawProgress = (pts - preparationStart) / preparationSpan
      const progress = Math.max(0, Math.min(1, rawProgress))
      if (reportedPreparationProgress && progress <= lastPreparationProgress) return
      lastPreparationProgress = progress
      reportedPreparationProgress = true
      reportedVideoPreparation = true
      emit({
        id, kind: 'export', state: 'running', progress,
        message: `Preparing video frames: ${Math.round(progress * 100)}%`, phase: 'preparing'
      })
    }
    const observePreparationStderr = (chunk: string): void => {
      if (!preparationEnabled || settled || cancelled) return
      const text = `${preparationCarry}${chunk}`
      let start = 0
      let end = text.indexOf('\n', start)
      while (end >= 0) {
        const line = text.slice(start, end).endsWith('\r') ? text.slice(start, end - 1) : text.slice(start, end)
        if (!discardPreparationLine && line.length <= workerStatusLineLimit) reportPreparationLine(line)
        start = end + 1
        discardPreparationLine = false
        end = text.indexOf('\n', start)
      }
      const remainder = text.slice(start)
      if (discardPreparationLine) preparationCarry = ''
      else if (remainder.length > workerStatusLineLimit) {
        preparationCarry = ''
        discardPreparationLine = true
      } else preparationCarry = remainder
    }
    const flushPreparationStderr = (): void => {
      if (!discardPreparationLine && preparationCarry) reportPreparationLine(preparationCarry.replace(/\r$/, ''))
      preparationCarry = ''
      discardPreparationLine = false
    }
    const observeWorkerStderr = (chunk: string, currentDetail: string, isWorker: boolean): string => {
      const nextDetail = appendStderrDetail(currentDetail, chunk)
      if (!isWorker || settled || cancelled) return nextDetail
      const text = `${statusCarry}${chunk}`
      let start = 0
      let end = text.indexOf('\n', start)
      while (end >= 0) {
        const line = text.slice(start, end).endsWith('\r') ? text.slice(start, end - 1) : text.slice(start, end)
        if (!discardStatusLine && line.length <= workerStatusLineLimit) {
          if (line === workerStartupMarker && commands[1].elevated && !reportedVideoPreparation && !maskingStarted) {
            reportedVideoPreparation = true
            // Do not include time spent waiting for the authorization agent in
            // the preparation-stage estimate.
            phaseStartedAt = Date.now()
            phaseStartProgress = latestEncodedProgress
            emit({ id, kind: 'export', state: 'running', progress: latestEncodedProgress, message: videoPreparationMessage, phase: 'preparing' })
          } else if (line.startsWith(workerCacheMarker) && (!commands[1].elevated || reportedVideoPreparation) && lastAnalysisStatus !== 'cached') {
            lastAnalysisStatus = 'cached'
            emit({
              id, kind: 'export', state: 'running', progress: latestEncodedProgress,
              message: encodingProcessingLabel ?? cachedFaceMessage, phase: processingPhase, hardwareLabel: undefined
            })
          } else if ((line.startsWith(workerDeviceMarker) || line.startsWith(workerInferenceMarker)) && (!commands[1].elevated || reportedVideoPreparation) && lastAnalysisStatus !== 'detected') {
            const detectedHardware = workerHardwareLabel(line)
            if (detectedHardware) inferenceHardwareLabel = detectedHardware
            hardwareLabel = inferenceHardwareLabel
            lastAnalysisStatus = 'detected'
            emit({
              id, kind: 'export', state: 'running', progress: latestEncodedProgress,
              message: encodingProcessingLabel ?? faceAnalysisMessage(inferenceHardwareLabel), phase: processingPhase, hardwareLabel
            })
          }
        }
        start = end + 1
        discardStatusLine = false
        end = text.indexOf('\n', start)
      }
      const remainder = text.slice(start)
      if (discardStatusLine) statusCarry = ''
      else if (remainder.length > workerStatusLineLimit) {
        statusCarry = ''
        discardStatusLine = true
      } else statusCarry = remainder
      return nextDetail
    }
    const finish = (): void => {
      if (remaining > 0 || settled || finishStarted) return
      finishStarted = true
      void (stderrCapture ?? Promise.resolve()).then(() => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        active.delete(id)
        if (failure) {
          const authorizationMessage = !cancelled && failure instanceof FaceAuthorizationError ? options.authorizationMessage : undefined
          const authorizationPendingRetry = authorizationMessage !== undefined
          emit({
            id, kind: 'export', state: cancelled || authorizationPendingRetry ? cancelled ? 'cancelled' : 'running' : 'failed', progress: 0,
            message: cancelled ? failure.message : authorizationMessage ?? failure.message
          })
          reject(failure)
        } else {
          emit({ id, kind: 'export', state: 'running', progress: 0.99, message: `${prefix}Finalizing audio…`, phase: 'finalizing' })
          resolve()
        }
      })
    }
    const stop = (): void => {
      if (stopping || settled) return
      stopping = true
      for (let index = 0; index < children.length - 1; index += 1) {
        const source = children[index]
        const destination = children[index + 1]
        if (source && destination) source.stdout.unpipe(destination.stdin)
      }
      // Elevated GPU processes must see EOF and drain their stdout so they can
      // release the device context normally. Only ordinary CPU children get
      // signal escalation; signalling a pkexec child can orphan its root
      // descendant and leave the render node occupied.
      for (const [index, child] of children.entries()) {
        if (!child || child.exitCode !== null) continue
        if (index === 1 || commands[index]?.elevated || commands[index]?.gpuWorker) {
          child.stdin.end()
          child.stdout.resume()
        } else {
          child.kill('SIGINT')
        }
      }
      timer ??= setTimeout(() => {
        for (const [index, child] of children.entries()) {
          if (child && child.exitCode === null && index !== 1 && !commands[index]?.elevated && !commands[index]?.gpuWorker) {
            child.kill('SIGKILL')
          }
        }
      }, 3000)
      timer.unref()
    }
    const fail = (error: Error): void => {
      if (settled) return
      if (error instanceof FaceAuthorizationError && !cancelled) failure = error
      else failure ??= error
      stop()
    }
    active.set(id, () => {
      if (settled) return
      cancelled = true
      failure = new Error('Job cancelled')
      stop()
    })
    for (const [index, command] of commands.entries()) {
      if (failure) break
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(command.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        fail(authorizationError(command, failure) ?? failure)
        break
      }
      children[index] = child
      remaining += 1
      let detail = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (index === 0) observePreparationStderr(chunk)
        detail = observeWorkerStderr(chunk, detail, index === 1)
      })
      if (index === 0) child.stderr.once('end', flushPreparationStderr)
      if (index === 1 && options.onWorkerStderr) {
        stderrCapture = Promise.resolve()
          .then(() => {
            const capture = options.onWorkerStderr?.(child.stderr)
            return capture
          })
          .then(() => undefined)
          .catch(() => {
            child.stderr.on('error', () => undefined)
            child.stderr.resume()
          })
      }
      child.once('error', (error) => fail(authorizationError(command, error) ?? error))
      // A downstream error closes its input; the child exit remains the authoritative failure.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') fail(authorizationError(command, error) ?? error)
      })
      child.once('close', (code) => {
        if (index === 0) flushPreparationStderr()
        if (code !== 0) {
          fail(authorizationError(command, code) ?? new Error(detail.trim() || 'Face processing stopped unexpectedly'))
        }
        remaining -= 1
        finish()
      })
    }
    if (children.some((child) => child === undefined) || failure) {
      finish()
      return
    }
    const connectedChildren = children as ChildProcessWithoutNullStreams[]
    const decoder = requiredChild(connectedChildren, 0)
    decoder.stdin.end()
    for (let index = 0; index < connectedChildren.length - 1; index += 1) {
      requiredChild(connectedChildren, index).stdout.pipe(requiredChild(connectedChildren, index + 1).stdin)
    }
    let progressBuffer = ''
    const progressChild = requiredChild(connectedChildren, connectedChildren.length - 1)
    progressChild.stdout.setEncoding('utf8')
    progressChild.stdout.on('data', (chunk: string) => {
      const lines = `${progressBuffer}${chunk}`.split(/\r?\n/)
      progressBuffer = (lines.pop() ?? '').slice(-1000)
      for (const line of lines) {
        const progress = ffmpegProgress(line, duration)
        if (progress !== null) {
          latestEncodedProgress = progress
          maskingStarted = true
          // Encoding-context callers provide the final encoder label. Detection
          // hardware remains diagnostic and must not replace that label.
          const processingLabel = encodingProcessingLabel
            ?? (lastAnalysisStatus === 'cached' ? cachedFaceMessage
              : lastAnalysisStatus === 'detected' ? faceAnalysisMessage(inferenceHardwareLabel) : label)
          emit({ id, kind: 'export', state: 'running', progress, message: `${prefix}${processingLabel}: ${Math.round(progress * 100)}%`, phase: defaultPhase })
        }
      }
    })
    finish()
  })
  pending.set(id, pipeline)
  return pipeline.finally(() => pending.delete(id))
}

function authorizationError(command: FaceCommand, status: number | string | Error | null): FaceAuthorizationError | undefined {
  if (!command.elevated) return undefined
  if (status === 126 || status === 127 || (status instanceof Error && (status as NodeJS.ErrnoException).code === 'ENOENT')) {
    return new FaceAuthorizationError('GPU worker authorization was denied, cancelled, or unavailable')
  }
  return undefined
}
