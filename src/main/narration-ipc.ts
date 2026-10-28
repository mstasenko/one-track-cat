import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExportRequest } from '../types'
import type { NarrationReview, NarrationProgress, NarrationGeneratedAudio } from '../narration-api'
import { narrationSubtitleLines, type NarrationSubtitleLine } from '../narration-subtitles'
import { narrationVoiceStyles, type NarrationVoiceStyle } from '../narration-api'
import type { SessionPathRegistry } from './path-registry'
import type { NarrationLanguage } from '../narration-cleanup'
import { analyzeNarration, approveNarrationDraft, storedNarrationVoiceReference, requireCurrentNarration } from './narration-analysis'
import { narrationInputArgs } from './narration-input'
import { narrationFfmpeg } from './narration-audio'
import { generateNarrationAudio } from './narration-generate'
import { NarrationWorker, requireVoicePack } from './narration-worker'
import { hasActiveJobs } from './jobs'
import { NarrationTimingError } from '../narration'
import { ensureNarrationModels } from './narration-models'
import { parseNarrationMixSettings, parseNarrationRecognitionSettings } from './narration-validation'
import { normalizeNarrationTiming, skipUnalignedNarrationWords } from '../narration-transcript'
import { prepareNarrationSlice, upgradeLegacyDraft } from './narration-slice'
import { prepareNarrationVoiceReference } from './narration-reference'

const models = 'whisper-large-v3-fp16;qwen3.5-4b-int8;voxcpm2-fp16;mossformer2-fp32;v1'
const root = (): string => join(app.getPath('userData'), 'narration')
let active: { controller: AbortController; worker: NarrationWorker } | undefined
export async function shutdownNarration(): Promise<void> {
  active?.controller.abort()
  active?.worker.close(true)
  await active?.worker.stopped()
}

export async function clearNarrationCache(): Promise<void> {
  if (active || hasActiveJobs()) return
  // Reset/new project forgets Undo as well. Never follow a substituted cache
  // directory, and never remove media while an export still reads it.
  if ((await lstat(root()).catch(() => undefined))?.isDirectory()) await rm(root(), { recursive: true })
}
function checkedId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid narration draft ID')
  return value
}

export function registerNarrationIpc(paths: SessionPathRegistry,
  trusted: (value: unknown, paths: SessionPathRegistry) => Promise<ExportRequest>): void {
  const load = async (value: unknown): Promise<NarrationReview> => {
    const id = checkedId(value)
    const draft = JSON.parse(await readFile(join(root(), id, 'draft.json'), 'utf8')) as NarrationReview
    return { ...draft, phrases: skipUnalignedNarrationWords(normalizeNarrationTiming(draft.phrases)) }
  }
  const projectReference = async (current: ExportRequest, fallback: NarrationReview) => {
    const overlays = current.overlays.filter((item) => item.type === 'audio' && item.narration)
    for (const overlay of overlays) {
      if (overlay.type !== 'audio' || !overlay.narration) continue
      const saved = await load(overlay.narration.draftId).catch(() => undefined)
      // Only an established sample is shared. A newly recognized, earlier
      // section must not replace the first Re-voice section's original voice.
      if (!saved) continue
      const reference = storedNarrationVoiceReference(saved)
      if (reference) return reference
    }
    return storedNarrationVoiceReference(fallback)
  }

  const request = async (value: unknown): Promise<ExportRequest> => {
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const outputPath = await paths.allowWrite(join(root(), 'unused.mp4'))
    // Renderer chooses neither a privileged worker path nor its output directory.
    return trusted({ ...(value as object), outputPath }, paths)
  }
  const run = async <T>(send: (value: NarrationProgress) => void, pack: string,
    action: (worker: NarrationWorker, signal: AbortSignal, modelDirectory: string) => Promise<T>): Promise<T> => {
    if (active) throw new Error('Another narration operation is still releasing its models')
    const controller = new AbortController()
    let stage = ''
    let started = Date.now()
    const worker = new NarrationWorker((value) => {
      if (stage !== value.stage) { stage = value.stage; started = Date.now() }
      const etaSeconds = value.fraction > 0 ? (Date.now() - started) / 1000 * (1 - value.fraction) / value.fraction : undefined
      send({ ...value, etaSeconds })
    })
    active = { controller, worker }
    try {
      const modelDirectory = await ensureNarrationModels(pack, controller.signal, send)
      return await action(worker, controller.signal, modelDirectory)
    }
    finally { worker.close(); await worker.stopped(); active = undefined }
  }
  ipcMain.handle('narration:status', async () => {
    try { await requireVoicePack(); return { available: true, message: 'Voice pack ready. Processing stays on this computer.' } }
    catch (error) { return { available: false, message: String(error) } }
  })
  ipcMain.handle('narration:load', (_event, id: unknown) => load(id))
  ipcMain.handle('narration:cancel', () => { active?.controller.abort(); active?.worker.close(true) })
  ipcMain.handle('narration:analyze', async (event, value: unknown, range: [number, number],
    language: NarrationLanguage, translateToEnglish: unknown = false, recognition: unknown = {}) => {
    if (typeof translateToEnglish !== 'boolean') throw new Error('Invalid narration translation setting')
    const recognitionSettings = parseNarrationRecognitionSettings(recognition)
    const current = await request(value)
    const pack = await requireVoicePack()
    return run((progress) => event.sender.send('narration:progress', progress), pack, async (worker, signal, modelDirectory) => {
      const id = randomUUID()
      const directory = join(root(), id)
      await mkdir(directory, { mode: 0o700 })
      const draft = await analyzeNarration(current, range, { language, strength: 'balanced', translateToEnglish, recognition: recognitionSettings }, models, {
        renderAudio: async (input, selection) => {
          event.sender.send('narration:progress', { stage: 'Preparing selected audio', fraction: 0 })
          const output = join(directory, 'original.wav')
          await narrationFfmpeg(narrationInputArgs(input, selection, output), signal)
          await worker.start(pack, false, modelDirectory)
          return output
        },
        separate: async (input) => await worker.request({ action: 'separate', input,
          speech: join(directory, 'speech.wav'), background: join(directory, 'background.wav') }) as { speechPath: string; backgroundPath: string },
        transcribe: (input, selectedLanguage) => worker.request({ action: 'transcribe',
          ...(recognitionSettings.audio === 'original' ? { input: join(directory, 'original.wav'), vadInput: input } : { input }),
          language: selectedLanguage,
          speechDetection: recognitionSettings.speechDetection !== 'off',
          vadThreshold: recognitionSettings.speechDetection === 'sensitive' ? 0.35
            : recognitionSettings.speechDetection === 'strict' ? 0.7 : 0.5 }),
        rewrite: async (batches) => await worker.request({ action: 'rewrite', batches }) as string[]
      }, signal)
      const review: NarrationReview = { ...draft, id }
      await writeFile(join(directory, 'draft.json'), JSON.stringify(review), { flag: 'wx', mode: 0o600 })
      await paths.allowRead(review.originalPath)
      return review
    })
  })
  ipcMain.handle('narration:generate', async (event, value: unknown, id: unknown, reviewed: string,
    voiceStyle: NarrationVoiceStyle = 'original', mix: unknown = {}, overlayId?: unknown) => {
    const settings = parseNarrationMixSettings(mix)
    if (!narrationVoiceStyles.includes(voiceStyle)) throw new Error('Invalid narration voice style')
    const current = await request(value)
    const saved = await load(id)
    if (saved.stage !== 'cleaned') throw new Error('Recognize again before generating narration')
    const selectedOverlay = overlayId === undefined ? undefined : current.overlays.find((item) =>
      item.id === overlayId && item.type === 'audio' && item.narration?.draftId === saved.id)
    if (overlayId !== undefined && selectedOverlay?.type !== 'audio') throw new Error('This Re-voice section changed; reopen it')
    const pack = await requireVoicePack()
    return run((progress) => event.sender.send('narration:progress', progress), pack, async (worker, signal, modelDirectory) => {
      const selected = selectedOverlay?.type === 'audio'
        ? await prepareNarrationSlice(saved, current, selectedOverlay, models, root(), signal) : saved
      const draft = { ...approveNarrationDraft(selected, reviewed), voiceStyle, ...settings }
      await upgradeLegacyDraft(draft, current, models, root(), signal)
      requireCurrentNarration(draft, current, models)
      await worker.start(pack, false, modelDirectory)
      draft.voiceReference = await projectReference(current, saved)
      if (draft.phrases.some((phrase) => phrase.revisedText.trim()) && !draft.voiceReference) {
        event.sender.send('narration:progress', { stage: 'Preparing shared voice sample', fraction: 0 })
        draft.voiceReference = await prepareNarrationVoiceReference(current, draft, worker, signal)
      }
      let output: string
      let subtitleLines: NarrationSubtitleLine[] | undefined
      const tempos = new Map<string, number>()
      try {
        output = await generateNarrationAudio(draft, dirname(draft.originalPath), worker, signal,
          (stage, fraction) => event.sender.send('narration:progress', { stage, fraction }),
          settings.subtitles ? (words, placements) => {
            subtitleLines = narrationSubtitleLines(draft.phrases, words, draft.range[1] - draft.range[0],
              current.canvas.width < current.canvas.height ? 24 : 44, placements)
          } : undefined, (id, tempo) => tempos.set(id, tempo))
        draft.phrases = draft.phrases.map((phrase) => ({ ...phrase, generatedTempo: tempos.get(phrase.id) }))
      } catch (error) {
        if (!(error instanceof NarrationTimingError)) throw error
        // Return structured timing feedback: Electron does not preserve custom
        // Error fields. Save the post-LLM text, not the pre-cleanup draft.
        const review: NarrationReview = { ...draft, id: randomUUID(), approved: false, overruns: error.overruns }
        await mkdir(join(root(), review.id), { mode: 0o700 })
        await writeFile(join(root(), review.id, 'draft.json'), JSON.stringify(review), { flag: 'wx', mode: 0o600 })
        // The retry preview switches from a generated mix back to this original.
        // A restored project may only have authorized its mix in this session.
        await paths.allowRead(review.originalPath)
        return { review }
      }
      signal.throwIfAborted()
      // Preserve each generated revision independently so Undo/reopen restores
      // the transcript belonging to that audio, not the newest edit.
      const revisionId = randomUUID()
      await mkdir(join(root(), revisionId), { mode: 0o700 })
      await writeFile(join(root(), revisionId, 'draft.json'), JSON.stringify({ ...draft, id: revisionId, overruns: undefined }), { flag: 'wx', mode: 0o600 })
      const path = await paths.allowRead(output)
      const overlay: NarrationGeneratedAudio = { id: randomUUID(), type: 'audio', name: 'Re-voice', path,
        start: draft.range[0], duration: draft.range[1] - draft.range[0], sourceIn: 0, zIndex: 0, volume: 1,
        narration: { draftId: revisionId, enabled: true, voiceStyle, ...settings },
        ...(subtitleLines ? { subtitleLines } : {}) }
      return overlay
    })
  })
}
