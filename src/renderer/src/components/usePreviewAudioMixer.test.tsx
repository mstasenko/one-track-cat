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

class MockAudioWorklet {
  addModule = vi.fn(() => Promise.resolve())
}

class MockAudioWorkletNode extends MockNode {
  static instances: MockAudioWorkletNode[] = []
  port = { postMessage: vi.fn() }

  constructor(context: MockAudioContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    super(context)
    MockAudioWorkletNode.instances.push(this)
  }
}

interface MockAudioParam {
  value: number
  cancelScheduledValues: ReturnType<typeof vi.fn>
  cancelAndHoldAtTime: ReturnType<typeof vi.fn>
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
}

function parameter(value = 0): MockAudioParam {
  return {
    value,
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn()
  }
}

class MockGainNode extends MockNode { gain = parameter(1) }

class MockAudioContext {
  static instances: MockAudioContext[] = []
  static workletLoad: Promise<void> | undefined
  state: AudioContextState = 'suspended'
  currentTime = 0
  destination = new MockNode(this)
  audioWorklet = new MockAudioWorklet()
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

  constructor() {
    MockAudioContext.instances.push(this)
    if (MockAudioContext.workletLoad) this.audioWorklet.addModule.mockReturnValue(MockAudioContext.workletLoad)
  }
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
  MockAudioContext.workletLoad = undefined
  MockAudioWorkletNode.instances = []
  vi.stubGlobal('AudioContext', MockAudioContext)
  vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('preview audio mixer', () => {
  it('starts a newly registered route silent before its first owner fade-in', () => {
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

    expect(gain.value).toBe(0)
    act(() => { mixer.setGain(video, 1) })
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 0.02)
    act(() => { root.unmount() })
  })

  it('does not connect an unmounted route when worklet registration resolves late', async () => {
    let release!: () => void
    MockAudioContext.workletLoad = new Promise<void>((resolve) => { release = resolve })
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(<MixerHarness />) })
    const context = MockAudioContext.instances[0]
    const source = context?.createMediaElementSource.mock.results[0]?.value as MockNode | undefined
    if (!context || !source) throw new Error('source was not created')

    act(() => { root.unmount() })
    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(source.connect).not.toHaveBeenCalled()
  })

  it('shares one pending worklet load across the Strict Mode route replay', async () => {
    let release!: () => void
    MockAudioContext.workletLoad = new Promise<void>((resolve) => { release = resolve })
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(<StrictMode><MixerHarness /></StrictMode>) })
    const context = MockAudioContext.instances[0]
    const source = context?.createMediaElementSource.mock.results[0]?.value as MockNode | undefined
    if (!context || !source) throw new Error('source was not created')
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(source.connect).toHaveBeenCalledTimes(1)
    expect(MockAudioWorkletNode.instances).toHaveLength(1)
    expect(MockAudioWorkletNode.instances[0]?.options).toMatchObject({
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2]
    })
    act(() => { root.unmount() })
  })

  it('falls back to direct gain routing when the startup worklet fails', async () => {
    let rejectWorklet!: (error: Error) => void
    MockAudioContext.workletLoad = new Promise<void>((_resolve, reject) => { rejectWorklet = reject })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(<MixerHarness />) })
    const context = MockAudioContext.instances[0]
    const source = context?.createMediaElementSource.mock.results[0]?.value as MockNode | undefined
    if (!context || !source) throw new Error('source was not created')

    await act(async () => {
      rejectWorklet(new Error('test worklet failure'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(source.connect).toHaveBeenCalledTimes(1)
    expect(MockAudioWorkletNode.instances).toHaveLength(0)
    expect(error).toHaveBeenCalled()
    act(() => { root.unmount() })
    error.mockRestore()
  })

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

    gain.value = 1
    act(() => { mixer.setGain(video, 0) })
    expect(gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(0)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(gain.value, 0)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.02)

    context.currentTime = 0.005
    // The getter still exposes the prior value; the active ramp is at 0.75.
    act(() => { mixer.setGain(video, 1) })
    expect(gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(0.005)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(0.75, 0.005)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 0.025)
    expect(gain.cancelScheduledValues).not.toHaveBeenCalled()

    context.currentTime = 2
    // The previous ramp has completed at 1 even if the getter is stale.
    gain.value = 0
    act(() => { mixer.setGain(video, 0) })
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(1, 2)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 2.02)
    act(() => { root.unmount() })
  })

  it('holds an active ramp before a delayed reversal without a snap', () => {
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
    gain.value = 1
    act(() => { mixer.setGain(video, 0) })
    context.currentTime = 1.01
    // The getter remains at 1 while the scheduled ramp has reached 0.5.
    act(() => { mixer.setGain(video, 1, 0.09, 0.01) })

    expect(gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(1.01)
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0.5, 1.01)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 1.1)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 1.11)
    act(() => { root.unmount() })
  })

  it('never extends an existing fade when the same gain is requested again', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    let ready: Parameters<NonNullable<Parameters<typeof MixerHarness>[0]['onReady']>> | undefined
    act(() => { root.render(<MixerHarness onReady={(...values) => { ready = values }} />) })
    if (!ready) throw new Error('mixer was not ready')
    const [mixer, video] = ready
    const context = MockAudioContext.instances[0]
    const gain = context?.gainNodes[0]?.gain
    if (!context || !gain) throw new Error('gain was not created')
    context.currentTime = 1
    gain.value = 1
    act(() => { mixer.setGain(video, 0, 0.002, 0.01) })
    context.currentTime = 1.01
    gain.value = 0.2
    act(() => { mixer.setGain(video, 0) })
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 1.012)
    // An earlier deadline must still be honored, e.g. an immediate pause.
    act(() => { mixer.setGain(video, 0, 0, 0.001) })
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 1.011)
    act(() => { root.unmount() })
  })
})
