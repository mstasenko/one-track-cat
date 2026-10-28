import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { ffmpegPath } from './binaries'
import { restrictedIntelRenderNode } from './intel-device'
import { optionalPackDirectory } from './optional-pack'

export function voicePackDirectory(): string {
  return optionalPackDirectory('voice')
}

export async function requireVoicePack(): Promise<string> {
  const directory = voicePackDirectory()
  try {
    await Promise.all(['runtime/bin/python', 'narration_worker.py', 'narration_separator.py', 'narration_voice.py', 'narration_vad.py', 'voxcpm2_tts_helper.py'].map((name) =>
      access(join(directory, name), name === 'runtime/bin/python' ? constants.X_OK : constants.R_OK)))
    return directory
  } catch {
    throw new Error('Re-voice requires the optional voice pack. Install voice-pack beside OneTrackCat (dist/voice-pack in development).')
  }
}

export interface NarrationWorkerProgress { stage: string; fraction: number }

/** One process holds authorization, but releases each model before the next stage. */
export class NarrationWorker {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined
  private diagnostic = ''
  private cancelled = false
  private hardware = 'CPU'
  private ready: Promise<void> = Promise.resolve()
  private finished: Promise<void> = Promise.resolve()

  constructor(private readonly onProgress: (value: NarrationWorkerProgress) => void) {}

  async start(pack: string, cpuFallback = false, models = pack): Promise<void> {
    const args = ['-B', join(pack, 'narration_worker.py'), '--pack', pack, '--models', models, '--ffmpeg', ffmpegPath(),
      '--uid', String(process.getuid?.() ?? 0), '--gid', String(process.getgid?.() ?? 0)]
    if (process.env.otc_CPU_ONLY === '1' || cpuFallback) args.push('--cpu')
    const elevated = cpuFallback ? undefined : await restrictedIntelRenderNode()
    this.checkCancellation()
    const python = join(pack, 'runtime', 'bin', 'python')
    const child = spawn(elevated ? '/usr/bin/pkexec' : python,
      elevated ? ['--disable-internal-agent', python, ...args] : args,
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    this.child = child
    this.finished = new Promise((resolve) => { child.once('close', () => resolve()) })
    this.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        if (line.length > 4_000_000) {
          const error = new Error('Narration response is too large')
          reject(error); this.fail(error); child.stdin.end(); return
        }
        try {
          const value = JSON.parse(line) as { ready?: boolean; hardware?: string; progress?: NarrationWorkerProgress; result?: unknown; error?: string }
          if (value.ready) { this.hardware = value.hardware === 'dGPU' ? 'dGPU' : 'CPU'; resolve() }
          else if (value.progress) this.onProgress({ ...value.progress, stage: `${value.progress.stage} using ${this.hardware}` })
          else if (value.error) this.fail(new Error(value.error))
          else if ('result' in value) { this.pending?.resolve(value.result); this.pending = undefined }
        } catch {
          const error = new Error('Invalid narration worker response')
          reject(error); this.fail(error); child.stdin.end()
        }
      })
      child.stderr.on('data', (chunk: Buffer) => { this.diagnostic = (this.diagnostic + chunk.toString()).slice(-8192) })
      child.stdin.on('error', (error) => { reject(error); this.fail(error) })
      child.once('error', (error) => { reject(error); this.fail(error) })
      child.once('close', (code) => {
        const error = new Error(this.cancelled ? 'Narration cancelled' : `Narration worker exited (${code}): ${this.diagnostic}`)
        reject(error)
        this.fail(error)
      })
    })
    try { await this.ready } catch (error) {
      await this.finished
      if (!elevated || this.cancelled || ![126, 127].includes(child.exitCode ?? -1)) throw error
      this.onProgress({ stage: 'GPU authorization unavailable; continuing using CPU', fraction: 0 })
      await this.start(pack, true, models)
    }
  }

  async request(value: Record<string, unknown>): Promise<unknown> {
    await this.ready
    this.checkCancellation()
    if (this.pending) throw new Error('Narration worker is busy')
    const child = this.child
    if (child?.exitCode !== null) throw new Error('Narration worker is not running')
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => { if (error) this.fail(error) })
    })
  }

  private fail(error: Error): void { this.pending?.reject(error); this.pending = undefined }
  private checkCancellation(): void { if (this.cancelled) throw new Error('Narration cancelled') }

  close(cancelled = false): void {
    this.cancelled ||= cancelled
    // EOF is cooperative: the current finite inference finishes, then exits.
    // Never signal a pkexec wrapper and orphan its privileged compute child.
    this.child?.stdin.end()
    if (cancelled) this.fail(new Error('Narration cancelled; releasing the current model'))
  }

  async stopped(): Promise<void> { await this.finished }
}
