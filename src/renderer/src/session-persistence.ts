import type { EditSession } from '@shared/types'
import { useEditorStore } from './model/store'
import { queueSessionWrite, savedSession } from './model/store-session'

export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000

export function saveCurrentSession(): Promise<EditSession | null> {
  const current = useEditorStore.getState()
  if (!current.session) return Promise.resolve(null)
  const session = current.session
  const sourceId = session.sources[0]?.id
  const snapshot = savedSession(session, current.history, current.future)
  let skipped = false
  return queueSessionWrite(async () => {
    const currentSourceId = useEditorStore.getState().session?.sources[0]?.id
    if (currentSourceId !== sourceId) {
      skipped = true
      return
    }
    await window.otc.saveSession(snapshot)
  }).then(() => skipped ? null : session)
}

export function startAutosave(onError: () => void): () => void {
  const timer = window.setInterval(() => {
    void saveCurrentSession().catch(onError)
  }, AUTOSAVE_INTERVAL_MS)
  return () => window.clearInterval(timer)
}
