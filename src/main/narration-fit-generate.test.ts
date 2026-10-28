import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { NarrationDraft } from './narration-analysis'
import type { NarrationWorker } from './narration-worker'
import { generateNarrationAudio } from './narration-generate'

vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')

it('cleans a verified model tail before requiring shorter text and retains the fixed window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otc-fit-generation-'))
  try {
    const speechPath = join(directory, 'speech.wav'), backgroundPath = join(directory, 'background.wav')
    for (const path of [speechPath, backgroundPath]) execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi',
      '-i', 'aevalsrc=0.02:s=48000:d=2', '-c:a', 'pcm_f32le', path])
    const phrase = { id: 'p', start: 0, end: 2, text: 'The tool works.', revisedText: 'The tool works.', needsTimingReview: false }
    const draft: NarrationDraft = { contentKey: 'test', range: [0, 2], language: 'en', strength: 'balanced',
      originalPath: speechPath, speechPath, backgroundPath, phrases: [phrase], approved: true }
    const request = vi.fn((value: Record<string, unknown>): Promise<unknown> => {
      if (value.action === 'transcribe') return Promise.resolve([
        { start: 0.1, end: 0.3, text: 'The' }, { start: 0.3, end: 0.5, text: 'tool' },
        { start: 0.5, end: 0.8, text: 'works.' }
      ])
      for (const item of value.phrases as { output: string }[]) execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi',
        '-i', 'aevalsrc=0.1:s=48000:d=3.5', '-af', "volume=0:enable='between(t,1.1,2)'", '-c:a', 'pcm_f32le', item.output])
      return Promise.resolve([3.5])
    })
    const output = await generateNarrationAudio(draft, directory, { request } as unknown as NarrationWorker, new AbortController().signal)
    expect(request.mock.calls.map(([value]) => value.action)).toEqual(['synthesize', 'transcribe', 'transcribe'])
    expect(draft.phrases).toEqual([phrase])
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-ac', '2', '-f', 'f32le', '-'])
    expect(pcm.length).toBe(2 * 48_000 * 8)
    expect(pcm.readFloatLE(48_000 * 8)).toBeGreaterThan(0.05)
    expect(pcm.readFloatLE(72_000 * 8)).toBeCloseTo(0.02 * Math.SQRT1_2, 5)
    expect((await readdir(directory)).some((name) => name.startsWith('narration-fit-'))).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
