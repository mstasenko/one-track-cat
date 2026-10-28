import { narrationVoiceStyles } from '../narration-api'
import { narrationDefaultSlowdown, narrationMaxSlowdown, narrationMaxTextLength } from '../narration'
import { narrationDefaultRecognitionSettings, narrationRecognitionAudioSources, narrationSpeechDetectionModes,
  type NarrationMixSettings, type NarrationRecognitionSettings } from '../narration-api'

export function parseNarrationMixSettings(value: unknown = {}): Required<NarrationMixSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid narration mix settings')
  const mix = value as Record<string, unknown>
  if (Object.keys(mix).some((key) => !['levelVoice', 'backgroundVolume', 'slowdown', 'subtitles'].includes(key)) ||
      (mix.subtitles !== undefined && typeof mix.subtitles !== 'boolean') ||
      (mix.levelVoice !== undefined && typeof mix.levelVoice !== 'boolean') ||
      (mix.backgroundVolume !== undefined && (typeof mix.backgroundVolume !== 'number' ||
        !Number.isFinite(mix.backgroundVolume) || mix.backgroundVolume < 0 || mix.backgroundVolume > 1)) ||
      (mix.slowdown !== undefined && (typeof mix.slowdown !== 'number' ||
        !Number.isFinite(mix.slowdown) || mix.slowdown < 0 || mix.slowdown > narrationMaxSlowdown))) throw new Error('Invalid narration mix settings')
  return { levelVoice: mix.levelVoice === true, backgroundVolume: mix.backgroundVolume ?? 1, slowdown: mix.slowdown ?? narrationDefaultSlowdown, subtitles: mix.subtitles === true }
}

export function parseNarrationRecognitionSettings(value: unknown = {}): NarrationRecognitionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid narration recognition settings')
  const recognition = value as Record<string, unknown>
  if (Object.keys(recognition).some((key) => !['speechDetection', 'audio'].includes(key)) ||
      (recognition.speechDetection !== undefined && !narrationSpeechDetectionModes.includes(recognition.speechDetection as NarrationRecognitionSettings['speechDetection'])) ||
      (recognition.audio !== undefined && !narrationRecognitionAudioSources.includes(recognition.audio as NonNullable<NarrationRecognitionSettings['audio']>))) {
    throw new Error('Invalid narration recognition settings')
  }
  return {
    speechDetection: (recognition.speechDetection as NarrationRecognitionSettings['speechDetection'] | undefined) ?? narrationDefaultRecognitionSettings.speechDetection,
    audio: (recognition.audio as NarrationRecognitionSettings['audio'] | undefined) ?? narrationDefaultRecognitionSettings.audio
  }
}

function validateTranscriptRange(range: unknown): void {
  if (range !== undefined && (!Array.isArray(range) || range.length !== 2 ||
      range.some((item) => typeof item !== 'number' || !Number.isFinite(item)) ||
      range[0] < 0 || range[1] <= range[0] || range[1] > 86_400)) throw new Error('Invalid narration transcript range')
}

export function validateNarrationOverlay(input: Record<string, unknown>): void {
  if (input.narration === undefined) return
  const value = input.narration
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid narration settings')
  const narration = value as Record<string, unknown>
  parseNarrationMixSettings({ levelVoice: narration.levelVoice, backgroundVolume: narration.backgroundVolume, slowdown: narration.slowdown, subtitles: narration.subtitles })
  if (narration.recognition !== undefined) parseNarrationRecognitionSettings(narration.recognition)
  if (narration.voiceStyle !== undefined && !narrationVoiceStyles.some((style) => style === narration.voiceStyle)) throw new Error('Invalid narration voice style')
  if (typeof narration.draftId !== 'string' || !/^[a-f0-9-]{36}$/.test(narration.draftId) ||
    typeof narration.enabled !== 'boolean') throw new Error('Invalid narration draft ID or enabled state')
  if (narration.invalidated !== undefined && typeof narration.invalidated !== 'boolean') throw new Error('Invalid narration validity state')
  if (narration.invalidated && narration.enabled) throw new Error('Reanalyze narration after changing its video speed')
  validateTranscriptRange(narration.transcriptRange)
  for (const field of ['revisions', 'originals']) {
    const texts = narration[field]
    if (texts !== undefined && (!Array.isArray(texts) || texts.length > 100_000 ||
      texts.some((text) => typeof text !== 'string' || text.length > narrationMaxTextLength))) throw new Error('Invalid narration revisions or recognized text')
  }
  if (input.volume !== 1 || input.duckGameAudio || input.fadeIn || input.fadeOut) throw new Error('Narration uses its original background level')
}
