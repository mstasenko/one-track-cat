import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FaceCommand } from './face-process'

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:child_process', () => ({ default: { spawn: childProcessMock.spawn }, spawn: childProcessMock.spawn }))
import { cancelFaceExport, runFacePipeline } from './face-process'

class FakeStream extends EventEmitter {
  readonly end = vi.fn()
  readonly resume = vi.fn()
  readonly unpipe = vi.fn()
  setEncoding(): void { return undefined }
  pipe<T>(destination: T): T { return destination }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  readonly stdin = new FakeStream()
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly kill = vi.fn((signal: string) => {
    if (signal !== 'SIGKILL') return
    this.exitCode = 137
    this.emit('close', 137)
  })
}

const command = (): FaceCommand => ({ executable: '/mock/worker', args: [] })

afterEach(() => {
  vi.useRealTimers()
  childProcessMock.spawn.mockReset()
})

describe('face process failure escalation', () => {
  it('drains the worker while escalating FFmpeg children after cancellation', async () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const pending = runFacePipeline([command(), command(), command()], 'edge-cancel', 1)
    const rejected = expect(pending).rejects.toThrow('Job cancelled')
    await Promise.resolve()
    children.forEach((child) => child.stdin.emit('error', { code: 'EPIPE' }))
    expect(cancelFaceExport('edge-cancel')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    children[1]?.emit('close', 0)
    await rejected
    expect(children[0]?.kill.mock.calls.some(([signal]) => signal === 'SIGKILL')).toBe(true)
    expect(children[2]?.kill.mock.calls.some(([signal]) => signal === 'SIGKILL')).toBe(true)
    expect(children[1]?.kill).not.toHaveBeenCalled()
    expect(children[0]?.stdout.unpipe).toHaveBeenCalledWith(children[1]?.stdin)
    expect(children[1]?.stdin.end).toHaveBeenCalledOnce()
    expect(children[1]?.stdout.unpipe).toHaveBeenCalledWith(children[2]?.stdin)
    expect(children[1]?.stdout.resume).toHaveBeenCalledOnce()
  })

  it('waits for a cooperatively closing worker after FFmpeg escalation', async () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const pending = runFacePipeline([command(), command(), command()], 'edge-worker-close', 1)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(cancelFaceExport('edge-worker-close')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.resolve()
    expect(settled).toBe(false)
    children[1]?.emit('close', 0)
    await expect(pending).rejects.toThrow('Job cancelled')
  })

  it('cleans up an already-started child when a later spawn throws', async () => {
    vi.useFakeTimers()
    const decoder = new FakeChild()
    childProcessMock.spawn.mockImplementationOnce(() => decoder).mockImplementationOnce(() => { throw new Error('spawn failed') })
    const pending = runFacePipeline([command(), command(), command()], 'edge-startup', 1)
    const rejected = expect(pending).rejects.toThrow('spawn failed')
    await vi.advanceTimersByTimeAsync(3000)
    await rejected
    expect(decoder.kill.mock.calls.some(([signal]) => signal === 'SIGKILL')).toBe(true)
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2)
  })

  it('fails immediately for a non-EPIPE pipeline input error', async () => {
    const children: FakeChild[] = []
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const pending = runFacePipeline([command(), command(), command()], 'edge-error', 1)
    await Promise.resolve()
    children[0]?.stdin.emit('error', { code: 'EIO', message: 'input failed' })
    children.forEach((child) => {
      child.exitCode = 1
      child.emit('close', 1)
    })
    await expect(pending).rejects.toThrow('input failed')
    expect(cancelFaceExport('edge-error')).toBe(false)
  })
})
