import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarrationWorker, requireVoicePack, voicePackDirectory } from './narration-worker'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn(), restricted: vi.fn(), packaged: false }))
vi.mock('node:child_process', () => ({ default: { spawn: mocks.spawn }, spawn: mocks.spawn }))
vi.mock('node:fs/promises', () => ({ default: { access: mocks.access }, access: mocks.access }))
vi.mock('electron', () => ({ app: { get isPackaged() { return mocks.packaged }, getPath: () => '/installed/OneTrackCat' } }))
vi.mock('./binaries', () => ({ ffmpegPath: () => '/ffmpeg' }))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: mocks.restricted }))

function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null as number | null })
  process.stdin.on('finish', () => { process.exitCode = 0; process.emit('close', 0) })
  return process
}
let process: ReturnType<typeof child>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.packaged = false
  mocks.access.mockResolvedValue(undefined)
  mocks.restricted.mockResolvedValue(undefined)
  process = child()
  mocks.spawn.mockImplementation(() => { queueMicrotask(() => process.stdout.write('{"ready":true,"hardware":"dGPU"}\n')); return process })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('Narration worker', () => {
  it('finds the sidecar/development pack and explains incomplete installations', async () => {
    expect(voicePackDirectory()).toContain('/dist/voice-pack')
    expect(await requireVoicePack()).toContain('/dist/voice-pack')
    mocks.packaged = true
    expect(voicePackDirectory()).toBe('/installed/voice-pack')
    mocks.access.mockRejectedValue(new Error('missing'))
    await expect(requireVoicePack()).rejects.toThrow('optional voice pack')
  })

  it('uses one authorized process for sequential model requests and truthful hardware progress', async () => {
    mocks.restricted.mockResolvedValue('/dev/dri/restricted')
    const progress = vi.fn()
    const worker = new NarrationWorker(progress)
    await worker.start('/pack')
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe('/usr/bin/pkexec')
    const result = worker.request({ action: 'separate' })
    await vi.waitFor(() => { expect(process.stdin.readableLength).toBeGreaterThan(0) })
    process.stdout.write('{"progress":{"stage":"Separating speech","fraction":0.5}}\n{"result":{"speechPath":"speech.wav"}}\n')
    expect(await result).toEqual({ speechPath: 'speech.wav' })
    expect(progress).toHaveBeenCalledWith({ stage: 'Separating speech using dGPU', fraction: 0.5 })
    const rewrite = worker.request({ action: 'rewrite' })
    await Promise.resolve()
    process.stdout.write('{"error":"Invalid cleanup JSON"}\n')
    await expect(rewrite).rejects.toThrow('Invalid cleanup JSON')
    worker.close()
    await worker.stopped()
  })

  it('cooperatively cancels and rejects concurrent or post-close requests', async () => {
    const worker = new NarrationWorker(vi.fn())
    await worker.start('/pack')
    const result = worker.request({ action: 'transcribe' })
    await Promise.resolve()
    await expect(worker.request({ action: 'rewrite' })).rejects.toThrow('busy')
    worker.close(true)
    await expect(result).rejects.toThrow('cancelled')
    await worker.stopped()
    await expect(worker.request({ action: 'rewrite' })).rejects.toThrow('cancelled')
  })

  it('uses explicit CPU mode and rejects a broken protocol instead of hanging', async () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    const worker = new NarrationWorker(vi.fn())
    await worker.start('/pack')
    expect(mocks.spawn.mock.calls[0]?.[1]).toContain('--cpu')
    const result = worker.request({ action: 'transcribe' })
    await Promise.resolve()
    process.stdout.write('not json\n')
    await expect(result).rejects.toThrow('Invalid narration worker response')
    worker.close()
    await worker.stopped()
  })

  it('falls back once to CPU when GPU authorization is declined', async () => {
    mocks.restricted.mockResolvedValue('/dev/dri/restricted')
    const denied = child()
    const cpu = child()
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => { denied.exitCode = 126; denied.emit('close', 126) })
      return denied
    }).mockImplementationOnce(() => {
      queueMicrotask(() => cpu.stdout.write('{"ready":true,"hardware":"CPU"}\n'))
      return cpu
    })
    const progress = vi.fn()
    const worker = new NarrationWorker(progress)
    await worker.start('/pack')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.spawn.mock.calls[1]?.[0]).toBe('/pack/runtime/bin/python')
    expect(mocks.spawn.mock.calls[1]?.[1]).toContain('--cpu')
    expect(progress).toHaveBeenCalledWith({ stage: 'GPU authorization unavailable; continuing using CPU', fraction: 0 })
    worker.close()
    await worker.stopped()
  })
})
