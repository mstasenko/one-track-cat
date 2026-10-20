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

describe('AI enhancement pipeline status', () => {
  it('reports model progress before encoding and never regresses behind it', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"),
      passThroughWorker(['otc-ai-enhance: device=GPU.1 hardware=dGPU',
        'otc-ai-enhance: progress=0.75', 'otc-ai-enhance: progress=NaN',
        'otc-ai-enhance: progress=2', 'otc-ai-enhance: progress=0.3',
        'otc-ai-enhance: progress=1']), encoder()
    ], 'ai-model-progress', 1, { label: 'AI enhancing video', phase: 'enhancing' })
    const progress = reports(send).filter(({ phase, state }) => phase === 'enhancing' && state === 'running')
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
      passThroughWorker(['otc-ai-enhance: starting', `otc-ai-enhance: device=GPU.0 hardware=${hardware}`]),
      encoder()
    ], `ai-status-${hardware}`, 1, { label: 'AI enhancing video', phase: 'enhancing' })

    const progress = reports(send)
    expect(progress).toContainEqual(expect.objectContaining({
      state: 'running', phase: 'enhancing', hardwareLabel: hardware,
      message: `AI enhancing video using ${hardware}: 0%`
    }))
    const encoded = progress.find(({ message }) => message === `AI enhancing video using ${hardware}: 50%`)
    expect(encoded).toMatchObject({ state: 'running', phase: 'enhancing', progress: 0.5, hardwareLabel: hardware })
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
        'otc-ai-enhance: starting',
        'otc-ai-enhance: device=GPU.0 hardware=dGPU'
      ]),
      encoder()
    ], 'ai-status-four-stage', 1, { label: 'AI enhancing video', phase: 'enhancing' })

    const progress = reports(send)
    expect(progress.some(({ message }) => message.startsWith('Detecting faces'))).toBe(false)
    expect(progress.some(({ message }) => message.startsWith('Applying cached face analysis'))).toBe(false)
    expect(progress).toContainEqual(expect.objectContaining({
      progress: 0.5, phase: 'enhancing', hardwareLabel: 'dGPU',
      message: 'AI enhancing video using dGPU: 50%'
    }))
    expect(progress.filter(({ message }) => message.includes('AI enhancing video using dGPU')).length).toBeGreaterThan(0)
  }, 6000)

  it('ignores a failed AI device announcement after a valid hardware label', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]

    await runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"),
      passThroughWorker(['otc-face-blur: mode=cached']),
      passThroughWorker([
        'otc-ai-enhance: starting',
        'otc-ai-enhance: device=GPU.0 hardware=dGPU',
        'otc-ai-enhance: device=GPU.0 hardware=CPU failed to initialize'
      ]),
      encoder()
    ], 'ai-status-failed-device', 1, { label: 'AI enhancing video', phase: 'enhancing' })

    const progress = reports(send)
    expect(progress).toContainEqual(expect.objectContaining({
      phase: 'enhancing', hardwareLabel: 'dGPU', message: 'AI enhancing video using dGPU: 0%'
    }))
    expect(progress).not.toContainEqual(expect.objectContaining({
      phase: 'enhancing', hardwareLabel: 'CPU'
    }))
  }, 6000)
})
