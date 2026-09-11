import { open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Readable } from 'node:stream'

export const detectionCacheMaximumBytes = 64 * 1024 * 1024

const maximumLineBytes = 64 * 1024

function recordFrameRange(line: string, ranges: [number, number][]): boolean {
  const fields = line.trim().split(/\s+/)
  const frame = Number(fields[1])
  const count = Number(fields[2])
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= Number.MAX_SAFE_INTEGER
    || !Number.isInteger(count) || count < 0 || count > 256 || fields.length !== 3 + count * 5) return false
  const previous = ranges.at(-1)
  if (previous && frame < previous[1]) return false
  if (previous && frame === previous[1]) previous[1] = frame + 1
  else {
    // Keep this optional optimization bounded even for an unusually fragmented cache.
    if (ranges.length >= 1024) return false
    ranges.push([frame, frame + 1])
  }
  return true
}

async function writeBuffer(handle: FileHandle, value: Buffer): Promise<void> {
  let offset = 0
  while (offset < value.length) {
    const result = await handle.write(value, offset)
    if (result.bytesWritten <= 0) throw new Error('Detection cache write made no progress')
    offset += result.bytesWritten
  }
}

function drain(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed || stream.closed || !stream.readable) {
      resolve()
      return
    }
    const finish = (): void => {
      stream.removeListener('end', finish)
      stream.removeListener('close', finish)
      stream.removeListener('error', finish)
      resolve()
    }
    stream.once('end', finish)
    stream.once('close', finish)
    stream.once('error', finish)
    stream.resume()
  })
}

export async function captureCacheStream(
  stream: Readable,
  outputPath: string,
  onComplete: (usable: boolean, ranges: [number, number][]) => void
): Promise<void> {
  let handle: FileHandle | undefined
  let usable = true
  let bytes = 0
  let carry = ''
  let discardLongLine = false
  const frameRanges: [number, number][] = []
  let coverageUsable = true
  try {
    // Stop a flowing stderr source while opening the per-attempt output file. The iterator
    // below is deliberately non-destroying so an optional cache write cannot SIGPIPE the worker.
    stream.pause()
    handle = await open(outputPath, 'w', 0o600)
    const iterator = stream.iterator({ destroyOnReturn: false })
    for await (const chunk of iterator) {
      const text = carry + String(chunk)
      let start = 0
      let end = text.indexOf('\n', start)
      while (end >= 0) {
        if (!discardLongLine) {
          let line = text.slice(start, end)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line.startsWith('RCFACE1 ')) {
            const row = Buffer.from(`${line}\n`)
            if (row.length > maximumLineBytes || bytes + row.length > detectionCacheMaximumBytes) usable = false
            else {
              await writeBuffer(handle, row)
              bytes += row.length
              coverageUsable = coverageUsable && recordFrameRange(line, frameRanges)
            }
          }
        }
        start = end + 1
        discardLongLine = false
        end = text.indexOf('\n', start)
      }
      carry = text.slice(start)
      if (carry.length > maximumLineBytes) {
        carry = ''
        discardLongLine = true
        usable = false
      }
    }
    if (carry && !discardLongLine && carry.startsWith('RCFACE1 ')) {
      const row = Buffer.from(`${carry}\n`)
      if (row.length > maximumLineBytes || bytes + row.length > detectionCacheMaximumBytes) usable = false
      else {
        await writeBuffer(handle, row)
        bytes += row.length
        coverageUsable = coverageUsable && recordFrameRange(carry, frameRanges)
      }
    }
  } catch {
    usable = false
    await drain(stream)
  } finally {
    await handle?.close().catch(() => undefined)
    if (!usable) await rm(outputPath, { force: true }).catch(() => undefined)
    onComplete(usable, coverageUsable ? frameRanges : [])
  }
}
