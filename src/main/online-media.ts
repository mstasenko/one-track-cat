import type { OnlineTemplate, TemplateSource } from '../online-templates'

type MediaType = OnlineTemplate['type']
type MediaExtension = 'jpg' | 'jpeg' | 'png' | 'webp' | 'gif' | 'mp4' | 'mp3' | 'ogg' | 'oga' | 'wav' | 'flac' | 'm4a' | 'aac'

const WIKIMEDIA_ORIGINAL_QUERY = '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original'
const REQUEST_TIMEOUT_MS = 15_000
const JSON_BODY_LIMIT = 4 * 1024 * 1024
export const MEDIA_BODY_LIMIT = 32 * 1024 * 1024
const mediaExtensions = new Set<MediaExtension>([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a', 'aac'
])
export const imageExtensions = new Set<MediaExtension>(['jpg', 'jpeg', 'png', 'webp'])
const imageMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
export const audioMimeTypes: Record<MediaExtension, readonly string[]> = {
  mp3: ['audio/mpeg'],
  ogg: ['audio/ogg', 'application/ogg'],
  oga: ['audio/ogg', 'application/ogg'],
  wav: ['audio/wav', 'audio/x-wav'],
  flac: ['audio/flac'],
  m4a: ['audio/mp4'],
  aac: ['audio/aac'],
  jpg: [], jpeg: [], png: [], webp: [], gif: [], mp4: []
}
const audioExtensions = new Set<MediaExtension>(['mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a', 'aac'])

function mediaType(extension: MediaExtension): MediaType {
  if (extension === 'gif') return 'gif'
  if (extension === 'mp4') return 'video'
  if (audioExtensions.has(extension)) return 'audio'
  return 'image'
}

function decodedPath(value: string): string | null {
  try {
    const path = decodeURIComponent(value)
    return path.includes('\\') || path.includes('\0') ? null : path
  } catch {
    return null
  }
}

export function mediaUrl(value: unknown, source: TemplateSource): { extension: MediaExtension; type: MediaType; url: string } | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const wikimediaHost = source === 'wikimedia' && parsed.hostname === 'upload.wikimedia.org'
  const wikimediaOriginalQuery = wikimediaHost && parsed.search === WIKIMEDIA_ORIGINAL_QUERY
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || /^(?:https):\/\/[^/?#]*:\d+(?:[/?#]|$)/i.test(value)
    || (parsed.search && !wikimediaOriginalQuery)
    || parsed.hash
  ) {
    return null
  }
  if (source === 'wikimedia' ? !wikimediaHost : parsed.hostname !== 'i.imgflip.com' && parsed.hostname !== 'imgflip.com') return null
  if (wikimediaOriginalQuery) parsed.search = ''
  const path = decodedPath(parsed.pathname)
  if (!path) return null
  const match = source !== 'wikimedia' && parsed.hostname === 'i.imgflip.com'
    ? /^\/[^/]+\.([a-z0-9]+)$/i.exec(path)
    : source !== 'wikimedia' && parsed.hostname === 'imgflip.com'
      ? /^\/s\/meme\/[^/]+\.([a-z0-9]+)$/i.exec(path)
      : source === 'wikimedia' && safeWikimediaPath(path)
        ? /\.([a-z0-9]+)$/i.exec(path)
        : null
  const extension = match?.[1]?.toLowerCase() as MediaExtension | undefined
  return extension && mediaExtensions.has(extension)
    ? { extension, type: mediaType(extension), url: wikimediaOriginalQuery ? value.slice(0, -WIKIMEDIA_ORIGINAL_QUERY.length) : value }
    : null
}

function safeWikimediaPath(path: string): boolean {
  if (!path.startsWith('/wikipedia/commons/')) return false
  const segments = path.split('/')
  return segments.length >= 5
    && segments[3] !== 'thumb'
    && segments.every((segment) => segment !== '.' && segment !== '..' && segment.length <= 512)
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // The response is already being aborted; there is no further cleanup to do.
  }
}

async function readBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response has no readable body')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      total += chunk.byteLength
      if (total > limit) {
        await cancelReader(reader)
        throw new Error('Response body exceeds its size limit')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    await cancelReader(reader)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function responseError(response: Response): Error | null {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return new Error('Redirects are not allowed')
  }
  return response.ok ? null : new Error(`Request failed with HTTP ${response.status}`)
}

export async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Template request timed out'))
    }, REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}

export async function requestBody(
  url: string,
  limit: number,
  validateResponse?: (response: Response) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const operation = async (requestSignal: AbortSignal): Promise<Uint8Array> => {
    requestSignal.throwIfAborted()
    const response = await fetch(url, { redirect: 'error', signal: requestSignal })
    const error = responseError(response)
    if (error) throw error
    validateResponse?.(response)
    return readBody(response, limit)
  }
  return signal ? operation(signal) : withTimeout(operation)
}

export async function requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const bytes = await requestBody(url, JSON_BODY_LIMIT, undefined, signal)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error('Response was not valid JSON')
  }
}

function mediaContentType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export function mediaResponseValidator(item: OnlineTemplate): (response: Response) => void {
  return (response) => {
    const contentType = mediaContentType(response)
    const parsed = mediaUrl(item.url, item.source)
    const valid = item.type === 'image'
      ? imageMimeTypes.has(contentType)
      : item.type === 'gif'
        ? contentType === 'image/gif'
        : item.type === 'video'
          ? contentType === 'video/mp4'
          : Boolean(parsed && audioMimeTypes[parsed.extension].includes(contentType))
    if (!valid) throw new Error('Downloaded media has an unsupported content type')
  }
}
