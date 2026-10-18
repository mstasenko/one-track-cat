import { describe, expect, it, vi } from 'vitest'
import { useEditorStore } from './store'
import { retainEditorState } from './store-session'
import { createSession } from './timeline'
import { metadata } from '../../../../tests/editor-store-fixtures'
import type { EditorState } from './editor-state'

describe('editor hot reload', () => {
  it('restores unsaved data while retaining the new actions', () => {
    const session = createSession(metadata)
    const retained = { initialized: true, session, history: [session], future: [] }
    const state = { ...useEditorStore.getState(), ...retained }
    const setState = vi.fn()
    const dispose = vi.fn<(callback: (data: { editorState?: Partial<EditorState> }) => void) => void>()

    retainEditorState({ getState: () => state, setState }, { data: { editorState: retained }, dispose })

    expect(setState).toHaveBeenCalledWith(retained)
    const data: { editorState?: Partial<EditorState> } = {}
    dispose.mock.calls[0]?.[0](data)
    expect(data.editorState?.session).toBe(session)
    expect(data.editorState?.history).toBe(state.history)
    expect(data.editorState?.initialized).toBe(true)
    expect(Object.values(data.editorState ?? {}).some((value) => typeof value === 'function')).toBe(false)
  })

  it('registers disposal without replacing a fresh store', () => {
    const setState = vi.fn()
    const dispose = vi.fn()
    retainEditorState({ getState: useEditorStore.getState, setState }, { data: {}, dispose })
    expect(setState).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
