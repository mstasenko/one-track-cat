import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExportRequest, FaceBlurEffect } from '../types'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { buildFilterGraph } from './exporter'
import { faceEffectRows } from './face-export'
import { ffmpegPath } from './binaries'
import { requireFacePack } from './face-pack'
import { replaceFaceBlurRange } from '../renderer/src/model/face-blur'

const width = 64
const height = 48
const fps = 4
const sourceFrameCount = 4
const timelineFrameCount = 12
const frameBytes = width * height * 3
const faceRegion = { x1: 20, y1: 16, x2: 44, y2: 36 }
const outsideRegions = [
  { x1: 0, y1: 0, x2: width, y2: 4 },
  { x1: 0, y1: 47, x2: width, y2: height },
  { x1: 0, y1: 4, x2: 4, y2: 47 },
  { x1: 60, y1: 4, x2: width, y2: 47 }
]
const ffmpeg = ffmpegPath()

type Region = typeof faceRegion

function checkedFfmpeg(args: string[], input?: Buffer): Buffer {
  return execFileSync(ffmpeg, args, {
    input,
    maxBuffer: frameBytes * (timelineFrameCount + 2) + 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
}

function syntheticSourceFrames(): Buffer {
  const frames: Buffer[] = []
  for (let frameIndex = 0; frameIndex < sourceFrameCount; frameIndex += 1) {
    const frame = Buffer.alloc(frameBytes, 24)
    for (let y = faceRegion.y1; y < faceRegion.y2; y += 1) {
      for (let x = faceRegion.x1; x < faceRegion.x2; x += 1) {
        const offset = (y * width + x) * 3
        const bright = (x + y + frameIndex) % 2 === 0
        frame[offset] = bright ? 240 : 24
        frame[offset + 1] = bright ? 32 : 220
        frame[offset + 2] = bright ? 32 : 48
      }
    }
    const markerLeft = 2 + frameIndex * 3
    for (let y = 2; y < 8; y += 1) {
      for (let x = markerLeft; x < markerLeft + 3; x += 1) {
        const offset = (y * width + x) * 3
        frame[offset] = 250
        frame[offset + 1] = 250
        frame[offset + 2] = 250
      }
    }
    frames.push(frame)
  }
  return Buffer.concat(frames)
}

function frames(raw: Buffer, count: number): Buffer[] {
  expect(raw.length).toBe(frameBytes * count)
  return Array.from({ length: count }, (_, index) => raw.subarray(index * frameBytes, (index + 1) * frameBytes))
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

function markerCenter(frame: Buffer): number | undefined {
  let weighted = 0
  let weight = 0
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const offset = (y * width + x) * 3
      const luma = ((frame[offset] ?? 0) + (frame[offset + 1] ?? 0) + (frame[offset + 2] ?? 0)) / 3
      if (luma < 160) continue
      weighted += x * luma
      weight += luma
    }
  }
  return weight > 0 ? weighted / weight : undefined
}

function sourceRequest(sourcePath: string): ExportRequest {
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [{ id: 'source', metadata: {
      path: sourcePath, name: 'synthetic-replay.mp4', size: 1, modifiedAt: 1,
      duration: sourceFrameCount / fps, width, height, fps, videoCodec: 'h264', hasAudio: false
    } }],
    segments: [
      { id: 'original', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
      { id: 'replay', sourceId: 'source', sourceStart: 0, sourceEnd: 1, playbackRate: 0.5, replayGroupId: 'replay-one' }
    ],
    overlays: [],
    outputPath: join(tmpdir(), 'unused-face-combination.mp4')
  }
}

function renderGraph(sourcePath: string, filter: ReturnType<typeof buildFilterGraph>): Buffer[] {
  const raw = checkedFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    '-filter_complex_threads', '1', '-i', sourcePath, '-filter_complex',
    `${filter.graph};[${filter.audioLabel}]anullsink`,
    '-map', `[${filter.videoLabel}]`, '-an', '-frames:v', String(timelineFrameCount),
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'
  ])
  return frames(raw, timelineFrameCount)
}

function runCachedWorker(
  executable: string,
  model: string,
  effectsPath: string,
  cachePath: string,
  input: Buffer
): { frames: Buffer[]; stderr: string } {
  const result = spawnSync(executable, [
    '--model', model, '--width', String(width), '--height', String(height), '--fps', String(fps),
    '--effects', effectsPath, '--device', 'CPU', '--detections-cache', cachePath
  ], {
    input,
    maxBuffer: frameBytes * (timelineFrameCount + 2) + 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
  if (result.error) throw result.error
  const stderr = result.stderr.toString('utf8')
  if (result.status !== 0) throw new Error(`cached face worker failed: ${stderr}`)
  return { frames: frames(result.stdout, timelineFrameCount), stderr }
}

describe.skipIf(process.env.otc_FACE_PACK_TEST !== '1')('real CPU face/replay composition', () => {
  it.each(['pixelate', 'blur', 'mask'] as const)('preserves replay motion and masks cached faces for %s', async (style) => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-face-combination-real-'))
    try {
      const sourcePath = join(directory, 'source.mp4')
      const effectsPath = join(directory, 'effects.tsv')
      const cachePath = join(directory, 'detections.cache')
      const rawSource = syntheticSourceFrames()
      checkedFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-f', 'rawvideo',
        '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-framerate', String(fps),
        '-i', 'pipe:0', '-frames:v', String(sourceFrameCount), '-an', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-pix_fmt', 'yuv444p', sourcePath
      ], rawSource)

      const request = sourceRequest(sourcePath)
      const filter = buildFilterGraph(request, [])
      expect(filter.graph).toContain('setpts=(PTS-STARTPTS)/0.5')
      const baseline = renderGraph(sourcePath, filter)
      expect(baseline).toHaveLength(timelineFrameCount)

      const centers = baseline.map(markerCenter)
      for (let index = 0; index < 4; index += 1) {
        const original = centers[index]
        const replayFirst = centers[4 + index * 2]
        const replaySecond = centers[5 + index * 2]
        expect(original).toBeDefined()
        expect(replayFirst).toBeCloseTo(original ?? 0, 1)
        expect(replaySecond).toBeCloseTo(original ?? 0, 1)
      }
      expect(centers[0]).toBeLessThan(centers[1] ?? Number.POSITIVE_INFINITY)
      expect(centers[1]).toBeLessThan(centers[2] ?? Number.POSITIVE_INFINITY)
      expect(centers[2]).toBeLessThan(centers[3] ?? Number.POSITIVE_INFINITY)

      const effect: FaceBlurEffect = {
        id: 'synthetic-face', start: 0.25, duration: 2.25, sensitivity: 0.7,
        detail: 'standard', holdSeconds: 0, strength: 1, style
      }
      await writeFile(effectsPath, faceEffectRows([effect]))
      await writeFile(cachePath, Array.from({ length: timelineFrameCount }, (_, frame) =>
        `RCFACE1 ${frame} 1 20 16 44 36 1\n`
      ).join(''))

      const pack = await requireFacePack(join(process.cwd(), 'dist', 'face-pack'))
      const worker = runCachedWorker(pack.executable, pack.model, effectsPath, cachePath, Buffer.concat(baseline))
      expect(worker.stderr).toContain('mode=cached render=CPU')
      expect(worker.stderr).not.toContain('mode=inference')
      expect(worker.stderr).not.toContain('device=')
      expect(worker.frames).toHaveLength(timelineFrameCount)

      for (const index of [0, 10, 11]) {
        const input = baseline[index]
        const output = worker.frames[index]
        if (!input || !output) throw new Error(`missing inactive frame ${index}`)
        expect(output.equals(input)).toBe(true)
      }
      for (let index = 1; index <= 9; index += 1) {
        const input = baseline[index]
        const output = worker.frames[index]
        if (!input || !output) throw new Error(`missing active frame ${index}`)
        expect(meanDifference(input, output, outsideRegions)).toBe(0)
        expect(meanDifference(input, output, [faceRegion])).toBeGreaterThan(1)
        expect(markerCenter(output)).toBeCloseTo(markerCenter(input) ?? 0, 1)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('applies face blur only to a later replay range', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-face-replay-range-real-'))
    try {
      const sourcePath = join(directory, 'source.mp4')
      const effectsPath = join(directory, 'effects.tsv')
      const cachePath = join(directory, 'detections.cache')
      checkedFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-f', 'rawvideo',
        '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-framerate', String(fps),
        '-i', 'pipe:0', '-frames:v', String(sourceFrameCount), '-an', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-pix_fmt', 'yuv444p', sourcePath
      ], syntheticSourceFrames())

      const request = sourceRequest(sourcePath)
      expect(request.segments[1]?.replayGroupId).toBe('replay-one')
      const filter = buildFilterGraph(request, [])
      const baseline = renderGraph(sourcePath, filter)
      const replayOnlyEffects = replaceFaceBlurRange([], 1.25, 2.75, {
        sensitivity: 0.7, detail: 'standard', holdSeconds: 0, strength: 1, style: 'blur'
      })
      expect(replayOnlyEffects.map(({ start, duration }) => ({ start, duration }))).toEqual([
        { start: 1.25, duration: 1.5 }
      ])
      await writeFile(effectsPath, faceEffectRows(replayOnlyEffects))
      await writeFile(cachePath, Array.from({ length: timelineFrameCount }, (_, frame) =>
        `RCFACE1 ${frame} 1 20 16 44 36 1\n`
      ).join(''))

      const pack = await requireFacePack(join(process.cwd(), 'dist', 'face-pack'))
      const worker = runCachedWorker(pack.executable, pack.model, effectsPath, cachePath, Buffer.concat(baseline))
      expect(worker.stderr).toContain('mode=cached render=CPU')
      expect(worker.stderr).not.toContain('mode=inference')
      expect(worker.frames).toHaveLength(timelineFrameCount)

      for (const index of [0, 1, 2, 3, 4, 11]) {
        const input = baseline[index]
        const output = worker.frames[index]
        if (!input || !output) throw new Error(`missing inactive replay-range frame ${index}`)
        expect(output.equals(input)).toBe(true)
      }
      for (const index of [5, 6, 7, 8, 9, 10]) {
        const input = baseline[index]
        const output = worker.frames[index]
        if (!input || !output) throw new Error(`missing active replay-range frame ${index}`)
        expect(meanDifference(input, output, outsideRegions)).toBe(0)
        expect(meanDifference(input, output, [faceRegion])).toBeGreaterThan(1)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
