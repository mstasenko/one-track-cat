import { once } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { spawnFaceProcess, type FaceProcess } from './face-process-stream'

type SourceProcess = ChildProcessByStdio<null, Readable, Readable>

const sourceProcess = (script: string): SourceProcess => spawn(process.execPath, ['-e', script], {
  stdio: ['ignore', 'pipe', 'pipe']
})

const close = (child: FaceProcess | SourceProcess): Promise<[number | null, NodeJS.Signals | null]> =>
  once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>

const directWorker = (script: string, source: SourceProcess): FaceProcess =>
  spawnFaceProcess(process.execPath, ['-e', script], undefined, source.stdout)

describe('Direct decoder stream ownership', () => {
  it('preserves a large ordered byte stream and closes both processes', async () => {
    const byteCount = 8 * 1024 * 1024
    const source = sourceProcess([
      `const total = ${byteCount}`,
      'let offset = 0',
      'function write() {',
      '  while (offset < total) {',
      '    const length = Math.min(64 * 1024, total - offset)',
      '    const chunk = Buffer.allocUnsafe(length)',
      '    for (let index = 0; index < length; index += 1) chunk[index] = (offset + index) % 251',
      '    offset += length',
      '    if (!process.stdout.write(chunk)) { process.stdout.once("drain", write); return }',
      '  }',
      '  process.stdout.end()',
      '}',
      'write()'
    ].join(';'))
    const worker = directWorker([
      'const chunks = []',
      'process.stdin.on("data", (chunk) => chunks.push(chunk))',
      'process.stdin.on("end", () => process.stdout.end(Buffer.concat(chunks)))'
    ].join(';'), source)
    const output = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      worker.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      worker.stdout.once('end', () => resolve(Buffer.concat(chunks)))
      worker.stdout.once('error', reject)
    })
    const sourceClosed = close(source)
    const workerClosed = close(worker)
    expect(worker.stdin).toBeNull()
    expect(source.stdout.destroyed).toBe(true)
    const expected = Buffer.allocUnsafe(byteCount)
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251
    const actual = await output
    expect(actual.equals(expected)).toBe(true)
    await expect(sourceClosed).resolves.toEqual([0, null])
    await expect(workerClosed).resolves.toEqual([0, null])
  }, 10000)

  it('propagates cooperative source EOF through the duplicated descriptor', async () => {
    const source = sourceProcess([
      'let stopped = false',
      'const timer = setInterval(() => { if (!stopped) process.stdout.write(Buffer.alloc(64 * 1024)) }, 1)',
      'process.stdout.on("error", () => process.exit(0))',
      'process.on("SIGINT", () => { stopped = true; clearInterval(timer); process.stdout.end(() => process.exit(0)) })',
      'process.stderr.write("ready\\n")'
    ].join(';'))
    const worker = directWorker([
      'process.stdin.resume()',
      'process.stdin.on("end", () => process.stdout.end("EOF"))'
    ].join(';'), source)
    const output = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      worker.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      worker.stdout.once('end', () => resolve(Buffer.concat(chunks)))
      worker.stdout.once('error', reject)
    })
    const sourceClosed = close(source)
    const workerClosed = close(worker)
    await once(source.stderr, 'data')
    source.kill('SIGINT')
    await expect(output).resolves.toEqual(Buffer.from('EOF'))
    await expect(sourceClosed).resolves.toEqual([0, null])
    await expect(workerClosed).resolves.toEqual([0, null])
  }, 5000)

  it('does not orphan the producer when the direct consumer exits early', async () => {
    const source = sourceProcess([
      'const timer = setInterval(() => process.stdout.write(Buffer.alloc(64 * 1024)), 1)',
      'process.stdout.on("error", () => { clearInterval(timer); process.exit(0) })'
    ].join(';'))
    const worker = directWorker('process.exit(23)', source)
    const sourceClosed = close(source)
    const workerClosed = close(worker)
    const [sourceExit, workerExit] = await Promise.all([sourceClosed, workerClosed])
    expect(sourceExit).toEqual([0, null])
    expect(workerExit).toEqual([23, null])
  }, 5000)
})
