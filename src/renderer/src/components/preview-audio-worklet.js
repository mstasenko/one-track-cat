/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const QUIET_FRAMES = 128
const ATTACK_SECONDS = 0.005

class PreviewStartupProcessor extends AudioWorkletProcessor {
  quietFrames = QUIET_FRAMES
  ramp = 0
  attackStep = 1 / Math.max(1, Math.round(sampleRate * ATTACK_SECONDS))

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    const frames = output?.[0]?.length ?? 0
    if (!output || frames === 0) return true
    for (let frame = 0; frame < frames; frame += 1) {
      const active = (input?.[0]?.[frame] ?? 0) !== 0 || (input?.[1]?.[frame] ?? 0) !== 0
      if (active) {
        if (this.quietFrames >= QUIET_FRAMES) this.ramp = 0
        this.quietFrames = 0
        this.ramp = Math.min(1, this.ramp + this.attackStep)
      } else {
        // MediaElement.play() can precede PCM; only an exact-zero run arms startup.
        this.quietFrames = Math.min(QUIET_FRAMES, this.quietFrames + 1)
      }
      const gain = Math.min(1, this.ramp)
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][frame] = (input?.[channel]?.[frame] ?? 0) * gain
      }
    }
    return true
  }
}

registerProcessor('otc-preview-startup', PreviewStartupProcessor)
