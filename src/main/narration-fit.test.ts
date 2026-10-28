import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NarrationWorker } from './narration-worker'
import { fitNarrationTail } from './narration-fit'

vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
let directory: string

function source(path: string, duration: number, quietEnd = 2.2): void {
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    `aevalsrc=if(lt(t\\,1.2)\\,0.2\\,if(gt(t\\,${quietEnd})\\,0.15\\,0)):s=48000:d=${duration}`,
    '-ac', '1', '-c:a', 'pcm_f32le', path])
}

const phrase = { id: 'phrase', revisedText: 'The medicine is ready', generatedDuration: 3.68 }
const words = [
  { start: 0.1, end: 0.3, text: 'The' },
  { start: 0.35, end: 0.7, text: 'medicine' },
  { start: 0.75, end: 0.9, text: 'is' },
  { start: 0.95, end: 1.2, text: 'ready' }
]

function worker(result: unknown, onRequest?: (value: Record<string, unknown>) => void): NarrationWorker {
  const request = vi.fn((value: Record<string, unknown>): Promise<unknown> => {
    onRequest?.(value)
    if (value.action !== 'transcribe') throw new Error('Unexpected narration action')
    return Promise.resolve(result)
  })
  return { request } as unknown as NarrationWorker
}

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'otc-narration-fit-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

// Each case starts real FFmpeg processes; allow for parallel-suite CPU contention.
describe('narration overrun fitting', { timeout: 15_000 }, () => {
  it('does not shorten intentionally requested pauses to fit a selection', async () => {
    const called = vi.fn()
    const voice = worker(words, called)
    expect(await fitNarrationTail({ ...phrase, output: '/unused.wav', revisedText: 'Keep this. [2s] Then continue.' },
      directory, voice, new AbortController().signal)).toBeUndefined()
    expect(called).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  it('publishes a shorter checked prefix after a matched quiet tail without changing the source cache', async () => {
    const output = join(directory, 'utterance.wav')
    source(output, phrase.generatedDuration)
    const original = await readFile(output)
    const result = await fitNarrationTail({ ...phrase, output }, directory, worker(words), new AbortController().signal)
    expect(result).toBeDefined()
    if (!result) throw new Error('Missing fitted narration')
    expect(result.output).not.toBe(output)
    expect(result.generatedDuration).toBeGreaterThan(1.2)
    expect(result.generatedDuration).toBeLessThan(2)
    expect(await readFile(output)).toEqual(original)
    expect((await stat(result.output)).size).toBeGreaterThan(44)
    expect((await readdir(directory)).filter((name) => name.endsWith('.f32le') || name.endsWith('.tmp.wav'))).toEqual([])
  })

  it('leaves a continuous overrun unfitted when no quiet tail is verified', async () => {
    const output = join(directory, 'continuous.wav')
    source(output, phrase.generatedDuration, 0)
    const original = await readFile(output)
    const result = await fitNarrationTail({ ...phrase, output }, directory, worker(words), new AbortController().signal)
    expect(result).toBeUndefined()
    expect(await readFile(output)).toEqual(original)
    expect((await readdir(directory)).filter((name) => name.includes('checked') || name.endsWith('.f32le'))).toEqual([])
  })

  it('skips an unaligned transcript and cleans temporary files', async () => {
    const output = join(directory, 'missing-match.wav')
    source(output, phrase.generatedDuration)
    const result = await fitNarrationTail({ ...phrase, output }, directory, worker([
      { start: 0.1, end: 0.3, text: 'A different sentence.' }
    ]), new AbortController().signal)
    expect(result).toBeUndefined()
    expect((await readdir(directory)).filter((name) => name.includes('narration-fit-'))).toEqual([])
    expect(existsSync(output)).toBe(true)
  })

  it('cleans all temporary files when cancelled after ASR', async () => {
    const output = join(directory, 'cancelled.wav')
    source(output, phrase.generatedDuration)
    const controller = new AbortController()
    const result = await fitNarrationTail({ ...phrase, output }, directory,
      worker(words, (value) => { if (value.action === 'transcribe') controller.abort() }), controller.signal)
      .catch((error: unknown) => error)
    expect(result).toHaveProperty('name', 'AbortError')
    expect((await readdir(directory)).filter((name) => name.includes('narration-fit-'))).toEqual([])
    expect(existsSync(output)).toBe(true)
  })
})
