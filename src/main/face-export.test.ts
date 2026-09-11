import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, FaceBlurEffect } from '../types'
import type { FaceCommand } from './face-process'
interface MockWindow { webContents: { send: (...args: unknown[]) => void } }
const electronMock = vi.hoisted(() => ({ windows: [] as MockWindow[] }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => electronMock.windows } }))
vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
vi.mock('./face-pack', () => ({ requireFacePack: vi.fn() }))
const workerMock = vi.hoisted(() => ({ build: vi.fn() }))
const restrictedMock = vi.hoisted(() => ({ node: vi.fn() }))
const encoderMock = vi.hoisted(() => ({ exportEncoders: vi.fn() }))
const detectionCacheMock = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('./face-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./face-worker')>()
  return { ...actual, buildFaceWorkerCommand: workerMock.build, restrictedIntelRenderNode: restrictedMock.node }
})
vi.mock('./export-encoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export-encoder')>()
  return { ...actual, exportEncoders: encoderMock.exportEncoders }
})
vi.mock('./face-detection-cache', () => ({ prepareFaceDetectionCache: detectionCacheMock.prepare }))
import { requireFacePack } from './face-pack'
import { encodeWithFaces, faceEffectRows } from './face-export'
import { softwareEncoder } from './export-encoder'
import { jobs } from './jobs'
import { nativeFaceWorkerCommand } from './face-worker'

let directory: string | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})
const effect: FaceBlurEffect = { id: 'face', start: 0.2, duration: 0.5, sensitivity: 0.7, detail: 'small', holdSeconds: 0.3, strength: 0.7, style: 'pixelate' }
const autoWorker = (pack: { executable: string; model: string }, canvas: { width: number; height: number; fps: number }, effects: string): FaceCommand =>
  nativeFaceWorkerCommand(pack, canvas, effects, 'AUTO')
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
const ffprobe = join(process.cwd(), 'node_modules/ffprobe-static/bin/linux/x64/ffprobe')

interface MediaProbe {
  chapters?: unknown[]
  format?: { tags?: Record<string, string> }
  streams?: { codec_type?: string; tags?: Record<string, string> }[]
}

function probeMedia(path: string): MediaProbe {
  return JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format_tags:stream=codec_type:stream_tags:chapters', '-of', 'json', path
  ], { encoding: 'utf8' })) as MediaProbe
}

describe('face export composition pipeline', () => {
  beforeEach(() => {
    electronMock.windows = []
    workerMock.build.mockReset()
    workerMock.build.mockImplementation(autoWorker)
    restrictedMock.node.mockReset()
    restrictedMock.node.mockResolvedValue(undefined)
    encoderMock.exportEncoders.mockReset()
    encoderMock.exportEncoders.mockResolvedValue([softwareEncoder()])
    detectionCacheMock.prepare.mockReset()
    detectionCacheMock.prepare.mockResolvedValue({
      workerArgs: [],
      commit: vi.fn(),
      cleanup: vi.fn()
    })
  })

  it('serializes only validated numeric settings for the native worker', () => {
    expect(faceEffectRows([effect])).toBe('0.2\t0.7\t0.7\t1\t0.3\t0.7\t0\n')
    expect(faceEffectRows([{ ...effect, detail: 'standard', style: 'mask' }])).toContain('\t0\t0.3\t0.7\t2\n')
  })
  it('streams composed frames and retains audio without an intermediate lossy video encode', async () => {
    vi.stubEnv('otc_CPU_ONLY', '0')
    const send = vi.fn()
    electronMock.windows = [{ webContents: { send } }]
    directory = await mkdtemp(join(tmpdir(), 'otc-face-export-'))
    const worker = join(directory, 'passthrough-worker')
    // This is a transport test, not a detector accuracy test; the real pack has separate CPU checks.
    await writeFile(worker, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout)\n')
    await chmod(worker, 0o755)
    vi.mocked(requireFacePack).mockResolvedValue({ executable: worker, model: join(directory, 'unused.xml') })
    const output = join(directory, 'out.mp4')
    const request: ExportRequest = {
      canvas: { width: 64, height: 64, fps: 10, fit: 'contain' }, sources: [], segments: [], overlays: [], outputPath: output,
    }
    await encodeWithFaces(request, ['-hide_banner', '-y'], {
      graph: 'color=c=red:s=64x64:r=10:d=1[video];sine=frequency=880:duration=1[aout]', videoLabel: 'video', audioLabel: 'aout'
    }, directory, output, 1, 'transport')
    expect(send.mock.calls[0]?.[1]).toMatchObject({ message: 'Encoding video using CPU', phase: 'encoding' })
    const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
    const frames = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    expect(frames.length).toBe(64 * 64 * 3 * 10)
    expect(frames[0]).toBeGreaterThan(240)
    const audio = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', 'pipe:1'])
    expect(audio.length).toBeGreaterThan(80_000)

    // Exercise the CPU-only native-worker selection as well as the AUTO path above.
    vi.stubEnv('otc_CPU_ONLY', '1')
    await encodeWithFaces(request, ['-hide_banner', '-y'], {
      graph: 'color=c=red:s=64x64:r=10:d=1[video];sine=frequency=880:duration=1[aout]', videoLabel: 'video', audioLabel: 'aout'
    }, directory, output, 1, 'transport-cpu')
  }, 15_000)

  it('strips source metadata and chapters while preserving media and the source file', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-export-metadata-'))
    const base = join(directory, 'tagged-base.mp4')
    const source = join(directory, 'tagged-source.mp4')
    const chapters = join(directory, 'chapters.ffmeta')
    const worker = join(directory, 'passthrough-worker')
    const output = join(directory, 'output.mp4')
    await writeFile(worker, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout)\n')
    await chmod(worker, 0o755)
    await writeFile(chapters, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/10\nSTART=0\nEND=5\ntitle=PERSONAL CHAPTER\n')
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=10:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata', 'title=PERSONAL TITLE', '-metadata', 'artist=PERSONAL ARTIST',
      '-metadata', 'comment=PERSONAL COMMENT', '-metadata', 'location=PERSONAL LOCATION',
      '-metadata', 'creation_time=2020-01-02T03:04:05Z',
      '-metadata:s:v:0', 'handler_name=PERSONAL VIDEO HANDLER',
      '-metadata:s:a:0', 'handler_name=PERSONAL AUDIO HANDLER', base
    ])
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', base, '-f', 'ffmetadata', '-i', chapters,
      '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy',
      '-metadata', 'title=PERSONAL TITLE', '-metadata', 'artist=PERSONAL ARTIST',
      '-metadata', 'comment=PERSONAL COMMENT', '-metadata', 'location=PERSONAL LOCATION',
      '-metadata', 'creation_time=2020-01-02T03:04:05Z', source
    ])
    const sourceBefore = await readFile(source)
    const sourceMetadata = probeMedia(source)
    expect(JSON.stringify(sourceMetadata)).toContain('PERSONAL')
    expect(sourceMetadata.chapters ?? []).toHaveLength(1)
    vi.mocked(requireFacePack).mockResolvedValue({ executable: worker, model: join(directory, 'unused.xml') })
    const request: ExportRequest = {
      canvas: { width: 64, height: 36, fps: 10, fit: 'contain' }, sources: [], segments: [], overlays: [], outputPath: output
    }
    await encodeWithFaces(request, ['-hide_banner', '-y', '-i', source], {
      graph: '[0:v:0]format=rgb24[video];[0:a:0]anull[aout]', videoLabel: 'video', audioLabel: 'aout'
    }, directory, output, 1, 'metadata-export')

    const metadata = probeMedia(output)
    const serializedMetadata = JSON.stringify(metadata)
    expect(serializedMetadata).not.toContain('PERSONAL')
    expect(metadata.chapters ?? []).toHaveLength(0)
    expect(metadata.streams?.map((stream) => stream.codec_type)).toEqual(['video', 'audio'])
    expect(execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ]).length).toBe(64 * 36 * 3 * 10)
    expect(execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', 'pipe:1'
    ]).length).toBeGreaterThan(80_000)
    expect(await readFile(source)).toEqual(sourceBefore)
  }, 20_000)

  it('retries authorization failure with the unprivileged CPU worker and overwrites audio', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-auth-retry-'))
    const log = join(directory, 'worker-args.log')
    const worker = join(directory, 'authorization-worker')
    await writeFile(worker, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
if (process.argv.includes('AUTO')) { process.stdin.resume(); setTimeout(() => process.exit(126), 700) }
else process.stdin.pipe(process.stdout)
`)
    await chmod(worker, 0o755)
    vi.mocked(requireFacePack).mockResolvedValue({ executable: worker, model: join(directory, 'unused.xml') })
    workerMock.build.mockImplementationOnce((pack: { executable: string; model: string }, canvas: { width: number; height: number; fps: number }, effects: string) => ({
      ...autoWorker(pack, canvas, effects), elevated: true
    }))
    const output = join(directory, 'out.mp4')
    const request: ExportRequest = {
      canvas: { width: 64, height: 64, fps: 10, fit: 'contain' }, sources: [], segments: [], overlays: [], outputPath: output,
    }
    const jobsRunSpy = vi.spyOn(jobs, 'run')
    await encodeWithFaces(request, ['-hide_banner'], {
      graph: 'color=c=red:s=64x64:r=10:d=1[video];sine=frequency=880:duration=1[aout]', videoLabel: 'video', audioLabel: 'aout'
    }, directory, output, 1, 'auth-retry')
    const workerArgs = await readFile(log, 'utf8')
    expect(workerArgs).toContain('--device AUTO')
    expect(workerArgs).toContain('--device CPU')
    expect(workerArgs.indexOf('--device AUTO')).toBeLessThan(workerArgs.indexOf('--device CPU'))
    expect(jobsRunSpy.mock.calls.at(-1)?.[5]).toBe('GPU authorization unavailable or declined; using CPU…')
    const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
    expect(execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', 'pipe:1']).length).toBeGreaterThan(80_000)
  }, 15_000)

  it('refreshes the cache session before the CPU authorization retry and commits after mux', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-cache-'))
    const log = join(directory, 'worker-args.log')
    const worker = join(directory, 'cache-worker')
    await writeFile(worker, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
if (process.argv.includes('AUTO')) { process.stdin.resume(); setTimeout(() => process.exit(126), 700) }
else process.stdin.pipe(process.stdout)
`)
    await chmod(worker, 0o755)
    vi.mocked(requireFacePack).mockResolvedValue({ executable: worker, model: join(directory, 'unused.xml') })
    workerMock.build.mockImplementationOnce((pack: { executable: string; model: string }, canvas: { width: number; height: number; fps: number }, effects: string) => ({
      ...autoWorker(pack, canvas, effects), elevated: true
    }))
    const commit = vi.fn(() => Promise.resolve())
    const cleanup = vi.fn(() => Promise.resolve())
    detectionCacheMock.prepare.mockResolvedValue({
      workerArgs: ['--detections-cache', '/tmp/input.cache', '--emit-detections', '--frame-offset', '4'],
      commit,
      cleanup
    })
    const request: ExportRequest = {
      canvas: { width: 64, height: 64, fps: 10, fit: 'contain' }, sources: [], segments: [], overlays: [], outputPath: join(directory, 'out.mp4')
    }
    await encodeWithFaces(request, ['-hide_banner'], {
      graph: 'color=c=red:s=64x64:r=10:d=1[video];sine=frequency=880:duration=1[aout]', videoLabel: 'video', audioLabel: 'aout'
    }, directory, request.outputPath, 1, 'cache-retry', { sourceRequest: request, frameOffset: 4 })
    const workerArgs = await readFile(log, 'utf8')
    expect(workerArgs).toContain('--detections-cache /tmp/input.cache --emit-detections --frame-offset 4')
    expect(workerArgs.match(/--frame-offset 4/g)).toHaveLength(2)
    expect(detectionCacheMock.prepare).toHaveBeenCalledWith(request, 4)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(detectionCacheMock.prepare).toHaveBeenCalledTimes(2)
  }, 15_000)
})
