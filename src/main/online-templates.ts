import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssetItem } from '../types'
import type { OnlineTemplate, TemplateCategory, TemplateSource } from '../online-templates'
import {
  MEDIA_BODY_LIMIT,
  audioMimeTypes,
  imageExtensions,
  mediaResponseValidator,
  mediaUrl,
  requestBody,
  requestJson,
  withTimeout
} from './online-media'

type RecordValue = Record<string, unknown>
type DestinationState = 'missing' | 'cached' | 'occupied'

// HF /search can report a cold index as ResponseNotReady, while /rows is stable.
const HF_ROWS_ENDPOINT = 'https://datasets-server.huggingface.co/rows'
const IMGFLIP_ENDPOINT = 'https://api.imgflip.com/get_memes'
const WIKIMEDIA_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'
const WIKIMEDIA_CC0_QUERY = 'haswbstatement:P275=Q6938433'
const RESULT_LIMIT = 24
const KNOWN_TEMPLATE_LIMIT = 512
const HF_PAGE_SIZE = 100
const HF_CATALOG_LIMIT = 1000
const MEMEFACT_CONTEXT_LIMIT = 8192
const acceptedWikimediaLicenses = new Set(['cc0', 'cc0 1.0'])

interface MemeFactEntry {
  template: OnlineTemplate
  searchText: string
}

const catalogPromises: Partial<Record<TemplateCategory, Promise<OnlineTemplate[]>>> = {}
const wikimediaPromises = new Map<string, Promise<OnlineTemplate[]>>()
let memefactCatalogPromise: Promise<MemeFactEntry[]> | undefined
const knownTemplates = new Map<string, OnlineTemplate>()

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSource(value: unknown): value is TemplateSource {
  return value === 'memefact' || value === 'imgflip' || value === 'imkg' || value === 'wikimedia'
}

function isCategory(value: unknown): value is TemplateCategory {
  return value === 'image' || value === 'video' || value === 'audio'
}

function queryText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const query = value.trim()
  return query.length >= 2 && query.length <= 120 ? query : null
}

function numericId(value: unknown): string | null {
  const text = typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
    : typeof value === 'string' ? value : ''
  if (!/^\d{1,12}$/.test(text)) return null
  return text.replace(/^0+(?=\d)/, '')
}

function imkgId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-z]{1,12}$/.test(value) ? value : null
}

function requiredId(source: TemplateSource, value: unknown): string {
  const id = source === 'imkg' ? imkgId(value) : numericId(value)
  if (!id) {
    throw new Error(source === 'imkg'
      ? 'Template ID must contain one to twelve lowercase base36 characters'
      : 'Template ID must contain one to twelve digits')
  }
  return id
}

function templateKey(source: TemplateSource, id: string): string {
  return `${source}:${id}`
}

function boundedName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= 240 ? name : null
}

function templateFromFields(
  source: TemplateSource,
  category: TemplateCategory,
  idValue: unknown,
  nameValue: unknown,
  urlValue: unknown
): OnlineTemplate | null {
  const id = numericId(idValue)
  const name = boundedName(nameValue)
  const parsedUrl = mediaUrl(urlValue, source)
  if (!id || !name || !parsedUrl || typeof urlValue !== 'string') return null
  if (source === 'memefact' && (category !== 'image' || parsedUrl.type !== 'image' || !imageExtensions.has(parsedUrl.extension))) return null
  if (source === 'imgflip' && category === 'audio') return null
  if (source === 'imgflip' && category === 'image' && parsedUrl.type !== 'image') return null
  if (source === 'imgflip' && category === 'video' && parsedUrl.type !== 'video') return null
  return { id, source, name, type: parsedUrl.type, url: urlValue }
}

function deduplicate(templates: (OnlineTemplate | null)[]): OnlineTemplate[] {
  const seen = new Set<string>()
  const output: OnlineTemplate[] = []
  for (const template of templates) {
    if (!template) continue
    const key = templateKey(template.source, template.id)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(template)
  }
  return output
}

function remember(templates: OnlineTemplate[]): OnlineTemplate[] {
  for (const template of templates) {
    const key = templateKey(template.source, template.id)
    knownTemplates.delete(key)
    knownTemplates.set(key, template)
  }
  while (knownTemplates.size > KNOWN_TEMPLATE_LIMIT) {
    const first = knownTemplates.keys().next()
    if (first.done) break
    knownTemplates.delete(first.value)
  }
  return templates
}













function memefactPage(value: unknown): { total: number; rows: unknown[] } {
  if (!isRecord(value) || !Array.isArray(value.rows) || value.rows.length > HF_PAGE_SIZE) {
    throw new Error('MemeFact returned an invalid catalog page')
  }
  const total = value.num_rows_total
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > HF_CATALOG_LIMIT) {
    throw new Error('MemeFact returned an invalid catalog total')
  }
  return { total, rows: value.rows }
}

function boundedContext(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MEMEFACT_CONTEXT_LIMIT).toLowerCase() : ''
}

function memefactEntry(value: unknown): MemeFactEntry | null {
  if (!isRecord(value) || !isRecord(value.row)) return null
  const row = value.row
  const template = templateFromFields('memefact', 'image', row.template_id, row.template_title, row.template_url)
  if (!template) return null
  const searchText = [template.name.toLowerCase(), boundedContext(row.about), boundedContext(row.description)]
    .filter(Boolean)
    .join(' ')
  return { template, searchText }
}

function deduplicateMemefact(entries: MemeFactEntry[]): MemeFactEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = templateKey(entry.template.source, entry.template.id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function loadMemefactCatalog(signal: AbortSignal): Promise<MemeFactEntry[]> {
  const entries: MemeFactEntry[] = []
  let total: number | undefined
  for (let offset = 0; ; offset += HF_PAGE_SIZE) {
    const params = new URLSearchParams({
      dataset: 'sergiogpinto/memefact-templates',
      config: 'default',
      split: 'train',
      offset: String(offset),
      length: String(HF_PAGE_SIZE)
    })
    const page = memefactPage(await requestJson(`${HF_ROWS_ENDPOINT}?${params.toString()}`, signal))
    total ??= page.total
    if (page.total !== total || offset > total) throw new Error('MemeFact catalog paging changed unexpectedly')
    const expectedLength = Math.min(HF_PAGE_SIZE, total - offset)
    if (page.rows.length !== expectedLength) throw new Error('MemeFact returned an incomplete catalog page')
    entries.push(...page.rows.map(memefactEntry).filter((entry): entry is MemeFactEntry => entry !== null))
    if (offset + page.rows.length === total) break
  }
  return deduplicateMemefact(entries)
}

function cachedMemefactCatalog(): Promise<MemeFactEntry[]> {
  if (memefactCatalogPromise) return memefactCatalogPromise
  const request = withTimeout(loadMemefactCatalog)
  memefactCatalogPromise = request
  request.catch(() => {
    if (memefactCatalogPromise === request) memefactCatalogPromise = undefined
  })
  return request
}

function imgflipTemplates(value: unknown, category: TemplateCategory): OnlineTemplate[] {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data) || !Array.isArray(value.data.memes)) {
    throw new Error('Imgflip returned an invalid catalog')
  }
  return deduplicate(value.data.memes.map((entry) => {
    if (!isRecord(entry)) return null
    return templateFromFields('imgflip', category, entry.id, entry.name, entry.url)
  }))
}

async function loadImgflipCatalog(category: TemplateCategory): Promise<OnlineTemplate[]> {
  const url = new URL(IMGFLIP_ENDPOINT)
  url.searchParams.set('type', category === 'image' ? 'image' : 'gif')
  return imgflipTemplates(await requestJson(url.toString()), category)
}

function cachedImgflipCatalog(category: TemplateCategory): Promise<OnlineTemplate[]> {
  const cached = catalogPromises[category]
  if (cached) return cached
  const request = loadImgflipCatalog(category)
  catalogPromises[category] = request
  request.catch(() => {
    if (catalogPromises[category] === request) catalogPromises[category] = undefined
  })
  return request
}

function wikimediaLicense(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.extmetadata)) return null
  const metadata = value.extmetadata.LicenseShortName
  if (!isRecord(metadata) || typeof metadata.value !== 'string') return null
  const license = metadata.value.trim().toLowerCase()
  return acceptedWikimediaLicenses.has(license) ? license : null
}

function wikimediaTemplate(value: unknown): OnlineTemplate | null {
  if (!isRecord(value) || !Array.isArray(value.imageinfo)) return null
  const id = numericId(value.pageid)
  const title = boundedName(value.title)?.replace(/^file:\s*/i, '').trim()
  const info = (value.imageinfo as unknown[])[0]
  if (!id || !title || title.length > 240 || !isRecord(info) || typeof info.url !== 'string') return null
  const parsedUrl = mediaUrl(info.url, 'wikimedia')
  const acceptedAudioMimes = parsedUrl ? audioMimeTypes[parsedUrl.extension] : undefined
  const mime = typeof info.mime === 'string' ? info.mime.split(';', 1)[0]?.trim().toLowerCase() ?? '' : ''
  const mediatype = typeof info.mediatype === 'string' ? info.mediatype.trim().toLowerCase() : ''
  if (
    !parsedUrl
    || parsedUrl.type !== 'audio'
    || mediatype !== 'audio'
    || acceptedAudioMimes?.includes(mime) !== true
    || !wikimediaLicense(info)
  ) return null
  return { id, source: 'wikimedia', name: title, type: 'audio', url: parsedUrl.url }
}

function wikimediaPages(value: unknown): unknown[] {
  if (!isRecord(value)) {
    throw new Error('Wikimedia Commons returned an invalid catalog')
  }
  if (value.query === undefined && value.batchcomplete === '') return []
  if (!isRecord(value.query) || !isRecord(value.query.pages)) {
    throw new Error('Wikimedia Commons returned an invalid catalog')
  }
  return Object.values(value.query.pages)
}

async function loadWikimediaCatalog(query: string): Promise<OnlineTemplate[]> {
  const url = new URL(WIKIMEDIA_ENDPOINT)
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('generator', 'search')
  url.searchParams.set('gsrnamespace', '6')
  url.searchParams.set('gsrlimit', String(RESULT_LIMIT))
  url.searchParams.set('gsrsearch', `filetype:audio ${WIKIMEDIA_CC0_QUERY} ${query}`)
  url.searchParams.set('prop', 'imageinfo')
  url.searchParams.set('iiprop', 'url|mime|mediatype|extmetadata')
  return deduplicate(wikimediaPages(await requestJson(url.toString())).map(wikimediaTemplate))
}

function cachedWikimediaCatalog(query: string): Promise<OnlineTemplate[]> {
  const cached = wikimediaPromises.get(query)
  if (cached) return cached
  const request = loadWikimediaCatalog(query)
  wikimediaPromises.set(query, request)
  request.catch(() => {
    if (wikimediaPromises.get(query) === request) wikimediaPromises.delete(query)
  })
  return request
}

function matchingWords(text: string, words: string[]): boolean {
  const normalized = text.toLowerCase()
  return words.every((word) => normalized.includes(word))
}

function matchingName(template: OnlineTemplate, words: string[]): boolean {
  return matchingWords(template.name, words)
}

async function searchMemefact(query: string): Promise<OnlineTemplate[]> {
  const catalog = await cachedMemefactCatalog()
  const words = query.toLowerCase().split(/\s+/)
  const titleMatches = catalog.filter((entry) => matchingName(entry.template, words))
  const contextMatches = catalog.filter((entry) => (
    !matchingName(entry.template, words) && matchingWords(entry.searchText, words)
  ))
  return remember([...titleMatches, ...contextMatches].slice(0, RESULT_LIMIT).map((entry) => entry.template))
}

async function searchImgflip(category: TemplateCategory, query: string): Promise<OnlineTemplate[]> {
  const catalog = await cachedImgflipCatalog(category)
  const words = query.toLowerCase().split(/\s+/)
  return remember(catalog.filter((template) => matchingName(template, words)).slice(0, RESULT_LIMIT))
}

async function searchWikimedia(query: string): Promise<OnlineTemplate[]> {
  return remember((await cachedWikimediaCatalog(query)).slice(0, RESULT_LIMIT))
}

export async function searchTemplates(
  source: unknown,
  category: unknown,
  query: unknown
): Promise<OnlineTemplate[]> {
  const normalizedQuery = queryText(query)
  if (!isSource(source) || !isCategory(category) || !normalizedQuery) return []
  if (source === 'memefact') return category === 'image' ? searchMemefact(normalizedQuery) : []
  if (source === 'imkg') {
    if (category !== 'image') return []
    const { searchImkg } = await import('./imkg')
    return remember(searchImkg(normalizedQuery))
  }
  if (source === 'wikimedia') return category === 'audio' ? searchWikimedia(normalizedQuery) : []
  if (category === 'audio') return []
  return searchImgflip(category, normalizedQuery)
}





function mediaFilename(item: OnlineTemplate): string {
  const parsed = mediaUrl(item.url, item.source)
  if (!parsed) throw new Error('Template media URL is no longer trusted')
  return `${item.source}-${requiredId(item.source, item.id)}.${parsed.extension}`
}

function nodeErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

async function destinationState(path: string): Promise<DestinationState> {
  try {
    const info = await lstat(path)
    return info.isFile() && info.size > 0 ? 'cached' : 'occupied'
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

function assetFor(item: OnlineTemplate, path: string): AssetItem {
  return { name: item.name, type: item.type, path }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // Preserve the original download/write error and never touch the final asset.
  }
}

export async function importTemplate(
  source: unknown,
  id: unknown,
  directory: string
): Promise<AssetItem> {
  if (!isSource(source)) throw new Error('Template source is unsupported')
  const normalizedId = requiredId(source, id)
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('Template directory is required')
  const item = knownTemplates.get(templateKey(source, normalizedId))
  // electron-vite's ESM shim scanner treats a trailing bare "import" as syntax.
  if (!item) throw new Error('Search for the template before adding it')
  await mkdir(directory, { recursive: true })
  const outputPath = join(directory, mediaFilename(item))
  const before = await destinationState(outputPath)
  if (before === 'cached') return assetFor(item, outputPath)
  if (before === 'occupied') throw new Error('Template destination is already occupied')
  const temporaryPath = join(directory, `.${mediaFilename(item)}.${randomUUID()}.tmp`)
  try {
    const bytes = await requestBody(item.url, MEDIA_BODY_LIMIT, mediaResponseValidator(item))
    if (bytes.byteLength === 0) throw new Error('Downloaded media is empty')
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o644 })
    const after = await destinationState(outputPath)
    if (after !== 'missing') {
      if (after === 'cached') {
        await removeTemporary(temporaryPath)
        return assetFor(item, outputPath)
      }
      throw new Error('Template destination became occupied')
    }
    await rename(temporaryPath, outputPath)
    return assetFor(item, outputPath)
  } catch (error) {
    await removeTemporary(temporaryPath)
    throw error
  }
}

export function templatePage(source: unknown, id: unknown): string {
  if (!isSource(source)) throw new Error('Template source is unsupported')
  const normalizedId = requiredId(source, id)
  if (source === 'wikimedia') return `https://commons.wikimedia.org/?curid=${normalizedId}`
  return source === 'imkg'
    ? `https://imgflip.com/i/${normalizedId}`
    : `https://imgflip.com/memegenerator/${normalizedId}`
}
