import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type Row = Record<string, unknown>

const generator = resolve('scripts/build-imkg-catalog.py')
const source = 'https://owncloud.ut.ee/owncloud/s/mFdPCY2mWdQLZ7Q'
let workDir = ''

function textOverride(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function row(overrides: Partial<Row> = {}): Row {
  const id = textOverride(overrides.id, 'abc123')
  const title = textOverride(overrides.title, 'Example title')
  const caption = textOverride(overrides.caption, 'Example caption')
  return {
    template_ID: overrides.template_ID ?? '100',
    template_title: overrides.template_title ?? 'Example template',
    title,
    alt_text: overrides.alt_text ?? `${title} | ${caption} | image tagged in memes | made w/ Imgflip meme maker`,
    upvote_count: overrides.upvote_count ?? '1',
    view_count: overrides.view_count ?? '1',
    image_url: overrides.image_url ?? `//i.imgflip.com/${id}.jpg`,
    URL: overrides.URL ?? `/i/${id}`,
  }
}

function makeArchive(value: unknown, extraMember = false): Buffer {
  const archive = new AdmZip()
  archive.addFile('imgflip-08_07_2022.json', Buffer.from(JSON.stringify(value)))
  if (extraMember) archive.addFile('unexpected.txt', Buffer.from('not-json'))
  return archive.toBuffer()
}

function makeRawArchive(json: string, extraMember = false): Buffer {
  const archive = new AdmZip()
  archive.addFile('imgflip-08_07_2022.json', Buffer.from(json))
  if (extraMember) archive.addFile('unexpected.txt', Buffer.from('not-json'))
  return archive.toBuffer()
}

function runGenerator(bytes: Buffer, outputName = 'catalog.json', outputSeed?: string) {
  const input = join(workDir, 'input.zip')
  const output = join(workDir, outputName)
  writeFileSync(input, bytes)
  if (outputSeed !== undefined) writeFileSync(output, outputSeed)
  const result = spawnSync('python3', [generator, input, output], { encoding: 'utf8' })
  return { result, output, input }
}

function readCatalog(path: string): { source: string; archiveSha256: string; memes: Record<string, string>[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { source: string; archiveSha256: string; memes: Record<string, string>[] }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'otc-imkg-catalog-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('build-imkg-catalog.py', () => {
  it('ranks, caps, cleans, normalizes, and deduplicates captioned examples', () => {
    const rows = [
      row({ id: 'bbb', template_ID: '00100', template_title: ' <b>Template A</b> ', title: 'Beta', caption: 'same caption', upvote_count: '8', view_count: '10' }),
      row({ id: 'aaa', template_ID: '100', template_title: 'Template A', title: 'Alpha', caption: ' SAME   CAPTION ', upvote_count: '9', view_count: '2' }),
      row({ id: 'ccc', template_ID: '100', template_title: 'Template A', title: 'Gamma', caption: 'third caption', upvote_count: '9', view_count: '5' }),
      row({ id: 'ddd', template_ID: '100', template_title: 'Template A', title: 'Delta', caption: 'fourth caption', upvote_count: '7', view_count: '90' }),
      row({ id: 'eee', template_ID: '100', template_title: 'Template A', title: 'Epsilon', caption: 'fifth caption', upvote_count: '6', view_count: '90' }),
      row({ id: 'fff', template_ID: '200', template_title: 'Template B', title: 'Tie later', caption: 'other', upvote_count: '9', view_count: '5' }),
      row({ id: 'aaa', template_ID: '200', template_title: 'Template B', title: 'Duplicate instance', caption: 'duplicate id', upvote_count: '1', view_count: '1' }),
      row({ id: 'fullid', template_ID: '300', URL: 'https://imgflip.com/i/fullid', image_url: 'https://i.imgflip.com/fullid.webp', title: 'Full URL', caption: 'accepted full URL' }),
      row({ id: 'badcount', template_ID: '400', upvote_count: 'not a count', view_count: '1,,2', caption: 'invalid counts' }),
    ]
    const run = runGenerator(makeArchive(rows))
    expect(run.result.status).toBe(0)
    const catalog = readCatalog(run.output)
    expect(catalog.source).toBe(source)
    expect(catalog.archiveSha256).toBe(createHash('sha256').update(readFileSync(run.input)).digest('hex'))
    expect(catalog.memes.map((item) => item.id)).toEqual(['ccc', 'fff', 'aaa', 'ddd', 'fullid', 'badcount'])
    expect(catalog.memes[0]).toMatchObject({
      id: 'ccc',
      name: 'Template A — Gamma',
      caption: 'third caption',
      url: 'https://i.imgflip.com/ccc.jpg',
    })
    expect(catalog.memes.find((item) => item.id === 'aaa')).toMatchObject({
      name: 'Template A — Alpha',
      caption: 'SAME CAPTION',
    })
    expect(catalog.memes.find((item) => item.id === 'fullid')).toMatchObject({
      name: 'Example template — Full URL',
      caption: 'accepted full URL',
      url: 'https://i.imgflip.com/fullid.webp',
    })
  })

  it('drops unsafe URLs, mismatched IDs, empty captions, and malformed records', () => {
    const unsafe = [
      row({ id: 'http', image_url: 'http://i.imgflip.com/http.jpg' }),
      row({ id: 'query', image_url: 'https://i.imgflip.com/query.jpg?x=1' }),
      row({ id: 'port', image_url: 'https://i.imgflip.com:443/port.jpg' }),
      row({ id: 'auth', image_url: 'https://user:i@i.imgflip.com/auth.jpg' }),
      row({ id: 'slash', image_url: 'https://i.imgflip.com/a%2Fslash.jpg' }),
      row({ id: 'upper', image_url: 'https://i.imgflip.com/ABC.jpg' }),
      row({ id: 'wrong', URL: '/i/other' }),
      row({ id: 'empty', alt_text: 'Example title |  | image tagged in memes' }),
      null,
      { template_ID: 'not-numeric' },
    ]
    const run = runGenerator(makeArchive(unsafe))
    expect(run.result.status).toBe(0)
    expect(readCatalog(run.output).memes).toEqual([])
  })

  it('requires one JSON member and preserves existing output on truncated JSON', () => {
    const initial = runGenerator(makeArchive([row({ id: 'keep' })]), 'catalog.json', 'old-output')
    expect(initial.result.status).toBe(0)
    const before = readFileSync(initial.output)

    const truncated = runGenerator(makeRawArchive('[{"template_ID":"100"'), 'catalog.json')
    expect(truncated.result.status).not.toBe(0)
    expect(readFileSync(truncated.output)).toEqual(before)

    const extra = runGenerator(makeArchive([row()], true), 'extra.json')
    expect(extra.result.status).not.toBe(0)
    expect(existsSync(extra.output)).toBe(false)
  })

  it('rejects rows larger than 1 MiB and leaves no partial output', () => {
    const oversized = row({ alt_text: `Example title | ${'x'.repeat(1_100_000)} | made w/ Imgflip meme maker` })
    const run = runGenerator(makeArchive([oversized]), 'oversized.json', 'unchanged')
    expect(run.result.status).not.toBe(0)
    expect(readFileSync(run.output, 'utf8')).toBe('unchanged')
  })

  it('produces deterministic compact output for identical input', () => {
    const bytes = makeArchive([row({ id: 'bbb', upvote_count: '2' }), row({ id: 'aaa', upvote_count: '2' })])
    const first = runGenerator(bytes, 'first.json')
    const firstBytes = readFileSync(first.output)
    const second = runGenerator(bytes, 'second.json')
    expect(second.result.status).toBe(0)
    expect(readFileSync(second.output)).toEqual(firstBytes)
    expect(firstBytes.toString('utf8')).not.toMatch(/\n\s+"/)
  })

  it('handles UTF-8 characters split across input chunks and omits duplicate titles', () => {
    let splitRow: Row | undefined
    for (let paddingLength = 65_000; paddingLength < 66_000 && !splitRow; paddingLength += 1) {
      const candidate = { padding: 'x'.repeat(paddingLength) + 'é', ...row({
        id: 'split',
        template_title: 'Same title',
        title: 'same TITLE',
        caption: 'caption café',
      }) }
      const marker = Buffer.from('é')
      const position = Buffer.from(JSON.stringify([candidate])).indexOf(marker)
      if (position % 65_536 === 65_535) splitRow = candidate
    }
    if (!splitRow) throw new Error('could not construct a UTF-8 chunk-boundary fixture')
    const rows = [splitRow, row({ id: 'other', template_title: 'Same title', title: 'same TITLE', caption: 'another café' })]
    const run = runGenerator(makeArchive(rows))
    expect(run.result.status).toBe(0)
    expect(readCatalog(run.output).memes.map((item) => item.name)).toEqual(['Same title', 'Same title'])
  })
})
