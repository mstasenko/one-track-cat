import { describe, expect, it } from 'vitest'
import { parseNarrationMixSettings, parseNarrationRecognitionSettings, validateNarrationOverlay } from './narration-validation'

describe('Re-voice settings', () => {
  it('defaults recognition to speech detection with ordinary decoding', () => {
    expect(parseNarrationRecognitionSettings()).toEqual({ speechDetection: 'balanced', audio: 'original' })
    expect(parseNarrationRecognitionSettings({ speechDetection: 'sensitive', audio: 'speech' })).toEqual({ speechDetection: 'sensitive', audio: 'speech' })
  })
  it.each([null, [], 'settings', { speechDetection: true }, { speechDetection: 'true' }, { speechDetection: 'unknown' },
    { audio: true }, { audio: 'cleaned' }, { legacy: false }, { unknown: false }])(
    'rejects malformed recognition settings %#', (value) => {
      expect(() => parseNarrationRecognitionSettings(value)).toThrow('Invalid narration recognition')
    })
  it('defaults to the existing mix and accepts muted backgrounds', () => {
    expect(parseNarrationMixSettings()).toEqual({ levelVoice: false, backgroundVolume: 1, slowdown: 0, subtitles: false })
    expect(parseNarrationMixSettings({ levelVoice: true, backgroundVolume: 0, slowdown: 0.5 })).toEqual({ levelVoice: true, backgroundVolume: 0, slowdown: 0.5, subtitles: false })
  })
  it.each([null, [], 'mix', { command: 'invalid' }, { levelVoice: 1 }, { levelVoice: 'true' },
    { backgroundVolume: NaN }, { backgroundVolume: Infinity }, { backgroundVolume: -1 },
    { backgroundVolume: 1.01 }, { backgroundVolume: '0.5' }, { slowdown: NaN }, { slowdown: Infinity },
    { slowdown: -0.01 }, { slowdown: 0.51 }, { slowdown: '0.15' }, { subtitles: 1 }, { subtitles: 'true' }])('rejects malformed mix settings %#', (value) => {
    expect(() => parseNarrationMixSettings(value)).toThrow('Invalid narration mix')
  })
  it('accepts old saved effects and validates new settings before saving', () => {
    const narration = { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true }
    expect(() => validateNarrationOverlay({ volume: 1, narration })).not.toThrow()
    expect(() => validateNarrationOverlay({ volume: 1,
      narration: { ...narration, levelVoice: true, backgroundVolume: 0.5, slowdown: 0.25 } })).not.toThrow()
    expect(() => validateNarrationOverlay({ volume: 1,
      narration: { ...narration, recognition: { speechDetection: 'strict' } } })).not.toThrow()
    expect(() => validateNarrationOverlay({ volume: 1,
      narration: { ...narration, recognition: { audio: 'speech' } } })).not.toThrow()
    expect(() => validateNarrationOverlay({ volume: 1, narration: { ...narration, levelVoice: 5 } })).toThrow('mix')
    expect(() => validateNarrationOverlay({ volume: 1, narration: { ...narration, slowdown: 0.51 } })).toThrow('mix')
    expect(() => validateNarrationOverlay({ volume: 1,
      narration: { ...narration, recognition: { speechDetection: 'strict', extra: true } } })).toThrow('recognition')
  })
})
