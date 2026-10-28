import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface Packet { samples: number[]; frame: number; sequence: number; sampleRate: number }
interface Processor { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean }

describe('PCM capture', () => {
  it('counts every captured block independently of a repeating render clock', () => {
    let Constructor: (new () => Processor) | undefined
    let frame = 0
    const packets: Packet[] = []
    runInNewContext(readFileSync(join(process.cwd(), 'tests/e2e/pcm-capture-worklet.js'), 'utf8'), {
      AudioWorkletProcessor: class { port = { postMessage: (packet: Packet) => packets.push(packet) } },
      get currentFrame() { return frame }, sampleRate: 48000,
      registerProcessor: (_name: string, processor: new () => Processor) => { Constructor = processor }
    })
    if (!Constructor) throw new Error('PCM worklet was not registered')
    const processor = new Constructor()
    const input = new Float32Array(128).fill(0.125)
    const output = new Float32Array(128).fill(1)
    for (const value of [0, 128, 128, 384]) {
      frame = value
      expect(processor.process([[input]], [[output]])).toBe(true)
    }
    input.fill(0)
    expect(packets.map((packet) => packet.sequence)).toEqual([0, 1, 2, 3])
    expect(packets.map((packet) => packet.frame)).toEqual([0, 128, 128, 384])
    expect(packets.every((packet) => packet.sampleRate === 48000 && packet.samples.length === 128 && packet.samples.every((sample) => sample === 0.125))).toBe(true)
    expect(output.every((sample) => sample === 0)).toBe(true)
  })
})
