import { describe, expect, it } from 'vitest'
import { fallbackNarrationSentenceBoundaries, narrationPhrasesFromSentenceBoundaries, narrationSentenceBatches, narrationSentenceMessages, parseNarrationSentenceBoundaries,
  type NarrationSentenceBatch } from './narration-sentences'

function words(count: number, punctuation = true) {
  return Array.from({ length: count }, (_, index) => ({ start: index * 0.3, end: index * 0.3 + 0.2,
    text: punctuation && (index + 1) % 10 === 0 ? `word${index}.` : `word${index}` }))
}

function batch(coreStart = 5, coreEnd = 10): NarrationSentenceBatch {
  return { words: words(20, false).map((word, index) => ({ ...word, index })), coreStart, coreEnd }
}

function sourceBatch(source: readonly { start: number; end: number; text: string }[]): NarrationSentenceBatch {
  return { words: source.map((word, index) => ({ ...word, index })), coreStart: 0, coreEnd: source.length }
}

describe('Narration sentence segmentation', () => {
  it('creates contiguous cores with eight-word context', () => {
    const result = narrationSentenceBatches(words(260))
    expect(result[0]?.coreStart).toBe(0)
    expect(result.at(-1)?.coreEnd).toBe(260)
    for (const [index, current] of result.entries()) {
      expect(current.coreEnd).toBe(result[index + 1]?.coreStart ?? 260)
      expect(current.words[0]?.index).toBe(Math.max(0, current.coreStart - 8))
      expect(current.words.at(-1)?.index).toBe(Math.min(260, current.coreEnd + 8) - 1)
    }
  })

  it('extends past the preferred limit to a punctuation boundary', () => {
    const input = Array.from({ length: 130 }, (_, index) => ({ start: index * 0.1, end: index * 0.1 + 0.05,
      text: index === 125 ? 'sentence.' : `word${index}` }))
    expect(narrationSentenceBatches(input)[0]?.coreEnd).toBe(126)
  })

  it('isolates an implausibly stretched ASR word from neighboring cores', () => {
    const result = narrationSentenceBatches([
      { start: 0, end: 0.2, text: 'Before' }, { start: 1, end: 19, text: 'так' },
      { start: 20, end: 20.2, text: 'After.' }
    ])
    expect(result.map(({ coreStart, coreEnd }) => [coreStart, coreEnd])).toEqual([[0, 1], [1, 2], [2, 3]])
  })

  it('recovers source-owned boundaries after an untrusted model response', () => {
    const source = [
      { start: 0, end: 0.2, text: 'WD-40.' },
      { start: 0.3, end: 0.5, text: 'тому,' },
      { start: 0.6, end: 0.8, text: 'не' },
      { start: 0.9, end: 1.1, text: 'случилось.' },
      { start: 1.9, end: 2.1, text: '3.5' },
      { start: 2.2, end: 2.4, text: 'готово.' }
    ]
    const current = sourceBatch(source)
    expect(() => parseNarrationSentenceBoundaries('{"sentences":["WD-40. тому, не случилось. 3.5 готово."]', current)).toThrow('not JSON')
    const boundaries = fallbackNarrationSentenceBoundaries(current)
    expect(boundaries).toEqual([
      { startWord: 0, endWord: 1 },
      { startWord: 1, endWord: 4 },
      { startWord: 4, endWord: 6 }
    ])
    expect(narrationPhrasesFromSentenceBoundaries(source, boundaries).map(({ text }) => text))
      .toEqual(['WD-40.', 'тому, не случилось.', '3.5 готово.'])
  })

  it('keeps only ends owned by the core when a phrase crosses its context edge', () => {
    const source = [
      { start: 0, end: 0.2, text: 'Before.' },
      { start: 0.3, end: 0.5, text: 'тому,' },
      { start: 0.6, end: 0.8, text: 'не' },
      { start: 0.9, end: 1.1, text: 'сломано.' },
      { start: 1.9, end: 2.1, text: 'Next.' }
    ]
    const current: NarrationSentenceBatch = { words: source.map((word, index) => ({ ...word, index })), coreStart: 2, coreEnd: 5 }
    expect(fallbackNarrationSentenceBoundaries(current)).toEqual([
      { startWord: 1, endWord: 4 },
      { startWord: 4, endWord: 5 }
    ])
  })

  it('uses source segmentation rather than ambiguous duplicate end timestamps', () => {
    const source = [
      { start: 0, end: 0.5, text: 'Keep' },
      { start: 0.5, end: 0.5, text: 'тому,' },
      { start: 0.6, end: 0.8, text: 'не' },
      { start: 0.8, end: 0.8, text: 'сломано.' }
    ]
    const boundaries = fallbackNarrationSentenceBoundaries(sourceBatch(source))
    expect(boundaries).toEqual([{ startWord: 0, endWord: 4 }])
    expect(narrationPhrasesFromSentenceBoundaries(source, boundaries)[0]?.text).toBe('Keep тому, не сломано.')
  })

  it('asks for restored punctuation over an overlapping transcript', () => {
    const current = narrationSentenceBatches(words(260))[1]
    if (!current) throw new Error('Missing middle batch')
    const messages = narrationSentenceMessages(current)
    const system = messages[0]?.content ?? ''
    const user = JSON.parse(messages[1]?.content ?? '{}') as { transcript: string; before?: unknown; after?: unknown; core?: unknown }
    expect(system).toContain('Restore missing sentence-ending punctuation')
    expect(system).toContain('overlaps neighboring requests')
    expect(system).toContain('do not force a sentence break at either edge')
    expect(system).toContain('Do not return timestamps')
    expect(system).toContain('"sentences"')
    expect(system).toContain('сняли крышку теперь откручиваем болт')
    expect(user.transcript).toBe(current.words.map(({ text }) => text).join(' '))
    expect(user.before).toBeUndefined()
    expect(user.after).toBeUndefined()
    expect(user.core).toBeUndefined()
  })

  it('omits indexes and pause cues from model input', () => {
    const current = narrationSentenceBatches([
      { start: 0, end: 0.1, text: 'First' }, { start: 0.45, end: 0.55, text: 'second' }
    ])[0]
    if (!current) throw new Error('Missing sentence batch')
    const user = JSON.parse(narrationSentenceMessages(current)[1]?.content ?? '{}') as { transcript: string; core?: unknown }
    expect(user).toEqual({ transcript: 'First second' })
    expect(user.core).toBeUndefined()
  })

  it('accepts an exhaustive monotonic partition', () => {
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [
      'word0 word1 word2 word3 word4', 'word5 word6', 'word7 word8 word9',
      'word10 word11 word12 word13 word14 word15 word16 word17 word18 word19'
    ] }), batch())).toEqual([
      { startWord: 5, endWord: 7 }, { startWord: 7, endWord: 10 }
    ])
  })

  it('normalizes punctuation and case but rejects lexical changes or inside-word cuts', () => {
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [
      'word0 word1 word2 word3 word4', 'WORD5, WORD6.', 'word7 word8 word9!',
      'word10 word11 word12 word13 word14 word15 word16 word17 word18 word19'
    ] }), batch())).toHaveLength(2)
    for (const sentences of [
      ['word0 word1 word2 word3 word4', 'word5 word6'],
      ['word0 word1 word2 word3 word4', 'word5 changed', 'word7 word8 word9', 'word10 word11 word12 word13 word14 word15 word16 word17 word18 word19'],
      ['word0 word1 word2 word3 word4', 'word', '5 word6 word7 word8 word9', 'word10 word11 word12 word13 word14 word15 word16 word17 word18 word19'],
      ['word0 word1 word2 word3 word4', 'word5 word6 😀', 'word7 word8 word9', 'word10 word11 word12 word13 word14 word15 word16 word17 word18 word19']
    ]) {
      expect(() => parseNarrationSentenceBoundaries(JSON.stringify({ sentences }), batch())).toThrow()
    }
  })

  it('returns only sentence ends owned by an overlapping core', () => {
    const source = words(20, false).map((word, index) => ({ ...word, index }))
    const restored = JSON.stringify({ sentences: [
      'word0 word1 word2.', 'word3 word4 word5 word6 word7.',
      'word8 word9 word10 word11 word12 word13.', 'word14 word15 word16 word17 word18 word19.'
    ] })
    const ownedEnds = [0, 5, 10, 15].flatMap((coreStart) => parseNarrationSentenceBoundaries(restored, {
      words: source, coreStart, coreEnd: Math.min(20, coreStart + 5)
    }))
    expect(ownedEnds.map(({ endWord }) => endWord)).toEqual([3, 8, 14, 20])
    const boundaries = ownedEnds.map(({ endWord }, index) => ({ startWord: index === 0 ? 0 : ownedEnds[index - 1]?.endWord ?? 0, endWord }))
    expect(narrationPhrasesFromSentenceBoundaries(source, boundaries)).toHaveLength(4)
  })

  it('does not force a boundary at a core edge when a sentence continues through a pause', () => {
    const source = words(20, false).map((word, index) => ({ ...word, index }))
    const current: NarrationSentenceBatch = { words: source, coreStart: 5, coreEnd: 10 }
    const transcript = source.map(({ text }) => text).join(' ') + '.'
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [transcript] }), current)).toEqual([])
  })

  it('tolerates omitted Cyrillic hesitation words only during matching', () => {
    const input = [
      { start: 0, end: 0.2, text: 'похоже' }, { start: 0.3, end: 0.5, text: 'а' },
      { start: 0.6, end: 0.8, text: 'дело' }, { start: 0.9, end: 1.1, text: 'закончено' }
    ]
    const current = sourceBatch(input)
    const boundaries = parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['похоже дело закончено.'] }), current)
    expect(boundaries).toEqual([{ startWord: 0, endWord: 4 }])
    expect(narrationPhrasesFromSentenceBoundaries(input, boundaries)[0]?.text).toBe('похоже а дело закончено')
    expect(() => parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['похоже закончено.'] }), current)).toThrow(/дело/)
    const englishA = sourceBatch([
      { start: 0, end: 0.2, text: 'This' }, { start: 0.3, end: 0.5, text: 'a' }, { start: 0.6, end: 0.8, text: 'test' }
    ])
    expect(() => parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['This test.'] }), englishA)).toThrow(/a/)
  })

  it('accepts a filler-only core even when the model returns no comparable text', () => {
    const current = sourceBatch([{ start: 0, end: 15, text: 'а' }])
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['а'] }), current)).toEqual([{ startWord: 0, endWord: 1 }])
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [''] }), current)).toEqual([{ startWord: 0, endWord: 1 }])
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [] }), current)).toEqual([{ startWord: 0, endWord: 1 }])
  })

  it('splits several lowercase sentences restored inside one array entry', () => {
    const input = [
      { start: 0, end: 0.2, text: 'отсоединили' }, { start: 0.3, end: 0.5, text: 'батарею' },
      { start: 0.6, end: 0.8, text: 'теперь' }, { start: 0.9, end: 1.1, text: 'откручиваем' },
      { start: 1.2, end: 1.4, text: 'болт' }, { start: 1.5, end: 1.7, text: 'честно' },
      { start: 1.8, end: 2, text: 'говоря' }, { start: 2.1, end: 2.3, text: 'снимаем' },
      { start: 2.4, end: 2.6, text: 'крышку' }
    ]
    const current = narrationSentenceBatches(input)[0]
    if (!current) throw new Error('Missing sentence batch')
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [
      'отсоединили батарею. теперь откручиваем болт. честно говоря снимаем крышку.'
    ] }), current)).toEqual([
      { startWord: 0, endWord: 2 }, { startWord: 2, endWord: 5 }, { startWord: 5, endWord: 9 }
    ])
  })

  it('does not split decimal numbers or abbreviations while restoring sentences', () => {
    const input = [
      { start: 0, end: 0.2, text: 'Проверили' }, { start: 0.3, end: 0.5, text: 'т.д.' },
      { start: 0.6, end: 0.8, text: 'значение' }, { start: 0.9, end: 1.1, text: '3.5' },
      { start: 1.2, end: 1.4, text: 'готово' }, { start: 1.5, end: 1.7, text: 'теперь' },
      { start: 1.8, end: 2, text: 'стоп' }
    ]
    const current = narrationSentenceBatches(input)[0]
    if (!current) throw new Error('Missing sentence batch')
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: [
      'Проверили т.д. значение 3.5 готово. теперь стоп.'
    ] }), current)).toEqual([
      { startWord: 0, endWord: 5 }, { startWord: 5, endWord: 7 }
    ])
  })

  it('rejects one unpunctuated sentence over 30 seconds but accepts a short one', () => {
    const long = sourceBatch([
      { start: 0, end: 0.2, text: 'First' }, { start: 15, end: 15.2, text: 'long' },
      { start: 31, end: 31.2, text: 'sentence' }
    ])
    expect(() => parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['First long sentence.'] }), long)).toThrow(/30 seconds/)

    const short = sourceBatch([
      { start: 0, end: 0.2, text: 'First' }, { start: 10, end: 10.2, text: 'short' },
      { start: 20, end: 20.2, text: 'sentence' }
    ])
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['First short sentence.'] }), short)).toEqual([
      { startWord: 0, endWord: 3 }
    ])
  })

  it('keeps common English abbreviations inside the restored sentence', () => {
    const current = sourceBatch([
      { start: 0, end: 0.2, text: 'We' }, { start: 0.3, end: 0.5, text: 'met' },
      { start: 0.6, end: 0.8, text: 'Dr' }, { start: 0.9, end: 1.1, text: 'Smith' },
      { start: 1.2, end: 1.4, text: 'Then' }, { start: 1.5, end: 1.7, text: 'left' }
    ])
    expect(parseNarrationSentenceBoundaries(JSON.stringify({ sentences: ['We met Dr. Smith. Then left.'] }), current)).toEqual([
      { startWord: 0, endWord: 4 }, { startWord: 4, endWord: 6 }
    ])
  })

  it('constructs phrase text and anchors from original words, never model output', () => {
    const input = [{ start: 1, end: 1.2, text: 'Can' }, { start: 1.3, end: 1.6, text: 'I?' },
      { start: 3, end: 3.4, text: 'Stop.' }]
    expect(narrationPhrasesFromSentenceBoundaries(input, [{ startWord: 0, endWord: 2 }, { startWord: 2, endWord: 3 }]))
      .toEqual([
        { id: 'phrase-0', start: 1, end: 1.6, text: 'Can I?', revisedText: 'Can I?', needsTimingReview: false },
        { id: 'phrase-1', start: 3, end: 3.4, text: 'Stop.', revisedText: 'Stop.', needsTimingReview: false }
      ])
  })

  it('retains a bounded first voice reference for a long sentence and flags bad words', () => {
    const input = [{ start: 0, end: 2, text: 'First' }, { start: 2.1, end: 13, text: 'long' },
      { start: 12, end: 14, text: 'overlap.' }]
    expect(narrationPhrasesFromSentenceBoundaries(input, [{ startWord: 0, endWord: 3 }])).toEqual([{
      id: 'phrase-0', start: 0, end: 14, text: 'First long overlap.', revisedText: 'First long overlap.', needsTimingReview: true,
      referenceEnd: 2, referenceText: 'First'
    }])
  })

  it.each([
    { sentences: ['word5 word6'] },
    { sentences: ['word5 word6', 'word7 word8'] },
    { sentences: ['word5', 'word5', 'word6 word7 word8 word9'] },
    { sentences: ['word5 word6', 'word7 word8 word9'], explanation: 'not allowed' },
    { chunks: [{ startWord: 5, endWord: 10 }] }
  ])('rejects malformed output: %#', (response) => {
    expect(() => parseNarrationSentenceBoundaries(JSON.stringify(response), batch())).toThrow()
  })
})
