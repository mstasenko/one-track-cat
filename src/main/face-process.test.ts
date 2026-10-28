import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
interface MockWindow { webContents: { send: (...args: unknown[]) => void } }
const electronMock = vi.hoisted(() => ({ windows: [] as MockWindow[] }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => electronMock.windows } }))
import { cancelFaceExport, FaceAuthorizationError, hasActiveFaceExports, runFacePipeline, runFacePreparation, shutdownFaceExports, type FaceCommand } from './face-process'

const node = (source: string): FaceCommand => ({ executable: process.execPath, args: ['-e', source] })
const relay = node('process.stdin.pipe(process.stdout)')
const consume = node('process.stdin.resume()')
let directory: string | undefined
afterEach(async () => {
  electronMock.windows = []
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('bounded face process pipeline', () => {
  it('owns first-use preparation, reports progress and cancels before processing starts', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    let finish: (() => void) | undefined
    const task = runFacePreparation('download', async (signal, progress) => {
      progress('Downloading face model: 20%', 0.2, 8)
      await new Promise<void>((resolve) => { finish = resolve })
      signal.throwIfAborted()
    })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(hasActiveFaceExports()).toBe(true)
    expect(send).toHaveBeenCalledWith('job:progress', expect.objectContaining({
      id: 'download', progress: 0.2, etaSeconds: 8, phase: 'preparing'
    }))
    expect(cancelFaceExport('download')).toBe(true)
    finish?.()
    await expect(task).rejects.toThrow('Job cancelled')
    expect(hasActiveFaceExports()).toBe(false)
    await expect(runFacePreparation('download', () => Promise.reject(new Error('Network failed')))).rejects.toThrow('Network failed')
    await expect(runFacePreparation('download', () => Promise.resolve())).resolves.toBeUndefined()
  })
  it('reports lifecycle and frame progress to open windows', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      node('process.stdout.write(Buffer.from("frame"))'), relay,
      node("process.stdin.resume(); process.stdout.write('out_time_us=500000\\n')")
    ], 'report', 1)
    expect(send).toHaveBeenCalledWith('job:progress', expect.objectContaining({ id: 'report', state: 'running' }))
  })

  it.each(['device', 'flash-device', 'rife-device'])('reports the AI worker %s hardware', async (marker) => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      node("process.stdout.write('frame')"),
      node(`process.stderr.write('otc-upscale: ${marker}=GPU.1 hardware=dGPU\\notc-upscale: progress=0.25\\n'); process.stdin.pipe(process.stdout)`),
      consume
    ], `ai-hardware-${marker}`, 1, { phase: 'upscaling' })
    expect(send).toHaveBeenCalledWith('job:progress', expect.objectContaining({
      hardwareLabel: 'dGPU', message: 'Upscaling video using dGPU: 25%'
    }))
  })

  it.each(['device', 'flash-device', 'rife-device'])('keeps the percentage visible across %s updates', async (marker) => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    const statuses = [
      'otc-upscale: progress=0.70',
      `otc-upscale: ${marker}=GPU.1 hardware=dGPU`,
      `otc-upscale: ${marker}=GPU.1 hardware=dGPU`,
      `otc-upscale: ${marker}=CPU hardware=CPU`
    ].join('\n') + '\n'
    await runFacePipeline([
      node("process.stdout.write('frame')"),
      node(`process.stderr.write(${JSON.stringify(statuses)}); process.stdin.pipe(process.stdout)`),
      consume
    ], `ai-steady-percentage-${marker}`, 1, { phase: 'upscaling' })
    const updates = send.mock.calls.map(([, progress]) => progress as { phase?: string; message: string })
      .filter((progress) => progress.phase === 'upscaling')
    expect(updates.slice(1).map((progress) => progress.message)).toEqual([
      'Upscaling video: 70%', 'Upscaling video using dGPU: 70%',
      'Upscaling video using dGPU: 70%', 'Upscaling video using CPU: 70%'
    ])
  })

  it('does not advertise a failed RIFE device and reports its actual CPU fallback', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      node("process.stdout.write('frame')"),
      node("process.stderr.write('otc-upscale: rife-device=GPU.1 failed reason=no room\\notc-upscale: rife-device=CPU hardware=CPU\\notc-upscale: progress=0.25\\n'); process.stdin.pipe(process.stdout)"),
      consume
    ], 'ai-hardware-fallback', 1, { phase: 'upscaling' })
    expect(send).toHaveBeenCalledWith('job:progress', expect.objectContaining({
      hardwareLabel: 'CPU', message: 'Upscaling video using CPU: 25%'
    }))
    expect(send.mock.calls.map(([, progress]) => progress as { hardwareLabel?: string }))
      .not.toContainEqual(expect.objectContaining({ hardwareLabel: 'dGPU' }))
  })

  it('keeps the real AI failure while omitting noisy device and progress status', async () => {
    const statusLines = Array.from({ length: 120 }, (_, index) => [
      `otc-upscale: progress=${((index % 100) / 100).toFixed(2)}`,
      'otc-upscale: rife-device=GPU.1 hardware=dGPU',
      'otc-upscale: flash-device=GPU.1 hardware=dGPU'
    ]).flat().join('\n')
    const actualError = 'source ended before Flash window filled'
    const error = await runFacePipeline([
      node("process.stdout.write('frame')"),
      node(`process.stderr.write(${JSON.stringify(`${statusLines}\n${actualError}\n`)}); process.exit(1)`),
      consume
    ], 'ai-flash-window-error', 1, { phase: 'upscaling' }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain(actualError)
    expect(message).not.toContain('otc-upscale: progress=')
    expect(message).not.toContain('otc-upscale: rife-device=')
    expect(message).not.toContain('otc-upscale: flash-device=')
  })

  it('filters an AI status line split across stderr chunks without losing its error', async () => {
    const actualError = 'source ended before Flash window filled'
    const chunks = [
      'otc-upscale: prog',
      'ress=0.25\notc-upscale: flash-de',
      `vice=GPU.1 hardware=dGPU\n${actualError}\n`
    ]
    const error = await runFacePipeline([
      node("process.stdout.write('frame')"),
      node([
        `process.stderr.write(${JSON.stringify(chunks[0])})`,
        `setTimeout(() => process.stderr.write(${JSON.stringify(chunks[1])}), 15)`,
        `setTimeout(() => process.stderr.write(${JSON.stringify(chunks[2])}), 30)`,
        'setTimeout(() => process.exit(1), 45)'
      ].join(';')),
      consume
    ], 'ai-fragmented-status-error', 1, { phase: 'upscaling' }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain(actualError)
    expect(message).not.toContain('otc-upscale: progress=')
    expect(message).not.toContain('otc-upscale: flash-device=')
  })

  it('streams complete frames through the worker and waits for all children', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-pipe-'))
    const path = join(directory, 'frames.rgb')
    await runFacePipeline([
      node('process.stdout.write(Buffer.alloc(1024 * 1024, 73))'), relay,
      node(`process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(path)})); process.stdout.write('out_time_us=500000\\n')`)
    ], 'stream', 1)
    expect((await readFile(path)).equals(Buffer.alloc(1024 * 1024, 73))).toBe(true)
    expect(cancelFaceExport('stream')).toBe(false)
  })

  it('hands only worker stderr to the optional capture callback and waits for it', async () => {
    let captured = ''
    let callbackFinished = false
    const capture = async (stream: Readable): Promise<void> => {
      for await (const chunk of stream) captured += String(chunk)
      await new Promise((resolve) => setTimeout(resolve, 20))
      callbackFinished = true
    }
    await runFacePipeline([
      node("process.stdout.write('frame')"),
      node("process.stderr.write('RCFACE1 0 0\\n'); process.stdin.pipe(process.stdout)"),
      node('process.stdin.resume()')
    ], 'stderr-capture', 1, { onWorkerStderr: capture })
    expect(captured).toBe('RCFACE1 0 0\n')
    expect(callbackFinished).toBe(true)
  })

  it('does not fail a video when optional stderr persistence rejects', async () => {
    await expect(runFacePipeline([
      node("process.stdout.write('frame')"), relay, consume
    ], 'stderr-capture-error', 1, { onWorkerStderr: () => Promise.reject(new Error('cache full')) })).resolves.toBeUndefined()
  })

  it('retains native worker diagnostics while the cache callback consumes stderr', async () => {
    const capture = async (stream: Readable): Promise<void> => {
      await finished(stream.resume())
    }
    const error = await runFacePipeline([
      node('process.exit(0)'),
      node("process.stderr.write('model compile failed'); process.exit(1)"),
      consume
    ], 'stderr-capture-detail', 1, { onWorkerStderr: capture }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ message: 'model compile failed' })
  })

  it('fails closed when the detector fails, stopping upstream and downstream', async () => {
    await expect(runFacePipeline([
      node('setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10)'),
      node("process.stderr.write('Inference failed'); process.exit(1)"), consume
    ], 'failure', 10)).rejects.toThrow('Inference failed')
    expect(cancelFaceExport('failure')).toBe(false)
  })

  it.each([126, 127])('classifies elevated worker exit %s as authorization failure', async (status) => {
    const error = await runFacePipeline([
      node('process.exit(0)'), { ...node(`process.exit(${status})`), elevated: true }, consume
    ], `authorization-${status}`, 1).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(FaceAuthorizationError)
  })

  it('reports an authorization failure as running when a CPU fallback is pending', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await expect(runFacePipeline([
      node('process.exit(0)'), { ...node('process.exit(126)'), elevated: true }, consume
    ], 'authorization-fallback-status', 1, {
      authorizationMessage: 'GPU authorization unavailable or declined; using CPU…'
    })).rejects.toBeInstanceOf(FaceAuthorizationError)
    const reports = send.mock.calls.map(([, progress]) => progress as { state?: string; message?: string })
    expect(reports).toContainEqual(expect.objectContaining({
      state: 'running', message: 'GPU authorization unavailable or declined; using CPU…'
    }))
    expect(reports).not.toContainEqual(expect.objectContaining({ state: 'failed' }))
  })

  it('classifies an unavailable elevated worker executable as authorization failure', async () => {
    const error = await runFacePipeline([
      node('process.exit(0)'), { executable: '/missing/otc-face-blur', args: [], elevated: true }, consume
    ], 'authorization-missing', 1).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(FaceAuthorizationError)
  })

  it('keeps an ordinary elevated worker failure as a worker error', async () => {
    const error = await runFacePipeline([
      node('process.exit(0)'), { ...node("process.stderr.write('worker failed'); process.exit(1)"), elevated: true }, consume
    ], 'worker-failure', 1).catch((failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(FaceAuthorizationError)
    expect(error).toMatchObject({ message: 'worker failed' })
  })

  it('retains a worker SIGTERM when stderr contains only AI status', async () => {
    const error = await runFacePipeline([
      node("process.stdout.write('frame')"),
      node("process.stderr.write('otc-upscale: progress=0.25\\n'); setImmediate(() => process.kill(process.pid, 'SIGTERM'))"),
      consume
    ], 'upscale-status-sigterm', 1, { phase: 'upscaling' }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain('SIGTERM')
    expect(message).not.toContain('otc-upscale: progress=')
  })

  it('reports the authorization prompt before starting an elevated worker', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    const pending = runFacePipeline([
      node('setInterval(()=>{},100)'), { ...node('process.stdin.on("end",()=>process.exit(0)); process.stdin.resume()'), elevated: true }, consume
    ], 'authorization-message', 1)
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith('job:progress', expect.objectContaining({ message: 'Preparing video; authorize GPU access if prompted…' }))
    expect(cancelFaceExport('authorization-message')).toBe(true)
    await expect(pending).rejects.toThrow('Job cancelled')
  }, 6000)

  it('keeps cancellation precedence when an elevated worker later exits with authorization status', async () => {
    const pending = runFacePipeline([
      node('setInterval(()=>{},100)'), { ...node('setTimeout(()=>process.exit(126),250)'), elevated: true }, consume
    ], 'late-authorization-cancel', 1)
    expect(cancelFaceExport('late-authorization-cancel')).toBe(true)
    await expect(pending).rejects.toThrow('Job cancelled')
  }, 6000)

  it('cancels the pipeline by forwarding EOF to the worker', async () => {
    const pending = runFacePipeline([
      node('setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10)'),
      node("process.stdin.on('end',()=>process.exit(0)); process.stdin.resume()"), consume
    ], 'cancel', 10)
    const rejected = expect(pending).rejects.toThrow('Job cancelled')
    expect(cancelFaceExport('cancel')).toBe(true)
    await rejected
    expect(cancelFaceExport('cancel')).toBe(false)
  }, 6000)

  it('streams a four-stage restricted encode and reports progress from the final remuxer', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      node("process.stdout.write('frame')"),
      relay,
      { ...node("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('NUT'); process.stdout.end() })"), elevated: true },
      node("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('out_time_us=500000\\n'); process.exit(0) })")
    ], 'four-stage', 1, { encodingHardwareLabel: 'dGPU', phase: 'encoding' })
    expect(send.mock.calls).toContainEqual(['job:progress', expect.objectContaining({ progress: 0.5, encodingHardwareLabel: 'dGPU' })])
  })

  it('classifies an authorization-style exit from an elevated encoder at any stage', async () => {
    const error = await runFacePipeline([
      node('process.exit(0)'), relay,
      { ...node('process.exit(126)'), elevated: true }, consume
    ], 'elevated-encoder-authorization', 1).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(FaceAuthorizationError)
  })

  it('cooperatively cancels native and elevated GPU stages without signalling them', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-cancel-gpu-'))
    const workerSignal = join(directory, 'worker-signal')
    const encoderSignal = join(directory, 'encoder-signal')
    const workerReady = join(directory, 'worker-ready')
    const encoderReady = join(directory, 'encoder-ready')
    const cooperative = (signalPath: string, readyPath: string, elevated = false): FaceCommand => ({
      ...node([
        `const fs = require('node:fs')`,
        `process.on('SIGINT', () => require('node:fs').writeFileSync(${JSON.stringify(signalPath)}, 'signalled'))`,
        'process.stdin.resume()',
        "process.stdin.on('end', () => { process.stdout.end(); process.exit(0) })",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready')`
      ].join(';')),
      ...(elevated ? { elevated: true } : { gpuWorker: true })
    })
    const pending = runFacePipeline([
      node('setInterval(() => process.stdout.write(Buffer.alloc(1024)), 10)'),
      cooperative(workerSignal, workerReady),
      cooperative(encoderSignal, encoderReady, true),
      consume
    ], 'cancel-gpu', 10)
    await vi.waitFor(async () => {
      expect(await readFile(workerReady, 'utf8')).toBe('ready')
      expect(await readFile(encoderReady, 'utf8')).toBe('ready')
    })
    const rejected = expect(pending).rejects.toThrow('Job cancelled')
    expect(cancelFaceExport('cancel-gpu')).toBe(true)
    await rejected
    await expect(readFile(workerSignal)).rejects.toThrow()
    await expect(readFile(encoderSignal)).rejects.toThrow()
  }, 6000)

  it('rejects a missing worker without leaving other processes running', async () => {
    await expect(runFacePipeline([
      node('setInterval(()=>{},100)'), { executable: '/missing/otc-face-blur', args: [] }, consume
    ], 'missing', 1)).rejects.toThrow()
    expect(cancelFaceExport('missing')).toBe(false)
  })

  it('shuts down active face pipelines and rejects late starts', async () => {
    const pending = runFacePipeline([
      node('setInterval(() => {}, 100)'),
      { ...node('process.stdin.on("end", () => process.exit(0)); process.stdin.resume()'), elevated: true },
      consume
    ], 'shutdown', 1)
    const rejected = expect(pending).rejects.toThrow('Job cancelled')
    await shutdownFaceExports()
    await rejected
    await expect(runFacePipeline([node('process.exit(0)'), relay, consume], 'late-start', 1)).rejects.toThrow('Job cancelled')
  }, 6000)
})
