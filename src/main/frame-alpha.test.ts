import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from './binaries'
import { frameAlphaFilter } from './frame-alpha'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

describe('frame-evaluated overlay alpha', () => {
  it('uses a constant multiplier when there is no opacity animation', () => {
    expect(frameAlphaFilter('overlay0', 0.6, '1')).toBe('colorchannelmixer=aa=0.6')
  })

  it('preserves RGB and existing transparency while updating every frame', () => {
    const result = spawnSync(ffmpegPath(), [
      '-v', 'error', '-filter_threads', '1', '-f', 'lavfi',
      '-i', 'color=c=red@0.5:s=16x16:r=10:d=1,format=rgba',
      '-vf', frameAlphaFilter('overlay0', 0.8, 'min(1,T*2)'),
      '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
    ])
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(result.stdout.length).toBe(10 * 16 * 16 * 4)
    for (let frame = 0; frame < 10; frame += 1) {
      const offset = frame * 16 * 16 * 4
      expect([...result.stdout.subarray(offset, offset + 3)]).toEqual([255, 0, 0])
      expect(Math.abs((result.stdout[offset + 3] ?? -1) - Math.round(127 * 0.8 * Math.min(1, frame / 5)))).toBeLessThanOrEqual(1)
    }
  })
})
