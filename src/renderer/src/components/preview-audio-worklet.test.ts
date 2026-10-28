import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Processor {
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
}

let ProcessorConstructor: (new () => Processor) | undefined
let savedGlobals: { processor: unknown; register: unknown; sampleRate: unknown } | undefined

beforeAll(async () => {
  const globalScope = globalThis as Record<string, unknown>
  savedGlobals = {
    processor: globalScope.AudioWorkletProcessor,
    register: globalScope.registerProcessor,
    sampleRate: globalScope.sampleRate
  }
  let registeredName = ''
  Object.assign(globalScope, {
    AudioWorkletProcessor: class { readonly marker = true },
    sampleRate: 48000,
    registerProcessor: (name: string, processor: new () => Processor) => {
      registeredName = name
      ProcessorConstructor = processor
    }
  })
  // @ts-expect-error -- The worklet registers globally and intentionally exports no TypeScript API.
  await import('./preview-audio-worklet.js')
  expect(registeredName).toBe('otc-preview-startup')
})

afterAll(() => {
  if (savedGlobals) Object.assign(globalThis as Record<string, unknown>, {
    AudioWorkletProcessor: savedGlobals.processor,
    registerProcessor: savedGlobals.register,
    sampleRate: savedGlobals.sampleRate
  })
})

function processor(): Processor {
  if (!ProcessorConstructor) throw new Error('Preview startup worklet was not registered')
  return new ProcessorConstructor()
}

function run(target: Processor, input: Float32Array[][], output = input): Float32Array[][] {
  expect(target.process(input, output)).toBe(true)
  return output
}

describe('preview startup worklet', () => {
  it('keeps empty engine buffers alive', () => {
    const target = processor()
    expect(target.process([], [])).toBe(true)
    expect(target.process([[]], [[]])).toBe(true)
    const monoInput = [[new Float32Array([1])]]
    const stereoOutput = [[new Float32Array(1), new Float32Array(1)]]
    expect(target.process(monoInput, stereoOutput)).toBe(true)
    expect(stereoOutput[0]?.[1]?.[0]).toBe(0)
  })

  it('attacks late stereo PCM from silence without a startup step', () => {
    const target = processor()
    const silence = new Float32Array(1440)
    run(target, [[silence, silence]], [[new Float32Array(1440), new Float32Array(1440)]])
    const pcm = new Float32Array(256).fill(1)
    const output = run(target, [[pcm, pcm]], [[new Float32Array(256), new Float32Array(256)]])
    expect(output[0]?.[0]?.[0]).toBeCloseTo(1 / 240)
    expect(output[0]?.[1]?.[0]).toBeCloseTo(1 / 240)
    expect(output[0]?.[0]?.[0]).toBeLessThanOrEqual(1 / (48000 * 0.005) + 1e-7)
    expect(output[0]?.[0]?.[239]).toBe(1)
    expect(output[0]?.[1]).toEqual(output[0]?.[0])
  })

  it('passes steady stereo PCM bit-exactly after the attack', () => {
    const target = processor()
    const warmup = new Float32Array(256).fill(0.25)
    run(target, [[warmup, warmup]], [[new Float32Array(256), new Float32Array(256)]])
    const source = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.5)]
    const output = run(target, [source], [[new Float32Array(128), new Float32Array(128)]])
    expect(output[0]).toEqual(source)
    const zeroCrossing = [new Float32Array([0]), new Float32Array([0])]
    expect(run(target, [zeroCrossing], [[new Float32Array(1), new Float32Array(1)]])[0]).toEqual(zeroCrossing)
    const afterCrossing = [new Float32Array([0.25]), new Float32Array([-0.5])]
    expect(run(target, [afterCrossing], [[new Float32Array(1), new Float32Array(1)]])[0]).toEqual(afterCrossing)
  })

  it('detects activity in the right channel and rearms after a long silence', () => {
    const target = processor()
    const silence = new Float32Array(128)
    run(target, [[silence, silence]], [[new Float32Array(128), new Float32Array(128)]])
    const right = new Float32Array(256).fill(1)
    const output = run(target, [[new Float32Array(256), right]], [[new Float32Array(256), new Float32Array(256)]])
    expect(output[0]?.[0]?.[0]).toBe(0)
    expect(output[0]?.[1]?.[0]).toBeCloseTo(1 / 240)
    expect(output[0]?.[1]?.[239]).toBe(1)
    run(target, [[silence, silence]], [[new Float32Array(128), new Float32Array(128)]])
    const resumed = new Float32Array(1).fill(-1)
    const resumedOutput = run(target, [[resumed, resumed]], [[new Float32Array(1), new Float32Array(1)]])
    expect(resumedOutput[0]?.[0]?.[0]).toBeCloseTo(-1 / 240)
    expect(resumedOutput[0]?.[1]?.[0]).toBeCloseTo(-1 / 240)
  })

  it('restarts the attack after a capped gap during startup', () => {
    const target = processor()
    const lead = new Float32Array(120).fill(1)
    const leadOutput = run(target, [[lead, lead]], [[new Float32Array(120), new Float32Array(120)]])
    expect(leadOutput[0]?.[0]?.[119]).toBeCloseTo(120 / 240)
    const silence = new Float32Array(128)
    run(target, [[silence, silence]], [[new Float32Array(128), new Float32Array(128)]])
    const resumed = new Float32Array(1).fill(1)
    const resumedOutput = run(target, [[resumed, resumed]], [[new Float32Array(1), new Float32Array(1)]])
    expect(resumedOutput[0]?.[0]?.[0]).toBeCloseTo(1 / 240)
  })

  it('does not treat a short isolated zero as a new startup gap', () => {
    const target = processor()
    const warmup = new Float32Array(256).fill(0.25)
    run(target, [[warmup, warmup]], [[new Float32Array(256), new Float32Array(256)]])
    const source = new Float32Array(256).fill(0.25)
    source[128] = 0
    const output = run(target, [[source, source]], [[new Float32Array(256), new Float32Array(256)]])
    expect(output[0]).toEqual([source, source])
  })
})
