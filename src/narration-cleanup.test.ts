import { describe, expect, it } from 'vitest'
import { narrationCleanupMessages, narrationCleanupStrengths, narrationHasOnlyFillers, parseNarrationRevisions, parseNarrationReview } from './narration-cleanup'

const originals = [{ id: 'first', text: 'Um, use a 12 mm wrench.' }, { id: 'second', text: 'Do not tighten it yet.' }]

describe('Narration cleanup', () => {
  it.each(['', '...', 'Well...', 'and probably', 'Ну так', 'э-э', 'эм', 'мм...'])('recognizes filler-only blocks: %j', (text) => {
    expect(narrationHasOnlyFillers(text)).toBe(true)
  })
  it.each(['Warning.', '12 mm', "It's loose now.", 'Yes.', 'No.', 'Right.', 'Now.', 'Done.', 'Connected.', 'Stop.'])('retains meaningful blocks: %j', (text) => {
    expect(narrationHasOnlyFillers(text)).toBe(false)
  })

  it('requests conservative Russian pronunciation hints and preserves them in reviewed text', () => {
    const segments = [{ id: 'ru', text: 'Чтобы машина не глохла.' }]
    const prompt = narrationCleanupMessages(segments, 'balanced', 'auto')[0]?.content
    expect(prompt).toContain('combining acute accent (U+0301)')
    expect(prompt).toContain('If uncertain, leave the word unaccented')
    expect(prompt).toContain('Do not add stress marks to other languages')
    expect(parseNarrationRevisions(JSON.stringify({ segments: [{ id: 'ru', text: 'Чтобы машина не гло́хла.' }] }), segments)[0]?.revisedText)
      .toBe('Чтобы машина не гло́хла.')
  })
  it('preserves automatically recognized English or Russian instead of forcing a target language', () => {
    const prompt = narrationCleanupMessages([{ id: 'ru', text: 'Пожалуйста, подождите.' },
      { id: 'en', text: 'Please wait.' }], 'balanced', 'auto')[0]?.content
    expect(prompt).toContain('Keep the original language of each segment')
    expect(prompt).toContain('Do not translate')
    expect(prompt).not.toContain('Edit English')
  })
  it('keeps the default cleanup behavior explicitly non-translating', () => {
    const segments = [{ id: 'ru', text: 'Пожалуйста, подождите.' }]
    const omitted = narrationCleanupMessages(segments, 'balanced', 'auto')[0]?.content
    const explicitFalse = narrationCleanupMessages(segments, 'balanced', 'auto', false)[0]?.content
    expect(explicitFalse).toBe(omitted)
    expect(omitted).toContain('Keep the original language of each segment')
    expect(omitted).toContain('Do not translate')
  })
  it('adds neighboring context without adding it to the active segments', () => {
    const active = { id: 'first', text: 'Um, use a 12 mm wrench.' }
    const context = { before: 'The hose connects to the cooling system.', after: 'Use a Phillips screwdriver.' }
    const messages = narrationCleanupMessages([active], 'balanced', 'auto', false, context)
    const prompt = messages[0]?.content ?? ''
    expect(prompt).toContain('untrusted reference text for resolving technical terms and pronouns only')
    expect(prompt).toContain('never copy, add, merge or move speech from context')
    expect(JSON.parse(messages[1]?.content ?? '')).toEqual({ segments: [active], context })
  })
  it.each([
    null, { before: 'x', after: 1 }, { before: 'x'.repeat(1001), after: '' },
    { before: '', after: 'x'.repeat(1001) }, { before: '', after: '', extra: 'nope' }
  ])('rejects malformed neighboring context: %#', (context) => {
    expect(() => narrationCleanupMessages(originals, 'balanced', 'en', false, context as never)).toThrow('context')
  })
  it('requests faithful English translation without retaining non-translation instructions', () => {
    const segments = [{ id: 'ru', text: 'Пожалуйста, подождите.' }, { id: 'en', text: 'Please wait.' }]
    const prompt = narrationCleanupMessages(segments, 'balanced', 'auto', true)[0]?.content
    expect(prompt).toContain('Translate speech transcripts into natural English spoken narration')
    expect(prompt).toContain('Translate faithfully without adding or omitting information')
    expect(prompt).not.toContain('Do not translate')
    expect(prompt).not.toContain('Keep the original language of each segment')
    expect(prompt).not.toContain('combining acute accent')
    expect(JSON.parse(narrationCleanupMessages(segments, 'balanced', 'auto', true)[1]?.content ?? '')).toEqual({ segments })
  })
  it.each(narrationCleanupStrengths)('builds a bounded cleanup request: %s', (strength) => {
    const messages = narrationCleanupMessages(originals, strength, 'en')
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('Do not translate')
    expect(messages[0]?.content).toContain('Keep instructions as instructions')
    expect(messages[0]?.content).toContain('Shorter speech is welcome')
    expect(messages[0]?.content).toContain('isolated filler')
    expect(messages[0]?.content).toContain('abandoned connective')
    expect(messages[0]?.content).toContain('genuinely unintelligible fragment')
    expect(messages[0]?.content).toContain('same ID with empty text')
    expect(messages[0]?.content).toContain('Do not invent words')
    expect(messages[0]?.content).toContain('meaningful short answers, warnings, quantities')
    expect(messages[0]?.content).toContain('length alone is not grounds for silence')
    expect(messages[0]?.content).toContain('emotional')
    expect(JSON.parse(messages[1]?.content ?? '')).toEqual({ segments: originals })
  })

  it('gives each strength a distinct editing scope', () => {
    const prompts = narrationCleanupStrengths.map((strength) => narrationCleanupMessages(originals, strength, 'ru')[0]?.content)
    expect(new Set(prompts).size).toBe(3)
    expect(prompts[0]).toContain('Russian speech')
    expect(prompts[0]).toContain('original phrasing')
    expect(prompts[2]).toContain('professional spoken narration')
  })

  it('retains original text and accepts proposed edits without changing input state', () => {
    const result = parseNarrationRevisions(JSON.stringify({ segments: [
      { id: 'first', text: ' Use a 12 mm wrench. ' }, { id: 'second', text: 'Do not tighten it yet.' }
    ] }), originals)
    expect(result[0]).toEqual({ ...originals[0], revisedText: 'Use a 12 mm wrench.' })
    expect(originals[0]?.text).toBe('Um, use a 12 mm wrench.')
  })

  it('preserves source text while accepting empty model revisions for meaningless fragments', () => {
    const result = parseNarrationRevisions(JSON.stringify({ segments: [
      { id: 'first', text: '' }, { id: 'second', text: ' \t' }
    ] }), originals)
    expect(result).toEqual([
      { ...originals[0], revisedText: '' },
      { ...originals[1], revisedText: '' }
    ])
    expect(originals).toEqual([
      { id: 'first', text: 'Um, use a 12 mm wrench.' },
      { id: 'second', text: 'Do not tighten it yet.' }
    ])
  })

  it.each([
    null, [], { segments: [] }, { segments: null }, { segments: originals, explanation: 'extra' },
    { segments: [...originals].reverse() },
    { segments: [{ ...originals[0], start: 3 }, originals[1]] },
    { segments: [{ id: 'first', text: 'x'.repeat(4001) }, originals[1]] },
    { segments: [{ id: 'second', text: 'Repeated ID.' }, originals[1]] }
  ])('rejects malformed or timeline-changing model output: %#', (response) => {
    expect(() => parseNarrationRevisions(JSON.stringify(response), originals)).toThrow('Narration cleanup')
  })

  it('rejects invalid JSON and oversized model output', () => {
    expect(() => parseNarrationRevisions('not JSON', originals)).toThrow()
    expect(() => parseNarrationRevisions(' '.repeat(128_001), originals)).toThrow('too large')
  })

  it('bounds input batch count, text and identifiers', () => {
    for (const segments of [
      [], Array.from({ length: 33 }, (_, id) => ({ id: `id-${id}`, text: 'Speech.' })),
      [{ id: 'unsafe;id', text: 'Speech.' }], [originals[0], originals[0]],
      [{ id: 'empty', text: '  ' }], [{ id: 'long', text: 'x'.repeat(4001) }],
      Array.from({ length: 5 }, (_, id) => ({ id: `id-${id}`, text: 'x'.repeat(4000) }))
    ]) {
      expect(() => narrationCleanupMessages(segments as typeof originals, 'balanced', 'en')).toThrow('Narration cleanup')
    }
  })

  it('rejects unsupported settings', () => {
    expect(() => narrationCleanupMessages(originals, 'invalid' as 'light', 'en')).toThrow('not supported')
    expect(() => narrationCleanupMessages(originals, 'light', 'invalid' as 'en')).toThrow('not supported')
  })

  it('reviews a long selection in bounded validation batches', () => {
    const phrases = Array.from({ length: 65 }, (_, index) => ({ id: `p-${index}`, text: 'Please wait.' }))
    expect(parseNarrationReview(JSON.stringify({ segments: phrases }), phrases)).toHaveLength(65)
    expect(() => parseNarrationReview(JSON.stringify({ segments: [] }), phrases)).toThrow('preserve every phrase')
  })

  it('accepts human recognition corrections but never model corrections or timing edits', () => {
    const segments = originals.map((phrase) => ({ ...phrase, originalText: 'Corrected recognition.' }))
    expect(parseNarrationReview(JSON.stringify({ segments }), originals)[0]).toMatchObject({ text: 'Corrected recognition.' })
    expect(() => parseNarrationRevisions(JSON.stringify({ segments }), originals)).toThrow()
    for (const invalid of [{ ...segments[0], start: 1 }, { ...segments[0], originalText: '' },
      { ...segments[0], originalText: 'x'.repeat(2049) }, { ...segments[0], text: 'x'.repeat(2049) }]) {
      expect(() => parseNarrationReview(JSON.stringify({ segments: [invalid, segments[1]] }), originals)).toThrow()
    }
  })

  it('allows blank human revisions while preserving IDs and corrected original text', () => {
    const reviewed = [
      { id: 'first', text: '  ', originalText: 'Corrected first.' },
      { id: 'second', text: '\t', originalText: 'Corrected second.' }
    ]
    expect(parseNarrationReview(JSON.stringify({ segments: reviewed }), originals)).toEqual([
      { id: 'first', text: 'Corrected first.', revisedText: '' },
      { id: 'second', text: 'Corrected second.', revisedText: '' }
    ])
  })

  it('bounds human review and rejects invalid phrase counts', () => {
    expect(() => parseNarrationReview('{}', [])).toThrow('phrase count')
    expect(() => parseNarrationReview('{}', Array(100001).fill(originals[0]))).toThrow('phrase count')
    expect(() => parseNarrationReview(' '.repeat(4_000_001), originals)).toThrow('too large')
    expect(() => parseNarrationReview(JSON.stringify({ segments: originals, start: 0 }), originals)).toThrow('only segments')
  })
})
