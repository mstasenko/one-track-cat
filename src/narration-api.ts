import type { AudioOverlay, ExportRequest } from './types'
import type { NarrationLanguage } from './narration-cleanup'
import type { NarrationDraft } from './main/narration-analysis'
import type { NarrationOverrun } from './narration'
import type { NarrationSubtitleLine } from './narration-subtitles'

export interface NarrationReview extends NarrationDraft { id: string; overruns?: NarrationOverrun[] }
export interface NarrationProgress { stage: string; fraction: number; etaSeconds?: number }
export const narrationVoiceStyles = ['original', 'conversational', 'cosy', 'calm', 'professional', 'energetic'] as const
export type NarrationVoiceStyle = typeof narrationVoiceStyles[number]
export interface NarrationMixSettings { levelVoice?: boolean; backgroundVolume?: number; slowdown?: number; subtitles?: boolean }
export const narrationSpeechDetectionModes = ['off', 'sensitive', 'balanced', 'strict'] as const
export type NarrationSpeechDetectionMode = typeof narrationSpeechDetectionModes[number]
export const narrationRecognitionAudioSources = ['original', 'speech'] as const
export type NarrationRecognitionAudio = typeof narrationRecognitionAudioSources[number]
export interface NarrationRecognitionSettings { speechDetection: NarrationSpeechDetectionMode; audio?: NarrationRecognitionAudio }
export const narrationDefaultRecognitionSettings: Required<NarrationRecognitionSettings> = { speechDetection: 'balanced', audio: 'original' }
export interface NarrationGeneratedAudio extends AudioOverlay { subtitleLines?: NarrationSubtitleLine[] }
export interface NarrationApi {
  status: () => Promise<{ available: boolean; message: string }>
  analyze: (request: ExportRequest, range: [number, number], language: NarrationLanguage, translateToEnglish?: boolean,
    recognition?: NarrationRecognitionSettings) => Promise<NarrationReview>
  load: (id: string) => Promise<NarrationReview>
  generate: (request: ExportRequest, id: string, reviewed: string, voiceStyle?: NarrationVoiceStyle, mix?: NarrationMixSettings, overlayId?: string) => Promise<NarrationGeneratedAudio | { review: NarrationReview }>
  cancel: () => Promise<void>
  progress: (callback: (value: NarrationProgress) => void) => () => void
}
