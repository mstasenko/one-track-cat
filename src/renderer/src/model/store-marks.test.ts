import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, metadata } from '../../../../tests/editor-store-fixtures'
import { useEditorStore } from './store'
import { createSession } from './timeline'

vi.mock('./video-picker', () => ({ chooseVideo: () => window.otc.openVideo() }))

beforeEach(() => {
  Object.defineProperty(window, 'otc', { value: api(), configurable: true })
  useEditorStore.setState({
    initialized: false, session: null, history: [], future: [], gesture: null, assets: [],
    gpu: null, job: null, busy: null, error: null
  })
})

describe('editor mark clearing', () => {
  it('clears either actual boundary mark without deleting media', () => {
    const session = createSession(metadata)
    session.marks = [1, 2, 6, 8]
    session.playhead = 4
    useEditorStore.setState({ session, history: [], future: [] })
    const segments = session.segments

    useEditorStore.getState().clearMark('left')
    expect(useEditorStore.getState().session?.marks).toEqual([1, 6, 8])
    expect(useEditorStore.getState().session?.segments).toBe(segments)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.marks).toEqual([1, 2, 6, 8])
    useEditorStore.getState().clearMark('right')
    expect(useEditorStore.getState().session?.marks).toEqual([1, 2, 8])
    expect(useEditorStore.getState().session?.segments).toBe(segments)
  })

  it('does not create history for an implicit boundary or an empty mark set', () => {
    const session = createSession(metadata)
    session.marks = [2]
    session.playhead = 1
    useEditorStore.setState({ session, history: [], future: [] })
    useEditorStore.getState().clearMark('left')
    expect(useEditorStore.getState().session?.marks).toEqual([2])
    expect(useEditorStore.getState().history).toHaveLength(0)
    useEditorStore.getState().clearMark('right')
    expect(useEditorStore.getState().session?.marks).toEqual([])
    expect(useEditorStore.getState().history).toHaveLength(1)
    useEditorStore.getState().setPlayhead(100)
    useEditorStore.getState().clearMark('right')
    expect(useEditorStore.getState().session?.playhead).toBe(metadata.duration)
    expect(useEditorStore.getState().history).toHaveLength(1)
  })
})
