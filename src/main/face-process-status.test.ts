import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface MockWindow { webContents: { send: (...args: unknown[]) => void } }

const electronMock = vi.hoisted(() => ({ windows: [] as MockWindow[] }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => electronMock.windows } }))

import { runFacePipeline, type FaceCommand, type FacePipelineOptions } from './face-process'
import type { JobProgress } from '../types'

const node = (source: string): FaceCommand => ({ executable: process.execPath, args: ['-e', source] })
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

function delayedWorker(includeDevice: boolean): FaceCommand {
  const device = includeDevice
    ? "setTimeout(() => process.stderr.write('otc-face-blur: dev'), 70); setTimeout(() => process.stderr.write('ice=CPU protocol=RGB24\\n'), 90);"
    : ''
  return {
    ...node([
      "process.stderr.write('otc-face-blur: star')",
      "setTimeout(() => process.stderr.write('ting\\n'), 20)",
      device,
      'const chunks = []',
      'process.stdin.on(\'data\', (chunk) => chunks.push(chunk))',
      "process.stdin.on('end', () => setTimeout(() => { process.stdout.write(Buffer.concat(chunks)); process.stdout.end() }, 500))"
    ].join(';')),
    elevated: true
  }
}

function encoder(): FaceCommand {
  return node("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('out_time_us=500000\\n'); process.exit(0) })")
}

function lateDeviceWorker(): FaceCommand {
  return {
    ...node([
      "process.stderr.write('otc-face-blur: starting\\n')",
      'process.stdin.resume()',
      "process.stdin.on('end', () => { process.stdout.write('frame'); setTimeout(() => { process.stderr.write('otc-face-blur: device=CPU protocol=RGB24\\n'); process.stdout.end() }, 250) })"
    ].join(';')),
    elevated: true
  }
}

function statusWorker(status: string): FaceCommand {
  return {
    ...node([
      "process.stderr.write('otc-face-blur: starting\\n')",
      `setTimeout(() => process.stderr.write(${JSON.stringify(`${status}\n`)}), 40)`,
      'process.stdin.resume()',
      "process.stdin.on('end', () => setTimeout(() => { process.stdout.write('frame'); process.stdout.end() }, 80))"
    ].join(';')),
    elevated: true
  }
}

function preparationDecoder(): FaceCommand {
  return node([
    "setTimeout(() => process.stderr.write('[showinfo@otc_prepare] pts_time:'), 10)",
    "setTimeout(() => process.stderr.write('NaN\\n[showinfo@otc_prepare] pts_time:Infinity\\n[showinfo@otc_prepare] pts_time:-1\\n[showinfo@otc_prepare] pts_time:0.25\\n[showinfo@otc_prepare] pts_time:1.25\\n[showinfo@otc_prepare] pts_time:9\\n'), 20)",
    "setTimeout(() => { process.stdout.write('frame'); process.stdout.end() }, 150)"
  ].join(';'))
}

function delayedPreparationWorker(): FaceCommand {
  return {
    ...node([
      "setTimeout(() => process.stderr.write('otc-face-blur: starting\\n'), 80)",
      'process.stdin.resume()',
      "process.stdin.on('end', () => { process.stdout.write('frame'); process.stdout.end() })"
    ].join(';')),
    elevated: true
  }
}

function progressReports(send: ReturnType<typeof vi.fn>): JobProgress[] {
  return send.mock.calls.map(([, progress]) => progress as JobProgress)
}

async function statusReports(status: string, options: FacePipelineOptions): Promise<JobProgress[]> {
  const send = vi.fn()
  electronMock.windows = [{ webContents: { send } }]
  await runFacePipeline([
    node("process.stdout.write('frame'); process.stdout.end()"), statusWorker(status), encoder()
  ], 'elevated-status-labels', 1, options)
  return progressReports(send)
}

afterEach(() => {
  electronMock.windows = []
})

describe('elevated face worker status', () => {
  it('uses the encoder label for cached analysis and does not infer a GPU class from an id', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    const pending = runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"), statusWorker('otc-face-blur: mode=cached'), encoder()
    ], 'elevated-status-cache', 1, { encodingHardwareLabel: 'dGPU' })
    try {
      await vi.waitFor(() => expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Encoding video using dGPU', phase: 'encoding', encodingHardwareLabel: 'dGPU'
      })), { timeout: 2000, interval: 10 })
      expect(progressReports(send).find(({ message }) => message === 'Encoding video using dGPU')).not.toHaveProperty('hardwareLabel')
    } finally {
      await pending
    }

    expect(progressReports(send)).toContainEqual(expect.objectContaining({
      progress: 0.5, message: 'Encoding video using dGPU: 50%'
    }))

    send.mockClear()
    const unknown = runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"), statusWorker('otc-face-blur: device=GPU.0 protocol=RGB24'), encoder()
    ], 'elevated-status-unknown-gpu', 1)
    try {
      await vi.waitFor(() => expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Detecting faces', phase: 'masking'
      })), { timeout: 2000, interval: 10 })
      expect(progressReports(send).find(({ message }) => message === 'Detecting faces')).not.toHaveProperty('hardwareLabel')
    } finally {
      await unknown
    }
  }, 6000)

  it.each([
    ['equal GPU detection and encoding', 'otc-face-blur: device=hardware=dGPU', {
      label: 'Encoding video using dGPU', phase: 'encoding', hardwareLabel: 'dGPU', encodingHardwareLabel: 'dGPU'
    }, 'Encoding video using dGPU'],
    ['CPU detection with dGPU encoding', 'otc-face-blur: device=hardware=CPU', {
      label: 'Encoding video using dGPU', phase: 'encoding', encodingHardwareLabel: 'dGPU'
    }, 'Encoding video using dGPU'],
    ['GPU detection with CPU encoding', 'otc-face-blur: device=hardware=dGPU', {
      label: 'Encoding video using CPU', phase: 'encoding', encodingHardwareLabel: 'CPU'
    }, 'Encoding video using CPU'],
    ['unknown encoder does not borrow detector hardware', 'otc-face-blur: device=hardware=CPU', {
      label: 'Encoding video', phase: 'encoding'
    }, 'Encoding video']
  ] as const)('%s', async (_name, status, options, expected) => {
    const reports = await statusReports(status, options)
    const statusReport = reports.find(({ message }) => message === expected)
    expect(statusReport).toEqual(expect.objectContaining({
      message: expected,
      phase: 'encoding',
      hardwareLabel: /hardware=(CPU|iGPU|dGPU)/.exec(status)?.[1]
    }))
    if ('encodingHardwareLabel' in options) expect(statusReport).toHaveProperty('encodingHardwareLabel', options.encodingHardwareLabel)
    expect(reports.some((report) => report.progress === 0.5
      && report.message === `${expected}: 50%`
      && report.phase === 'encoding'
      && typeof report.etaSeconds === 'number')).toBe(true)
    expect(reports.some(({ message }) => message.startsWith('Detecting faces'))).toBe(false)
    if (expected === 'Encoding video') {
      expect(reports.some(({ message }) => message.includes('using CPU'))).toBe(false)
    }
  }, 6000)

  it('retains the CPU fallback reason while using the CPU encoder label', async () => {
    const reports = await statusReports('otc-face-blur: mode=cached', {
      message: 'GPU authorization unavailable or declined; using CPU…',
      label: 'Encoding video using CPU', phase: 'encoding', encodingHardwareLabel: 'CPU'
    })
    expect(reports).toContainEqual(expect.objectContaining({
      message: 'GPU authorization unavailable or declined; using CPU…'
    }))
    expect(reports).toContainEqual(expect.objectContaining({
      progress: 0.5,
      message: 'GPU authorization unavailable or declined; using CPU… Encoding video using CPU: 50%',
      phase: 'encoding'
    }))
  }, 6000)

  it('parses bounded split preparation markers, ignores nonfinite values, clamps, and hands off to masking', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    await runFacePipeline([
      preparationDecoder(), delayedPreparationWorker(), encoder()
    ], 'elevated-status-preparation', 1, { preparationStart: 0, preparationEnd: 4 })
    const reports = progressReports(send)
    expect(reports).toContainEqual(expect.objectContaining({
      state: 'running', progress: 0, message: 'Preparing video frames: 0%', phase: 'preparing'
    }))
    expect(reports).toContainEqual(expect.objectContaining({
      state: 'running', progress: 0.3125, message: 'Preparing video frames: 31%', phase: 'preparing'
    }))
    expect(reports).toContainEqual(expect.objectContaining({
      state: 'running', progress: 1, message: 'Preparing video frames: 100%', phase: 'preparing'
    }))
    expect(reports).not.toContainEqual(expect.objectContaining({ message: 'Preparing video frames…' }))
    const masking = reports.findIndex(({ message }) => message === 'Masking faces: 50%')
    const finalPreparation = reports.findIndex(({ message }) => message === 'Preparing video frames: 100%')
    expect(finalPreparation).toBeGreaterThan(-1)
    expect(masking).toBeGreaterThan(finalPreparation)
  }, 6000)

  it('reports video preparation after a split startup marker while stderr is captured', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    let startupResolve: (() => void) | undefined
    const startup = new Promise<void>((resolve) => { startupResolve = resolve })
    let captured = ''
    const capture = async (stream: Readable): Promise<void> => {
      for await (const chunk of stream) {
        captured += String(chunk)
        if (captured.includes('otc-face-blur: starting')) startupResolve?.()
      }
    }
    const pending = runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"), delayedWorker(false), encoder()
    ], 'elevated-status-capture', 1, { onWorkerStderr: capture })
    try {
      await startup
      await delay(30)
      expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Preparing video; authorize GPU access if prompted…', phase: 'preparing'
      }))
      expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Preparing video frames…', phase: 'preparing'
      }))
      expect(progressReports(send)).not.toContainEqual(expect.objectContaining({ message: 'Detecting and masking faces…' }))
      expect(captured).toContain('otc-face-blur: starting\n')
    } finally {
      await pending
    }
  }, 6000)

  it('reports preparation then detection after split startup and device markers without capture', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    const pending = runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"), delayedWorker(true), encoder()
    ], 'elevated-status-device', 1)
    try {
      await delay(400)
      expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Preparing video frames…'
      }))
      expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Detecting faces using CPU',
        phase: 'masking', hardwareLabel: 'CPU'
      }))
    } finally {
      await pending
    }
  }, 6000)

  it('keeps encoded progress when the device marker arrives later', async () => {
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    const pending = runFacePipeline([
      node("process.stdout.write('frame'); process.stdout.end()"), lateDeviceWorker(),
      node("process.stdin.on('data', () => process.stdout.write('out_time_us=500000\\n')); process.stdin.on('end', () => process.exit(0))")
    ], 'elevated-status-late-device', 1)
    try {
      await vi.waitFor(() => expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Masking faces: 50%', progress: 0.5
      })), { timeout: 2000, interval: 10 })
      await vi.waitFor(() => expect(progressReports(send)).toContainEqual(expect.objectContaining({
        state: 'running', message: 'Detecting faces using CPU', progress: 0.5,
        phase: 'masking', hardwareLabel: 'CPU'
      })), { timeout: 2000, interval: 10 })
    } finally {
      await pending
    }
  }, 6000)
})
