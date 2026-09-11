import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send } }]
  }
}))

import { JobManager } from './jobs'

beforeEach(() => send.mockClear())

describe('media job progress', () => {
  it('ignores FFmpeg N/A timestamps before reporting numeric progress', async () => {
    const script = "process.stdout.write('out_time_us=N/A\\nout_time_us=5000000\\n')"
    await new JobManager().run(process.execPath, ['-e', script], 'export', 10)

    const updates = send.mock.calls.map((call) => call[1] as { progress: number; message: string })
    expect(updates.map(({ message }) => message)).toEqual(['Queued', 'Starting', '50%', 'Complete'])
    expect(updates.every(({ progress }) => Number.isFinite(progress))).toBe(true)
  })

  it('keeps a fallback note on lifecycle and progress updates, but not errors', async () => {
    const script = "process.stdout.write('out_time_us=5000000\\n')"
    await new JobManager().run(process.execPath, ['-e', script], 'export', 10, undefined, 'GPU fallback')

    const updates = send.mock.calls.map((call) => call[1] as { message: string })
    expect(updates.map(({ message }) => message)).toEqual([
      'GPU fallback: Queued', 'GPU fallback: Starting', 'GPU fallback: 50%', 'GPU fallback: Complete'
    ])

    send.mockClear()
    await expect(new JobManager().run('/missing-otc-processor', [], 'export', 10, undefined, 'GPU fallback')).rejects.toThrow()
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'Could not start media processor' })
  })

  it('reports a process startup failure once', async () => {
    await expect(new JobManager().run('/missing-otc-processor', [], 'export', 10)).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const states = send.mock.calls.map((call) => (call[1] as { state: string }).state)
    expect(states.filter((state) => state === 'failed')).toHaveLength(1)
    expect(states).not.toContain('completed')
  })

  it('does not report an unexpected process kill as cancellation', async () => {
    const script = "process.kill(process.pid, 'SIGKILL')"
    await expect(new JobManager().run(process.execPath, ['-e', script], 'export', 10)).rejects.toThrow()

    const states = send.mock.calls.map((call) => (call[1] as { state: string }).state)
    expect(states).toContain('failed')
    expect(states).not.toContain('cancelled')
  })

  it('cancels and drains owned children during shutdown', async () => {
    const script = "process.on('SIGINT', () => setTimeout(() => process.exit(0), 20)); setInterval(() => {}, 1000)"
    const manager = new JobManager()
    const run = manager.run(process.execPath, ['-e', script], 'export', 10)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const shutdown = manager.shutdown()
    expect(manager.shutdown()).toBe(shutdown)
    await expect(run).rejects.toThrow('Job cancelled')
    await shutdown
    await expect(manager.run(process.execPath, ['-e', 'process.exit(0)'], 'export', 1)).rejects.toThrow('shutting down')

    const states = send.mock.calls.map((call) => (call[1] as { state: string }).state)
    expect(states).toContain('cancelled')
  })

  it('escalates an owned child that ignores SIGINT during shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-job-shutdown-'))
    const marker = join(directory, 'ready')
    const script = [
      "process.on('SIGINT', () => {})",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready')`,
      'setInterval(() => {}, 1000)'
    ].join(';')
    const manager = new JobManager()
    const run = manager.run(process.execPath, ['-e', script], 'export', 10)
    try {
      await vi.waitFor(async () => access(marker), { timeout: 3_000, interval: 10 })
      const shutdown = manager.shutdown()
      await expect(run).rejects.toThrow('Job cancelled')
      await shutdown
    } finally {
      await manager.shutdown()
      await run.catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
