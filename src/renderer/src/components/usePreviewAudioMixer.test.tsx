import { StrictMode, act, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewAudioMixer } from './usePreviewAudioMixer'

class MockNode {
  constructor(readonly context: MockAudioContext) {}
  connect = vi.fn((target: MockNode) => {
    if (target.context !== this.context) throw new Error('Nodes belong to different contexts')
  })
  disconnect = vi.fn()
}

interface MockAudioParam {
  value: number
  cancelScheduledValues: ReturnType<typeof vi.fn>
  cancelAndHoldAtTime: ReturnType<typeof vi.fn>
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
}

function parameter(): MockAudioParam {
  return {
    value: 0,
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn()
  }
}

class MockGainNode extends MockNode { gain = parameter() }

class MockAudioContext {
  static instances: MockAudioContext[] = []
  state: AudioContextState = 'suspended'
  currentTime = 0
  destination = new MockNode(this)
  gainNodes: MockGainNode[] = []
  createMediaElementSource = vi.fn(() => new MockNode(this))
  createGain = vi.fn(() => {
    const node = new MockGainNode(this)
    this.gainNodes.push(node)
    return node
  })
  createDynamicsCompressor = vi.fn(() => Object.assign(new MockNode(this), {
    threshold: parameter(), knee: parameter(), ratio: parameter(),
    attack: parameter(), release: parameter()
  }))
  resume = vi.fn(() => { this.state = 'running'; return Promise.resolve() })
  close = vi.fn(() => { this.state = 'closed'; return Promise.resolve() })

  constructor() { MockAudioContext.instances.push(this) }
}

function MixerHarness({ onReady }: {
  onReady?: (mixer: ReturnType<typeof usePreviewAudioMixer>, video: HTMLVideoElement) => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mixer = usePreviewAudioMixer()
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const unregister = mixer.register(video)
    onReady?.(mixer, video)
    return unregister
  }, [mixer, onReady])
  return <video ref={videoRef} />
}

beforeEach(() => {
  vi.useFakeTimers()
  MockAudioContext.instances = []
  vi.stubGlobal('AudioContext', MockAudioContext)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('preview audio mixer', () => {
  it('keeps one media context through the development Strict Mode effect replay', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(<StrictMode><MixerHarness /></StrictMode>) })
    expect(MockAudioContext.instances).toHaveLength(1)
    expect(MockAudioContext.instances[0]?.createMediaElementSource).toHaveBeenCalledTimes(1)
    act(() => { root.unmount() })
    await vi.runAllTimersAsync()
    expect(MockAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('holds an active gain ramp before reversing the audio handoff', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    let ready: Parameters<NonNullable<Parameters<typeof MixerHarness>[0]['onReady']>> | undefined
    act(() => {
      root.render(<MixerHarness onReady={(...values) => { ready = values }} />)
    })
    if (!ready) throw new Error('mixer was not ready')
    const [mixer, video] = ready
    const context = MockAudioContext.instances[0]
    const gain = context?.gainNodes[0]?.gain
    if (!context || !gain) throw new Error('gain was not created')

    act(() => { mixer.setGain(video, 0) })
    expect(gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(0)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(gain.value, 0)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.02)

    context.currentTime = 0.005
    gain.value = 0.75
    act(() => { mixer.setGain(video, 1) })
    expect(gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(0.005)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(0.75, 0.005)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 0.025)
    expect(gain.cancelScheduledValues).not.toHaveBeenCalled()

    context.currentTime = 2
    gain.value = 1
    act(() => { mixer.setGain(video, 0) })
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(1, 2)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 2.02)
    act(() => { root.unmount() })
  })

  it('holds now and delays an explicitly timed gain ramp without a snap', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    let ready: Parameters<NonNullable<Parameters<typeof MixerHarness>[0]['onReady']>> | undefined
    act(() => {
      root.render(<MixerHarness onReady={(...values) => { ready = values }} />)
    })
    if (!ready) throw new Error('mixer was not ready')
    const [mixer, video] = ready
    const context = MockAudioContext.instances[0]
    const gain = context?.gainNodes[0]?.gain
    if (!context || !gain) throw new Error('gain was not created')

    context.currentTime = 1
    gain.value = 0.7
    act(() => { mixer.setGain(video, 0, 0.09, 0.01) })

    expect(gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(1)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(0.7, 1.09)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 1.1)
    act(() => { root.unmount() })
  })
})
