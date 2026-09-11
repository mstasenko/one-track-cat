import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

const mocks = vi.hoisted(() => ({ requireFacePack: vi.fn(), userData: '' }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => mocks.userData },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./face-pack', () => ({ requireFacePack: mocks.requireFacePack }))

import { encodeWithFaces } from './face-export'
import { clearFaceDetectionCache } from './face-detection-cache'
import { requireFacePack } from './face-pack'

const fixtureEnvironmentVariable = 'otc_FACE_FIXTURE_PATH'
const width = 512
const height = 512
const fps = 2
const duration = 1.5
const frameBytes = width * height * 3

interface Region { x1: number; y1: number; x2: number; y2: number }

function meanLuminance(frame: Buffer, region: Region): number {
  let total = 0
  let count = 0
  for (let y = region.y1; y < region.y2; y += 1) {
    for (let x = region.x1; x < region.x2; x += 1) {
      const offset = (y * width + x) * 3
      total += (frame[offset] ?? 0) + (frame[offset + 1] ?? 0) + (frame[offset + 2] ?? 0)
      count += 3
    }
  }
  return total / Math.max(1, count)
}

function meanDifference(left: Buffer, right: Buffer, regions: Region[]): number {
  let total = 0
  let count = 0
  for (const region of regions) {
    for (let y = region.y1; y < region.y2; y += 1) {
      for (let x = region.x1; x < region.x2; x += 1) {
        const offset = (y * width + x) * 3
        for (let channel = 0; channel < 3; channel += 1) {
          total += Math.abs((left[offset + channel] ?? 0) - (right[offset + channel] ?? 0))
          count += 1
        }
      }
    }
  }
  return total / Math.max(1, count)
}

function decodedFrames(path: string, count = 3): Buffer[] {
  const raw = execFileSync(join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0', '-frames:v', String(count),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ], { maxBuffer: frameBytes * (count + 1) })
  expect(raw.length).toBe(frameBytes * count)
  return Array.from({ length: count }, (_, index) => raw.subarray(index * frameBytes, (index + 1) * frameBytes))
}

function frameAt(frames: Buffer[], index: number): Buffer {
  const frame = frames[index]
  if (!frame) throw new Error(`decoded frame ${index} is missing`)
  return frame
}

afterEach(() => {
  vi.unstubAllEnvs()
  clearFaceDetectionCache()
  mocks.userData = ''
  vi.clearAllMocks()
})

describe.skipIf(process.env.otc_FACE_PACK_TEST !== '1')('real CPU face export pipeline', () => {
  it('masks the known astronaut face across active frames and preserves audio', async () => {
    const fixture = process.env[fixtureEnvironmentVariable]
    if (!fixture) throw new Error(`${fixtureEnvironmentVariable} must point to the cached NASA astronaut PPM fixture`)
    const directory = await mkdtemp(join(tmpdir(), 'otc-face-export-real-'))
    try {
      vi.stubEnv('otc_CPU_ONLY', '1')
      const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
      const input = join(directory, 'input.mp4')
      const output = join(directory, 'output.mp4')
      const packDirectory = join(process.cwd(), 'dist', 'face-pack')
      vi.mocked(requireFacePack).mockResolvedValue({
        executable: join(packDirectory, 'otc-face-blur'),
        model: join(packDirectory, 'model.xml')
      })
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-hwaccel', 'none', '-y',
        '-loop', '1', '-framerate', String(fps), '-i', fixture,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5',
        '-frames:v', '3', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-shortest', input
      ])

      const request: ExportRequest = {
        canvas: { width, height, fps, fit: 'contain' },
        sources: [], segments: [], overlays: [], outputPath: output,
        faceBlurs: [{
          id: 'astronaut-face', start: 0.5, duration: 1, sensitivity: 0.7,
          detail: 'standard', holdSeconds: 0, strength: 1, style: 'mask'
        }]
      }
      await encodeWithFaces(request, ['-hide_banner', '-y', '-i', input], {
        graph: '[0:v:0]format=rgb24[vout];[0:a:0]anull[aout]', videoLabel: 'vout', audioLabel: 'aout'
      }, directory, output, duration, 'real-face-export')

      const frames = decodedFrames(output)
      const audio = execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', 'pipe:1'
      ], { maxBuffer: 4 * 1024 * 1024 })
      expect(audio.length).toBeGreaterThan(20_000)

      const knownFace = { x1: 177, y1: 65, x2: 275, y2: 177 }
      const faceCore = { x1: 200, y1: 90, x2: 252, y2: 150 }
      const first = frameAt(frames, 0)
      const second = frameAt(frames, 1)
      const third = frameAt(frames, 2)
      expect(meanLuminance(first, knownFace)).toBeGreaterThan(40)
      expect(meanLuminance(second, faceCore)).toBeLessThan(25)
      expect(meanLuminance(third, faceCore)).toBeLessThan(25)

      const outsideFace = [
        { x1: 0, y1: 0, x2: 160, y2: height },
        { x1: 300, y1: 0, x2: width, y2: height }
      ]
      expect(meanDifference(first, second, outsideFace)).toBeLessThan(18)
      expect(meanDifference(first, third, outsideFace)).toBeLessThan(18)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('reuses selected-range detections in a full export while retaining masking and audio', async () => {
    const fixture = process.env[fixtureEnvironmentVariable]
    if (!fixture) throw new Error(`${fixtureEnvironmentVariable} must point to the cached NASA astronaut PPM fixture`)
    const directory = await mkdtemp(join(tmpdir(), 'otc-face-export-cache-real-'))
    try {
      vi.stubEnv('otc_CPU_ONLY', '1')
      mocks.userData = directory
      const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
      const input = join(directory, 'input.mp4')
      const packDirectory = join(process.cwd(), 'dist', 'face-pack')
      vi.mocked(requireFacePack).mockResolvedValue({
        executable: join(packDirectory, 'otc-face-blur'),
        model: join(packDirectory, 'model.xml')
      })
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-hwaccel', 'none', '-y',
        '-loop', '1', '-framerate', String(fps), '-i', fixture,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5',
        '-frames:v', '3', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-shortest', input
      ])
      const inputStamp = await stat(input)
      const effect = {
        id: 'astronaut-face', start: 0, duration, sensitivity: 0.7,
        detail: 'standard' as const, holdSeconds: 0, strength: 1, style: 'mask' as const
      }
      const request: ExportRequest = {
        canvas: { width, height, fps, fit: 'contain' },
        sources: [{ id: 'source', metadata: {
          path: input, name: 'input.mp4', size: inputStamp.size, modifiedAt: inputStamp.mtimeMs,
          duration, width, height, fps, videoCodec: 'h264', hasAudio: true
        } }],
        segments: [], overlays: [], outputPath: join(directory, 'full.mp4'), faceBlurs: [effect]
      }
      const inputArgs = ['-hide_banner', '-y', '-i', input]
      const fullFilter = {
        graph: '[0:v:0]format=rgb24[vout];[0:a:0]anull[aout]', videoLabel: 'vout', audioLabel: 'aout'
      }
      const selectedFilter = {
        graph: '[0:v:0]trim=start=0.5:end=1.0,setpts=PTS-STARTPTS,format=rgb24[vout];' +
          '[0:a:0]atrim=start=0.5:end=1.0,asetpts=PTS-STARTPTS[aout]', videoLabel: 'vout', audioLabel: 'aout'
      }
      const selectedRequest: ExportRequest = {
        ...request, outputPath: join(directory, 'selected.mp4'), faceBlurs: [{ ...effect, start: 0, duration: 0.5 }]
      }
      await encodeWithFaces(
        selectedRequest, inputArgs, selectedFilter, directory, selectedRequest.outputPath, 0.5, 'real-face-selected',
        { sourceRequest: request, frameOffset: 1 }
      )

      const cachePath = join(directory, 'face-preview', 'detections.cache')
      const selectedCache = await readFile(cachePath, 'utf8')
      expect(selectedCache.match(/^RCFACE1 /gm)).toHaveLength(1)
      expect(selectedCache).toMatch(/^RCFACE1 1 1 /m)
      const selectedFrame = frameAt(decodedFrames(selectedRequest.outputPath, 1), 0)
      expect(meanLuminance(selectedFrame, { x1: 200, y1: 90, x2: 252, y2: 150 })).toBeLessThan(25)
      const selectedAudio = execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', selectedRequest.outputPath, '-map', '0:a:0', '-f', 's16le', 'pipe:1'
      ], { maxBuffer: 2 * 1024 * 1024 })
      expect(selectedAudio.length).toBeGreaterThan(5_000)

      await encodeWithFaces(request, inputArgs, fullFilter, directory, request.outputPath, duration, 'real-face-full', {
        sourceRequest: request, frameOffset: 0
      })
      const mergedCache = await readFile(cachePath, 'utf8')
      expect(mergedCache.match(/^RCFACE1 /gm)).toHaveLength(3)
      expect(mergedCache).toMatch(/^RCFACE1 0 1 /m)
      expect(mergedCache).toMatch(/^RCFACE1 1 1 /m)
      expect(mergedCache).toMatch(/^RCFACE1 2 1 /m)
      const fullFrames = decodedFrames(request.outputPath)
      for (const frame of fullFrames) {
        expect(meanLuminance(frame, { x1: 200, y1: 90, x2: 252, y2: 150 })).toBeLessThan(25)
      }
      const fullAudio = execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', request.outputPath, '-map', '0:a:0', '-f', 's16le', 'pipe:1'
      ], { maxBuffer: 4 * 1024 * 1024 })
      expect(fullAudio.length).toBeGreaterThan(20_000)

      const invalidModel = join(directory, 'invalid-model.xml')
      await writeFile(invalidModel, 'not an OpenVINO model\n')
      vi.mocked(requireFacePack).mockResolvedValue({ executable: join(packDirectory, 'otc-face-blur'), model: invalidModel })
      const reusedOutput = join(directory, 'reused.mp4')
      await encodeWithFaces(request, inputArgs, fullFilter, directory, reusedOutput, duration, 'real-face-reused', {
        sourceRequest: request, frameOffset: 0
      })
      const reusedFrames = decodedFrames(reusedOutput)
      expect(reusedFrames).toHaveLength(3)
      expect(meanLuminance(frameAt(reusedFrames, 1), { x1: 200, y1: 90, x2: 252, y2: 150 })).toBeLessThan(25)
      const reusedAudio = execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', reusedOutput, '-map', '0:a:0', '-f', 's16le', 'pipe:1'
      ], { maxBuffer: 4 * 1024 * 1024 })
      expect(reusedAudio.length).toBeGreaterThan(20_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
