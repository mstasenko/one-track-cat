import { describe, expect, it } from 'vitest'
import type { OnlineTemplate, TemplateSource } from './online-templates'
import { mergeOnlineTemplates } from './online-templates'

function template(source: TemplateSource, id: string, name = `${source}-${id}`): OnlineTemplate {
  return source === 'wikimedia'
    ? { id, source, name, type: 'audio', url: `https://upload.wikimedia.org/wikipedia/commons/a/b/${id}.ogg` }
    : { id, source, name, type: 'image', url: `https://i.imgflip.com/${id}.jpg` }
}

function page(source: TemplateSource, count: number, offset = 0): OnlineTemplate[] {
  return Array.from({ length: count }, (_, index) => template(source, String(offset + index + 1)))
}

describe('mergeOnlineTemplates', () => {
  it('round-robins full provider pages so every provider is represented before the cap', () => {
    const merged = mergeOnlineTemplates({
      memefact: page('memefact', 24),
      imgflip: page('imgflip', 24, 100),
      imkg: page('imkg', 24, 200)
    })

    expect(merged).toHaveLength(24)
    expect(new Set(merged.map((entry) => entry.source))).toEqual(new Set(['memefact', 'imgflip', 'imkg']))
    expect(merged.slice(0, 3).map((entry) => entry.source)).toEqual(['memefact', 'imgflip', 'imkg'])
  })

  it('deduplicates numeric blank-template IDs while keeping IMKG identity exact', () => {
    const merged = mergeOnlineTemplates({
      memefact: [template('memefact', '7', 'MemeFact winner')],
      imgflip: [template('imgflip', '007', 'Imgflip duplicate'), template('imgflip', '9', 'Imgflip nine')],
      imkg: [template('imkg', '007', 'IMKG instance')]
    })

    expect(merged.map((entry) => entry.name)).toEqual(['MemeFact winner', 'Imgflip nine', 'IMKG instance'])
    expect(merged.filter((entry) => entry.id === '007')).toHaveLength(1)
    expect(merged.filter((entry) => entry.source === 'imkg')).toHaveLength(1)
  })

  it('keeps Wikimedia page IDs distinct from numeric blank-template IDs', () => {
    const merged = mergeOnlineTemplates({
      imgflip: [template('imgflip', '123', 'Imgflip')],
      wikimedia: [template('wikimedia', '123', 'Wikimedia')]
    })

    expect(merged.map((entry) => entry.name)).toEqual(['Imgflip', 'Wikimedia'])
  })

  it('lets one provider fill all 24 visible slots and enforces the cap', () => {
    const merged = mergeOnlineTemplates({ memefact: page('memefact', 40) })
    expect(merged).toHaveLength(24)
    expect(merged).toEqual(page('memefact', 24))
  })

  it('is deterministic when complete provider responses arrive in different object order', () => {
    const memefact = [template('memefact', '1'), template('memefact', '2')]
    const imgflip = [template('imgflip', '3'), template('imgflip', '4')]
    const imkg = [template('imkg', '000a'), template('imkg', '000b')]

    expect(mergeOnlineTemplates({ memefact, imgflip, imkg })).toEqual(
      mergeOnlineTemplates({ imkg, imgflip, memefact })
    )
  })

  it('does not starve distinct later-provider results behind duplicate entries', () => {
    const merged = mergeOnlineTemplates({
      memefact: Array.from({ length: 24 }, (_, index) => template('memefact', String(index + 1))),
      imgflip: [template('imgflip', '0001', 'Duplicate'), template('imgflip', '99', 'Distinct Imgflip')],
      imkg: [template('imkg', '0001', 'Distinct IMKG')]
    })

    expect(merged.some((entry) => entry.name === 'Distinct Imgflip')).toBe(true)
    expect(merged.some((entry) => entry.name === 'Distinct IMKG')).toBe(true)
  })
})
