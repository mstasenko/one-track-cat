import { describe, expect, it, vi } from 'vitest'
import { aiExportCanvas, aiWorkerCommand } from './ai-export'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

describe('AI worker command', () => {
  it('uses the input canvas for decoding and the target canvas for output', () => {
    const pack = { executable: '/ai-worker', models: '/models/flashvsr-plus', rife: '/models/rife.xml' }
    const canvas = { width: 1920, height: 1080, fps: 24, fit: 'contain' as const }
    const command = aiWorkerCommand(pack, canvas, aiExportCanvas(canvas), 3, false, 'turbo', '/tmp/ai-work')
    expect(command).toMatchObject({ executable: '/ai-worker', gpuWorker: true })
    expect(command.args).toEqual(expect.arrayContaining([
      '--models', '/models/flashvsr-plus', '--rife', '/models/rife.xml',
      '--mode', 'turbo', '--scratch', '/tmp/ai-work',
      '--width', '1920', '--height', '1080', '--fps', '24',
      '--output-width', '3840', '--output-height', '2160', '--output-fps', '60',
      '--duration', '3', '--device', 'AUTO'
    ]))
  })
})
