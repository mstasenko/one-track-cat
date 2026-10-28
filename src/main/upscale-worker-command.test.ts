import { describe, expect, it, vi } from 'vitest'
import { upscaleExportCanvas, upscaleWorkerCommand } from './upscale-export'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

describe('Upscale worker command', () => {
  it('passes lower-rate clip ranges without changing the existing render clock', () => {
    const canvas = { width: 3840, height: 2160, fps: 60, fit: 'contain' as const }
    const command = upscaleWorkerCommand({ executable: '/upscale', rife: '/rife.xml' }, canvas, canvas,
      3, true, undefined, undefined, undefined, [[0.5, 1], [2, 4]])
    expect(command.args).toEqual(expect.arrayContaining(['--interpolation-range', '30:60']))
    expect(command.args).toEqual(expect.arrayContaining(['--interpolation-range', '120:180']))
    expect(command.args).toEqual(expect.arrayContaining(['--fps', '60', '--output-fps', '60']))
    expect(command.gpuWorker).toBe(false)
  })
  it('uses the input canvas for decoding and the target canvas for output', () => {
    const pack = { executable: '/upscale-worker', models: '/models/flashvsr-plus', rife: '/models/rife.xml' }
    const canvas = { width: 1920, height: 1080, fps: 24, fit: 'contain' as const }
    const command = upscaleWorkerCommand(pack, canvas, upscaleExportCanvas(canvas), 3, false, 'turbo', '/tmp/upscale-work')
    expect(command).toMatchObject({ executable: '/upscale-worker', gpuWorker: true })
    expect(command.args).toEqual(expect.arrayContaining([
      '--models', '/models/flashvsr-plus', '--rife', '/models/rife.xml',
      '--mode', 'turbo', '--scratch', '/tmp/upscale-work',
      '--width', '1920', '--height', '1080', '--fps', '24',
      '--output-width', '3840', '--output-height', '2160', '--output-fps', '60',
      '--duration', '3', '--device', 'AUTO'
    ]))
  })
})
