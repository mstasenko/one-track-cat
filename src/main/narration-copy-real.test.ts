import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { narrationCopyArgs } from './narration-copy'

const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
it('preserves every encoded video packet when only narration changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otc-narration-copy-'))
  try {
    const input = join(directory, 'original.mp4')
    const audio = join(directory, 'new.wav')
    const output = join(directory, 'export.mp4')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', input])
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', audio])
    const args = narrationCopyArgs({ canvas: { width: 128, height: 72, fps: 24, fit: 'contain' }, outputPath: output,
      segments: [{ id: 'v', sourceId: 's', sourceStart: 0, sourceEnd: 2 }], sources: [{ id: 's', metadata: {
        path: input, name: 'original', size: 1, modifiedAt: 1, width: 128, height: 72, fps: 24, duration: 2, videoCodec: 'h264', hasAudio: true } }],
      overlays: [{ id: 'n', name: 'AI Narration', type: 'audio', path: audio, sourceIn: 0, start: 0.5, duration: 1, volume: 1,
        zIndex: 0, narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true } }] }, output)
    if (!args) throw new Error('Stream-copy path unavailable')
    execFileSync(ffmpeg, args)
    const packetHash = (path: string): string => execFileSync(ffmpeg, ['-v', 'error', '-i', path,
      '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1'], { encoding: 'utf8' })
    expect(packetHash(output)).toBe(packetHash(input))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
