import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

type OnlineTemplates = typeof import('./online-templates')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type FetchMock = Mock<FetchImplementation>

const fsMocks = vi.hoisted(() => ({ writeFile: vi.fn(), rename: vi.fn() }))
const imkgMocks = vi.hoisted(() => ({ searchImkg: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  fsMocks.writeFile.mockImplementation(actual.writeFile)
  fsMocks.rename.mockImplementation(actual.rename)
  return {
    ...actual,
    writeFile: fsMocks.writeFile,
    rename: fsMocks.rename,
    default: { ...actual, writeFile: fsMocks.writeFile, rename: fsMocks.rename }
  }
})
vi.mock('./imkg', () => ({ searchImkg: imkgMocks.searchImkg }))

let online: OnlineTemplates
let fetchMock: FetchMock
const directories: string[] = []

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function mediaResponse(value: BodyInit, contentType: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': contentType } })
}

function hfRow(
  id: unknown,
  name: unknown,
  url: unknown,
  context: Record<string, unknown> = {}
): Record<string, unknown> {
  return { row: { template_id: id, template_title: name, template_url: url, ...context } }
}

function hfPage(total: number, rows: unknown[]): Record<string, unknown> {
  return { num_rows_total: total, rows }
}

function imgflipCatalog(memes: unknown[]): Record<string, unknown> {
  return { success: true, data: { memes } }
}

function wikimediaPage(
  pageid: unknown,
  title: unknown,
  url: unknown,
  mime = 'audio/ogg',
  license = 'CC0 1.0',
  mediatype = 'AUDIO'
): Record<string, unknown> {
  return {
    pageid,
    title,
    imageinfo: [{ url, mime, mediatype, extmetadata: { LicenseShortName: { value: license } } }]
  }
}

function wikimediaCatalog(pages: Record<string, unknown>[]): Record<string, unknown> {
  return { query: { pages: Object.fromEntries(pages.map((page) => [String(page.pageid), page])) } }
}

beforeEach(async () => {
  vi.resetModules()
  fsMocks.writeFile.mockClear()
  fsMocks.rename.mockClear()
  imkgMocks.searchImkg.mockReset()
  imkgMocks.searchImkg.mockReturnValue([])
  online = await import('./online-templates')
  fetchMock = vi.fn<FetchImplementation>()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('online template validation and search', () => {
  it('rejects invalid inputs without making a request and builds safe pages', async () => {
    expect(online.templatePage('imgflip', 123)).toBe('https://imgflip.com/memegenerator/123')
    expect(online.templatePage('imgflip', '001')).toBe('https://imgflip.com/memegenerator/1')
    expect(online.templatePage('imkg', '000a')).toBe('https://imgflip.com/i/000a')
    expect(online.templatePage('wikimedia', 123)).toBe('https://commons.wikimedia.org/?curid=123')
    expect(() => online.templatePage('imgflip', '1234567890123')).toThrow('digits')
    expect(() => online.templatePage('imkg', '000A')).toThrow('base36')
    expect(() => online.templatePage('imkg', 123)).toThrow('base36')
    expect(() => online.templatePage('unknown', '123')).toThrow('unsupported')

    for (const [source, category, query] of [
      ['unknown', 'image', 'cat'], ['memefact', 'audio', 'cat'],
      ['memefact', 'image', 'a'], ['memefact', 'image', '   '],
      ['memefact', 'video', 'cat'], ['imkg', 'video', 'cat'], ['imgflip', 'audio', 'cat'], [null, null, null]
    ] as const) {
      await expect(online.searchTemplates(source, category, query)).resolves.toEqual([])
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('loads IMKG image results lazily and preserves lowercase base36 IDs', async () => {
    imkgMocks.searchImkg.mockReturnValue([
      { id: '000a', source: 'imkg', name: 'Cat', type: 'image', url: 'https://i.imgflip.com/imkg-cat.jpg' }
    ])

    await expect(online.searchTemplates('imkg', 'image', 'cat')).resolves.toEqual([
      { id: '000a', source: 'imkg', name: 'Cat', type: 'image', url: 'https://i.imgflip.com/imkg-cat.jpg' }
    ])
    expect(imkgMocks.searchImkg).toHaveBeenCalledWith('cat')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps MemeFact title, ID, and direct image URL only', async () => {
    fetchMock.mockResolvedValue(jsonResponse(hfPage(6, [
      hfRow(999, 'About match', 'https://imgflip.com/s/meme/about.png', { about: 'cat' }),
      hfRow(123, 'Boat Cat', 'https://imgflip.com/s/meme/boat.jpg'),
      hfRow(123, 'Duplicate', 'https://imgflip.com/s/meme/duplicate.jpg'),
      hfRow('bad', 'Bad ID', 'https://imgflip.com/s/meme/bad.jpg'),
      hfRow(456, 'Unsafe Host', 'https://evil.example/meme.jpg'),
      hfRow(789, 'Video', 'https://imgflip.com/s/meme/video.mp4')
    ])))

    const result = await online.searchTemplates('memefact', 'image', '  cat  ')
    expect(result).toEqual([
      { id: '123', source: 'memefact', name: 'Boat Cat', type: 'image', url: 'https://imgflip.com/s/meme/boat.jpg' },
      { id: '999', source: 'memefact', name: 'About match', type: 'image', url: 'https://imgflip.com/s/meme/about.png' }
    ])
    expect(result[1]).not.toHaveProperty('about')
    expect(result[1]).not.toHaveProperty('captions')
    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string)
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://datasets-server.huggingface.co/rows')
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      dataset: 'sergiogpinto/memefact-templates', config: 'default', split: 'train',
      offset: '0', length: '100'
    })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })

  it('propagates offline or malformed MemeFact responses', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('offline')

    fetchMock.mockResolvedValueOnce(jsonResponse({ num_rows_total: 1, rows: 'not-an-array' }))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('catalog')
  })

  it('loads every MemeFact page, including a partial last page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      hfRow(1000 + index, `Template ${index}`, `https://imgflip.com/s/meme/template-${index}.jpg`))
    const secondPage = Array.from({ length: 100 }, (_, index) =>
      hfRow(2000 + index, `Template ${index + 100}`, `https://imgflip.com/s/meme/template-${index + 100}.jpg`))
    const lateMatch = hfRow(9999, 'No title match', 'https://imgflip.com/s/meme/late-match.jpg', {
      description: 'late cat context'
    })
    fetchMock.mockImplementation((input) => {
      const offset = new URL(input as string).searchParams.get('offset')
      if (offset === '0') return Promise.resolve(jsonResponse(hfPage(201, firstPage)))
      if (offset === '100') return Promise.resolve(jsonResponse(hfPage(201, secondPage)))
      if (offset === '200') return Promise.resolve(jsonResponse(hfPage(201, [lateMatch])))
      return Promise.reject(new Error(`unexpected offset ${offset}`))
    })

    await expect(online.searchTemplates('memefact', 'image', 'cat')).resolves.toEqual([
      { id: '9999', source: 'memefact', name: 'No title match', type: 'image', url: 'https://imgflip.com/s/meme/late-match.jpg' }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([input]) => new URL(input as string).searchParams.get('offset')))
      .toEqual(['0', '100', '200'])
  })

  it('shares an in-flight MemeFact catalog and caches the successful result', async () => {
    let release: (response: Response) => void = () => undefined
    const response = new Promise<Response>((resolve) => { release = resolve })
    fetchMock.mockReturnValue(response)

    const catSearch = online.searchTemplates('memefact', 'image', 'cat')
    const dogSearch = online.searchTemplates('memefact', 'image', 'dog')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release(jsonResponse(hfPage(1, [hfRow(123, 'Cat Dog', 'https://imgflip.com/s/meme/cat-dog.jpg')])))

    await expect(catSearch).resolves.toHaveLength(1)
    await expect(dogSearch).resolves.toHaveLength(1)
    await expect(online.searchTemplates('memefact', 'image', 'dog')).resolves.toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clears a failed MemeFact page load without returning a partial catalog', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      hfRow(3000 + index, `Template ${index}`, `https://imgflip.com/s/meme/page-${index}.jpg`))
    fetchMock.mockResolvedValueOnce(jsonResponse(hfPage(101, firstPage)))
      .mockRejectedValueOnce(new Error('second page offline'))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('second page offline')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(jsonResponse(hfPage(1, [
      hfRow(4000, 'Recovered Cat', 'https://imgflip.com/s/meme/recovered-cat.jpg')
    ])))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).resolves.toEqual([
      { id: '4000', source: 'memefact', name: 'Recovered Cat', type: 'image', url: 'https://imgflip.com/s/meme/recovered-cat.jpg' }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects invalid or oversized MemeFact page metadata', async () => {
    const oversizedPage = Array.from({ length: 101 }, (_, index) =>
      hfRow(5000 + index, `Template ${index}`, `https://imgflip.com/s/meme/oversized-${index}.jpg`))
    for (const response of [
      jsonResponse({ rows: [] }),
      jsonResponse({ num_rows_total: '1', rows: [] }),
      jsonResponse({ num_rows_total: -1, rows: [] }),
      jsonResponse({ num_rows_total: 1.5, rows: [] }),
      jsonResponse({ num_rows_total: 1001, rows: [] }),
      jsonResponse(hfPage(100, oversizedPage))
    ]) {
      fetchMock.mockResolvedValueOnce(response)
      await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('catalog')
    }
  })

  it('accepts an empty valid MemeFact catalog', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(hfPage(0, [])))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects changing totals and stalled non-final pages', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      hfRow(6000 + index, `Template ${index}`, `https://imgflip.com/s/meme/changing-${index}.jpg`))
    fetchMock.mockResolvedValueOnce(jsonResponse(hfPage(101, fullPage)))
      .mockResolvedValueOnce(jsonResponse(hfPage(100, [])))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('catalog')

    fetchMock.mockResolvedValueOnce(jsonResponse(hfPage(101, fullPage)))
      .mockResolvedValueOnce(jsonResponse(hfPage(101, [])))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('catalog')
  })

  it('caches Imgflip catalogs and requires every name word', async () => {
    fetchMock.mockResolvedValue(jsonResponse(imgflipCatalog([
      { id: '1', name: 'Cat Dog', url: 'https://i.imgflip.com/1.jpg' },
      { id: '1', name: 'Duplicate', url: 'https://i.imgflip.com/1.jpg' },
      { id: '2', name: 'Cat', url: 'https://i.imgflip.com/2.jpg' },
      { id: '3', name: 'Cat Dog', url: 'http://i.imgflip.com/3.jpg' },
      { id: '4', name: 'Cat Dog', url: 'https://i.imgflip.com/4.jpg?unsafe=1' },
      { id: '5', name: 'Cat Dog', url: 'https://i.imgflip.com/path/5.jpg' },
      { id: '9999999999999', name: 'Cat Dog', url: 'https://i.imgflip.com/6.jpg' },
      { id: '7', name: ' '.repeat(241), url: 'https://i.imgflip.com/7.jpg' },
      { id: '10', name: 'Cat Dog', url: 'https://localhost/10.jpg' },
      { id: '11', name: 'Cat Dog', url: 'http://i.imgflip.com/11.jpg' },
      { id: '12', name: 'Cat Dog', url: 'https://user:pass@i.imgflip.com/12.jpg' },
      { id: '13', name: 'Cat Dog', url: 'https://i.imgflip.com:443/13.jpg' },
      { id: '14', name: 'Cat Dog', url: 'https://i.imgflip.com/a%2Fb.jpg' },
      { id: '15', name: 'Cat Dog', url: 'https://i.imgflip.com/15.svg' }
    ])))

    await expect(online.searchTemplates('imgflip', 'image', 'cat dog')).resolves.toEqual([
      { id: '1', source: 'imgflip', name: 'Cat Dog', type: 'image', url: 'https://i.imgflip.com/1.jpg' }
    ])
    await expect(online.searchTemplates('imgflip', 'image', 'cat')).resolves.toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('type')).toBe('image')
  })

  it('maps Imgflip GIF catalog MP4 URLs as video and retries failed catalogs', async () => {
    fetchMock.mockRejectedValueOnce(new Error('temporary offline'))
      .mockResolvedValueOnce(jsonResponse(imgflipCatalog([
        { id: 8, name: 'Dancing Cat', url: 'https://i.imgflip.com/8.mp4' },
        { id: 9, name: 'Still Cat', url: 'https://i.imgflip.com/9.jpg' }
      ])))

    await expect(online.searchTemplates('imgflip', 'video', 'cat')).rejects.toThrow('temporary offline')
    await expect(online.searchTemplates('imgflip', 'video', 'cat')).resolves.toEqual([
      { id: '8', source: 'imgflip', name: 'Dancing Cat', type: 'video', url: 'https://i.imgflip.com/8.mp4' }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get('type')).toBe('gif')
  })

  it('searches Wikimedia audio with a CC0 file query and filters metadata safely', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(wikimediaCatalog([
      wikimediaPage(42, 'File:Bell.ogg', 'https://upload.wikimedia.org/wikipedia/commons/3/35/Bell.ogg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original'),
      wikimediaPage(43, 'File:Wrong license.ogg', 'https://upload.wikimedia.org/wikipedia/commons/3/35/Wrong_license.ogg', 'audio/ogg', 'CC BY 4.0'),
      wikimediaPage(44, 'File:Wrong MIME.ogg', 'https://upload.wikimedia.org/wikipedia/commons/3/35/Wrong_MIME.ogg', 'audio/mpeg'),
      wikimediaPage(45, 'File:Not audio.ogg', 'https://upload.wikimedia.org/wikipedia/commons/3/35/Not_audio.ogg', 'audio/ogg', 'CC0 1.0', 'BITMAP'),
      wikimediaPage(46, 'File:Unsafe.mp3', 'https://evil.example/wikipedia/commons/3/35/Unsafe.mp3', 'audio/mpeg'),
      wikimediaPage(47, 'File:Query.ogg', 'https://upload.wikimedia.org/wikipedia/commons/3/35/Query.ogg?download=1'),
      wikimediaPage(48, 'File:Thumb.ogg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Thumb.ogg')
    ])))

    await expect(online.searchTemplates('wikimedia', 'audio', '  bell  ')).resolves.toEqual([{
      id: '42', source: 'wikimedia', name: 'Bell.ogg', type: 'audio',
      url: 'https://upload.wikimedia.org/wikipedia/commons/3/35/Bell.ogg'
    }])
    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string)
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://commons.wikimedia.org/w/api.php')
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '24',
      prop: 'imageinfo', iiprop: 'url|mime|mediatype|extmetadata'
    })
    expect(requestUrl.searchParams.get('gsrsearch')).toContain('filetype:audio')
    expect(requestUrl.searchParams.get('gsrsearch')).toContain('haswbstatement:P275=Q6938433')
    expect(requestUrl.searchParams.get('gsrsearch')).toContain('bell')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
    await expect(online.searchTemplates('wikimedia', 'image', 'bell')).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('treats a completed Wikimedia search with no matches as an empty result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ batchcomplete: '' }))
    await expect(online.searchTemplates('wikimedia', 'audio', 'no such sound')).resolves.toEqual([])
  })
})

describe('online template imports', () => {
  async function searchedTemplate(): Promise<string> {
    fetchMock.mockResolvedValueOnce(jsonResponse(hfPage(1, [
      hfRow(321, 'Boat Cat', 'https://imgflip.com/s/meme/boat.jpg')
    ])))
    const results = await online.searchTemplates('memefact', 'image', 'cat')
    const id = results[0]?.id
    if (!id) throw new Error('search fixture did not produce a template')
    return id
  }

  it('keeps IMKG and numeric Imgflip IDs separate during import', async () => {
    imkgMocks.searchImkg.mockReturnValue([{
      id: '123', source: 'imkg', name: 'IMKG Cat', type: 'image', url: 'https://i.imgflip.com/imkg-cat.jpg'
    }])
    await expect(online.searchTemplates('imkg', 'image', 'cat')).resolves.toHaveLength(1)
    fetchMock.mockResolvedValueOnce(jsonResponse(imgflipCatalog([
      { id: '123', name: 'Imgflip Cat', url: 'https://i.imgflip.com/imgflip-cat.jpg' }
    ])))
    await expect(online.searchTemplates('imgflip', 'image', 'cat')).resolves.toHaveLength(1)

    const directory = await mkdtemp(join(tmpdir(), 'otc-online-templates-'))
    directories.push(directory)
    fetchMock.mockResolvedValueOnce(mediaResponse(Uint8Array.from([1]), 'image/jpeg'))
      .mockResolvedValueOnce(mediaResponse(Uint8Array.from([2]), 'image/jpeg'))
    await expect(online.importTemplate('imkg', '123', directory)).resolves.toMatchObject({
      path: join(directory, 'imkg-123.jpg')
    })
    await expect(online.importTemplate('imgflip', '123', directory)).resolves.toMatchObject({
      path: join(directory, 'imgflip-123.jpg')
    })
  })

  it('downloads once, atomically renames, and reuses a nonempty cache file', async () => {
    const id = await searchedTemplate()
    const directory = await mkdtemp(join(tmpdir(), 'otc-online-templates-'))
    directories.push(directory)
    fetchMock.mockResolvedValueOnce(mediaResponse(new Uint8Array(), 'image/jpeg'))
    await expect(online.importTemplate('memefact', id, directory)).rejects.toThrow('empty')
    expect(await readdir(directory)).toEqual([])
    fetchMock.mockResolvedValueOnce(mediaResponse(Uint8Array.from([1, 2, 3]), 'image/jpeg'))

    const first = await online.importTemplate('memefact', id, directory)
    expect(first).toEqual({ name: 'Boat Cat', type: 'image', path: join(directory, 'memefact-321.jpg') })
    expect(await readFile(first.path)).toEqual(Buffer.from([1, 2, 3]))
    expect(await readdir(directory)).toEqual(['memefact-321.jpg'])
    const second = await online.importTemplate('memefact', id, directory)
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('imports a searched Wikimedia audio result with a matching audio MIME type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(wikimediaCatalog([
      wikimediaPage(52, 'File:Whistle.ogg', 'https://upload.wikimedia.org/wikipedia/commons/a/b/Whistle.ogg', 'application/ogg')
    ])))
    await expect(online.searchTemplates('wikimedia', 'audio', 'whistle')).resolves.toHaveLength(1)
    const directory = await mkdtemp(join(tmpdir(), 'otc-online-audio-'))
    directories.push(directory)
    fetchMock.mockResolvedValueOnce(mediaResponse(Uint8Array.from([1, 2, 3]), 'application/ogg'))

    await expect(online.importTemplate('wikimedia', '52', directory)).resolves.toEqual({
      name: 'Whistle.ogg', type: 'audio', path: join(directory, 'wikimedia-52.ogg')
    })
    expect(await readFile(join(directory, 'wikimedia-52.ogg'))).toEqual(Buffer.from([1, 2, 3]))

    await rm(join(directory, 'wikimedia-52.ogg'))
    fetchMock.mockResolvedValueOnce(mediaResponse(Uint8Array.from([4]), 'audio/mpeg'))
    await expect(online.importTemplate('wikimedia', '52', directory)).rejects.toThrow('content type')
  })

  it('rejects untrusted IDs, redirects, MIME mismatches, and oversized media', async () => {
    const id = await searchedTemplate()
    const directory = await mkdtemp(join(tmpdir(), 'otc-online-templates-'))
    directories.push(directory)
    await expect(online.importTemplate('imgflip', id, directory)).rejects.toThrow('Search for the template before adding it')
    await expect(online.importTemplate('memefact', '1'.repeat(13), directory)).rejects.toThrow('digits')
    await expect(online.importTemplate('imkg', 'ABC', directory)).rejects.toThrow('base36')

    fetchMock.mockResolvedValueOnce(mediaResponse('', 'image/gif'))
    await expect(online.importTemplate('memefact', id, directory)).rejects.toThrow('content type')
    expect(await readdir(directory)).toEqual([])

    fetchMock.mockResolvedValueOnce(mediaResponse('', 'image/jpeg', 302))
    await expect(online.importTemplate('memefact', id, directory)).rejects.toThrow('Redirects')

    const chunk = new Uint8Array(1024 * 1024)
    let remaining = 33 * chunk.byteLength
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
        remaining -= chunk.byteLength
      }
    })
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'image/jpeg' } }))
    await expect(online.importTemplate('memefact', id, directory)).rejects.toThrow('size limit')
    expect(await readdir(directory)).toEqual([])
  })

  it('cleans its temporary file when the atomic rename fails', async () => {
    const id = await searchedTemplate()
    const directory = await mkdtemp(join(tmpdir(), 'otc-online-templates-'))
    directories.push(directory)
    fetchMock.mockResolvedValueOnce(mediaResponse(Uint8Array.from([1, 2, 3]), 'image/jpeg'))
    fsMocks.rename.mockRejectedValueOnce(new Error('rename failed'))

    await expect(online.importTemplate('memefact', id, directory)).rejects.toThrow('rename failed')
    expect(await readdir(directory)).toEqual([])
    expect(fsMocks.rename).toHaveBeenCalled()
  })

  it('rejects an oversized JSON response before parsing', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let remaining = 5 * chunk.byteLength
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
        remaining -= chunk.byteLength
      }
    })
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'application/json' } }))
    await expect(online.searchTemplates('memefact', 'image', 'cat')).rejects.toThrow('size limit')
  })

  it('uses one timeout for the entire MemeFact catalog load and aborts its page fetch', async () => {
    vi.useFakeTimers()
    const signals: (AbortSignal | undefined)[] = []
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      hfRow(7000 + index, `Template ${index}`, `https://imgflip.com/s/meme/timeout-${index}.jpg`))
    fetchMock.mockImplementation((_input, init) => {
      signals.push(init?.signal ?? undefined)
      if (signals.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse(hfPage(101, firstPage))), 7_000)
        })
      }
      return new Promise<Response>(() => undefined)
    })
    const pending = online.searchTemplates('memefact', 'image', 'cat')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(signals[1]).toBe(signals[0])
    expect(signals[1]?.aborted).toBe(false)
    const assertion = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(8_000)
    await assertion
    expect(signals[1]?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
