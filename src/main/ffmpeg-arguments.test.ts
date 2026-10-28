import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { JobManager } from './jobs'
import { prepareFfmpegArguments } from './ffmpeg-arguments'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')

async function withScratch<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'otc-ffmpeg-arguments-'))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function graphOfBytes(bytes: number): string {
  const fixed = '[0:v]null[v]'
  const padding = bytes - Buffer.byteLength(fixed)
  if (padding <= 0) throw new Error('graph target is too small')
  return `[0:v]${' '.repeat(padding)}null[v]`
}

function ffmpegArguments(graph: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    '-f', 'lavfi', '-i', 'color=size=16x16:rate=1:duration=1',
    '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'null', '-'
  ]
}

async function runJob(args: string[]): Promise<void> {
  const manager = new JobManager()
  try {
    await manager.run(ffmpeg, args, 'export', 1, undefined, '', { announce: false })
  } finally {
    await manager.shutdown()
  }
}

function scriptPath(args: string[]): string {
  const index = args.indexOf('-filter_complex_script')
  const path = index >= 0 ? args[index + 1] : undefined
  if (!path) throw new Error('prepared arguments do not contain a filter script path')
  return path
}

describe('prepareFfmpegArguments', () => {
  it('leaves a short filter graph and its argument list unchanged', async () => {
    await withScratch(async (directory) => {
      const args = ffmpegArguments('[0:v]null[v]')
      const before = await readdir(directory)

      await expect(prepareFfmpegArguments(args, directory)).resolves.toEqual(args)

      expect(await readdir(directory)).toEqual(before)
    })
  })

  it('uses UTF-8 byte length for a graph containing multibyte text', async () => {
    await withScratch(async (directory) => {
      const unicode = '😀'.repeat(8_192)
      const graph = `[0:v]null,metadata=mode=add:key=note:value=${unicode}[v]`
      expect(graph.length).toBeLessThan(32 * 1024)
      expect(Buffer.byteLength(graph)).toBeGreaterThan(32 * 1024)

      const prepared = await prepareFfmpegArguments(ffmpegArguments(graph), directory)
      const path = scriptPath(prepared)

      expect(resolve(dirname(path))).toBe(resolve(directory))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await readFile(path, 'utf8')).toBe(graph)

      // The caller owns cleanup of the generated argument file.
      await rm(path)
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('avoids argv E2BIG for a real CPU FFmpeg job and leaves cleanup to its caller', async () => {
    await withScratch(async (directory) => {
      const graph = graphOfBytes(140 * 1024)
      const args = ffmpegArguments(graph)
      const failure = await runJob(args).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'E2BIG' })

      const prepared = await prepareFfmpegArguments(args, directory)
      const path = scriptPath(prepared)
      expect(prepared).not.toContain('-filter_complex')
      expect(prepared).toContain('-filter_complex_script')
      expect(await readFile(path, 'utf8')).toBe(graph)
      expect((await stat(path)).mode & 0o777).toBe(0o600)

      await expect(runJob(prepared)).resolves.toBeUndefined()
      await expect(access(path)).resolves.toBeUndefined()

      // The job caller removes the script after FFmpeg exits.
      await rm(path)
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }, 30_000)
})
