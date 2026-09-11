import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './store'
import { createSession } from './timeline'

beforeEach(() => {
  const session = createSession({
    path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
    width: 1920, height: 1080, fps: 60, videoCodec: 'h264', hasAudio: true
  })
  session.marks = [2, 5]
  useEditorStore.setState({ session, history: [], future: [] })
})

describe('video range transitions in the editor store', () => {
  it('applies, replaces, and removes the selected partition effect', () => {
    useEditorStore.getState().setPlayhead(1)
    useEditorStore.getState().applyVideoTransition({ effect: 'fade', duration: 1 }, undefined)
    useEditorStore.getState().setPlayhead(3)
    useEditorStore.getState().applyVideoTransition(undefined, { effect: 'hblur', duration: 1.5 })

    let effects = useEditorStore.getState().session?.videoTransitions
    expect(effects).toHaveLength(2)
    expect(effects?.[0]).toMatchObject({ start: 0, duration: 2, into: { effect: 'fade', duration: 1 } })
    expect(effects?.[1]).toMatchObject({ start: 2, duration: 3, out: { effect: 'hblur', duration: 1.5 } })

    useEditorStore.getState().applyVideoTransition(
      { effect: 'dissolve', duration: 0.5 },
      { effect: 'fade', duration: 2 }
    )
    effects = useEditorStore.getState().session?.videoTransitions
    expect(effects?.[1]).toMatchObject({
      start: 2, duration: 3,
      into: { effect: 'dissolve', duration: 0.5 },
      out: { effect: 'fade', duration: 1.5 }
    })

    useEditorStore.getState().applyVideoTransition()
    expect(useEditorStore.getState().session?.videoTransitions).toEqual([
      expect.objectContaining({ start: 0, duration: 2 })
    ])
  })
})
