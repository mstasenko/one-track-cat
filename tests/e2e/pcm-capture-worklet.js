/* global AudioWorkletProcessor, currentFrame, registerProcessor, sampleRate */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    for (const output of outputs) {
      for (const outputChannel of output) outputChannel.fill(0)
    }
    const channel = inputs[0]?.[0] ?? outputs[0]?.[0]
    if (channel) {
      this.port.postMessage({ samples: Array.from(channel), frame: currentFrame, sampleRate })
    }
    return true
  }
}

registerProcessor('otc-pcm-capture', PcmCaptureProcessor)
