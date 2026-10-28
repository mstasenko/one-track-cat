import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobProgress } from '../types'
import { runFacePipeline, type FaceCommand } from './face-process'

interface MockWindow { webContents: { send: (...args: unknown[]) => void } }

const electronMock = vi.hoisted(() => ({ windows: [] as MockWindow[] }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => electronMock.windows } }))

const node = (source: string): FaceCommand => ({ executable: process.execPath, args: ['-e', source] })

function passThroughWorker(statuses: string[]): FaceCommand {
  const writes = statuses.map((status, index) =>
    `setTimeout(() => process.stderr.write(${JSON.stringify(`${status}\n`)}), ${20 + index * 20})`
  ).join(';')
  return {
    ...node([
      writes,
      'process.stdin.on("data", () => undefined)',
      "process.stdin.on('end', () => setTimeout(() => { process.stdout.write('frame'); process.stdout.end() }, 100))"
    ].join(';')),
    elevated: true
  }
}

function encoder(): FaceCommand {
  return node("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('out_time_us=500000\\n'); process.exit(0) })")
}

function reports(send: ReturnType<typeof vi.fn>): JobProgress[] {
  return send.mock.calls.map(([, progress]) => progress as JobProgress)
}

afterEach(() => {
  electronMock.windows = []
})

describe('Upscaling pipeline status', () => {
  it('reports model progress before encoding and never regresses behind it', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"),
      passThroughWorker(['otc-upscale: device=GPU.1 hardware=dGPU',
        'otc-upscale: progress=0.75', 'otc-upscale: progress=NaN',
        'otc-upscale: progress=2', 'otc-upscale: progress=0.3',
        'otc-upscale: progress=1']), encoder()
    ], 'upscale-model-progress', 1, { label: 'Upscaling video', phase: 'upscaling' })
    const progress = reports(send).filter(({ phase, state }) => phase === 'upscaling' && state === 'running')
    expect(progress).toContainEqual(expect.objectContaining({ progress: 0.75, hardwareLabel: 'dGPU' }))
    expect(progress).toContainEqual(expect.objectContaining({ progress: 0.99, hardwareLabel: 'dGPU' }))
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]?.progress).toBeGreaterThanOrEqual(progress[index - 1]?.progress ?? 0)
    }
    expect(progress.every(({ progress: value }) => Number.isFinite(value) && value <= 1)).toBe(true)
  }, 6000)

  it.each(['dGPU', 'iGPU', 'CPU'] as const)('reports the AI worker hardware as %s', async (hardware) => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]

    await runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"),
      passThroughWorker(['otc-face-blur: mode=inference', 'otc-face-blur: device=GPU.0 hardware=CPU']),
      passThroughWorker(['otc-upscale: starting', `otc-upscale: device=GPU.0 hardware=${hardware}`]),
      encoder()
    ], `upscale-status-${hardware}`, 1, { label: 'Upscaling video', phase: 'upscaling' })

    const progress = reports(send)
    expect(progress).toContainEqual(expect.objectContaining({
      state: 'running', phase: 'upscaling', hardwareLabel: hardware,
      message: `Upscaling video using ${hardware}: 0%`
    }))
    const encoded = progress.find(({ message }) => message === `Upscaling video using ${hardware}: 50%`)
    expect(encoded).toMatchObject({ state: 'running', phase: 'upscaling', progress: 0.5, hardwareLabel: hardware })
    expect(typeof encoded?.etaSeconds).toBe('number')
  }, 6000)

  it('parses AI status from a later intermediate worker without allowing face status to overwrite it', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]

    await runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"),
      passThroughWorker([
        'otc-face-blur: mode=cached',
        'otc-face-blur: device=GPU.0 hardware=dGPU',
        'otc-face-blur: mode=inference'
      ]),
      passThroughWorker([
        'otc-upscale: starting',
        'otc-upscale: device=GPU.0 hardware=dGPU'
      ]),
      encoder()
    ], 'upscale-status-four-stage', 1, { label: 'Upscaling video', phase: 'upscaling' })

    const progress = reports(send)
    expect(progress.some(({ message }) => message.startsWith('Detecting faces'))).toBe(false)
    expect(progress.some(({ message }) => message.startsWith('Applying cached face analysis'))).toBe(false)
    expect(progress).toContainEqual(expect.objectContaining({
      progress: 0.5, phase: 'upscaling', hardwareLabel: 'dGPU',
      message: 'Upscaling video using dGPU: 50%'
    }))
    expect(progress.filter(({ message }) => message.includes('Upscaling video using dGPU')).length).toBeGreaterThan(0)
  }, 6000)

  it('ignores a failed AI device announcement after a valid hardware label', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]

    await runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"),
      passThroughWorker(['otc-face-blur: mode=cached']),
      passThroughWorker([
        'otc-upscale: starting',
        'otc-upscale: device=GPU.0 hardware=dGPU',
        'otc-upscale: device=GPU.0 hardware=CPU failed to initialize'
      ]),
      encoder()
    ], 'upscale-status-failed-device', 1, { label: 'Upscaling video', phase: 'upscaling' })

    const progress = reports(send)
    expect(progress).toContainEqual(expect.objectContaining({
      phase: 'upscaling', hardwareLabel: 'dGPU', message: 'Upscaling video using dGPU: 0%'
    }))
    expect(progress).not.toContainEqual(expect.objectContaining({
      phase: 'upscaling', hardwareLabel: 'CPU'
    }))
  }, 6000)
})
