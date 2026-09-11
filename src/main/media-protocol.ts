import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

interface ByteRange {
  start: number
  end: number
}

const mediaTypes: Record<string, string> = {
  '.aac': 'audio/aac', '.avi': 'video/x-msvideo', '.flac': 'audio/flac',
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp'
}

export function mediaUrl(path: string): string {
  return `media://local/${Buffer.from(path).toString('base64url')}`
}

export function decodeMediaUrl(url: string): string {
  const parsed = new URL(url)
  const encoded = parsed.pathname.replace(/^\//, '')
  return Buffer.from(encoded, 'base64url').toString('utf8')
}

function validStart(start: number, size: number): boolean {
  return Number.isSafeInteger(start) && start >= 0 && start < size
}

function validEnd(end: number, start: number): boolean {
  return Number.isSafeInteger(end) && end >= start
}

function boundedRange(start: number, end: number, size: number): ByteRange | null {
  if (!validStart(start, size)) return null
  if (!validEnd(end, start)) return null
  return { start, end: Math.min(end, size - 1) }
}

function parsedRange(match: RegExpExecArray, size: number): ByteRange | null {
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (!startText && !endText) return null
  if (!startText) {
    const suffixLength = Number(endText)
    return boundedRange(Math.max(0, size - suffixLength), size - 1, size)
  }
  const end = endText ? Number(endText) : size - 1
  return boundedRange(Number(startText), end, size)
}

export function byteRange(header: string | null, size: number): ByteRange | null {
  if (header === null) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match) return null
  return parsedRange(match, size)
}

function accessError(request: Request, path: string, canRead: (path: string) => boolean): Response | null {
  if (!canRead(path)) return new Response(null, { status: 403 })
  if (request.method === 'GET' || request.method === 'HEAD') return null
  return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
}

function headersFor(path: string, range: ByteRange): Headers {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': String(range.end - range.start + 1),
    'Content-Type': mediaTypes[extname(path).toLowerCase()] ?? 'application/octet-stream'
  })
  return headers
}

export async function mediaResponse(
  request: Request,
  canRead: (path: string) => boolean
): Promise<Response> {
  const path = decodeMediaUrl(request.url)
  const denied = accessError(request, path, canRead)
  if (denied) return denied
  const size = (await stat(path)).size
  const rangeHeader = request.headers.get('range')
  const range = byteRange(rangeHeader, size)
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` }
    })
  }
  const headers = headersFor(path, range)
  const hasRange = rangeHeader !== null
  if (hasRange) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  const status = hasRange ? 206 : 200
  if (request.method === 'HEAD') return new Response(null, { status, headers })
  if (size === 0) return new Response(null, { status, headers })
  const stream = Readable.toWeb(createReadStream(path, range)) as ReadableStream<Uint8Array>
  return new Response(stream, { status, headers })
}
