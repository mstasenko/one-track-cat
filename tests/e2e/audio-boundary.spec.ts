import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { click, completeVideoPicker, dismissHardwareWarningIfNeeded, e2eEnvironment, ffmpeg, main, seekTimeline } from './support'

test.skip(!process.env.PULSE_SERVER, 'PCM playback checks need a PulseAudio/PipeWire server; the headless launcher preserves a local one.')
const workletUrl = pathToFileURL(join(import.meta.dirname, 'pcm-capture-worklet.js')).href

interface AudioCapture {
  samples: number[]
  sampleRate: number
  blocks: AudioBlock[]
  frameGaps: { expected: number; actual: number; sampleOffset: number }[]
  nextFrame: number | null
  ready: boolean
  readyError: string | null
}

interface AudioBlock {
  sampleOffset: number
  sampleCount: number
  frame: number
  playbackTime: number
  audioContextTime: number
  sampleRate: number
}

interface AudioCaptureOptions {
  startupDelayMs: number
  workletUrl: string
}

function installAudioCapture({ startupDelayMs, workletUrl }: AudioCaptureOptions): void {
  const capture: AudioCapture = {
    samples: [],
    sampleRate: 0,
    blocks: [],
    frameGaps: [],
    nextFrame: null,
    ready: false,
    readyError: null
  }
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  Object.assign(window, { audioCapture: capture, audioCaptureReady: ready })
  if (startupDelayMs > 0) {
    // This fault-injects delayed decoder/frame startup for audio only; it is not
    // a video-continuity test. Primary presented-frame callbacks stay withheld
    // so the fallback remains audible until its delayed play promise resolves.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the recording media element below.
    const nativePlay = HTMLMediaElement.prototype.play
    const pendingPlays = new WeakMap<HTMLMediaElement, Promise<void>>()
    HTMLMediaElement.prototype.play = function (): Promise<void> {
      if (!this.classList.contains('preview-transition-previous')) return nativePlay.call(this)
      const existing = pendingPlays.get(this)
      if (existing) return existing
      const pending = new Promise<void>((resolve, reject) => {
        window.setTimeout(() => {
          void nativePlay.call(this).then(resolve, reject)
        }, startupDelayMs)
      })
      pendingPlays.set(this, pending)
      return pending
    }
    // Deliberately withhold primary presented-frame callbacks only in this
    // audio-readiness fault injection; no callback is fabricated or invoked.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the recording video element below.
    const nativeRequestVideoFrameCallback = HTMLVideoElement.prototype.requestVideoFrameCallback
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      if (this.classList.contains('preview-source-video') && !this.classList.contains('preview-transition-previous')) return 0
      return nativeRequestVideoFrameCallback.call(this, callback)
    }
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the recording context below.
  const createCompressor = AudioContext.prototype.createDynamicsCompressor
  AudioContext.prototype.createDynamicsCompressor = function () {
    const compressor = createCompressor.call(this)
    const originalConnect = compressor.connect.bind(compressor)
    compressor.connect = ((destination: AudioNode) => destination) as typeof compressor.connect
    void this.audioWorklet.addModule(workletUrl).then(() => {
      const recorder = new AudioWorkletNode(this, 'otc-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })
      originalConnect(recorder)
      recorder.connect(this.destination)
      recorder.port.onmessage = (event: MessageEvent<{ samples: number[]; frame: number; sampleRate: number }>): void => {
        const { samples, frame, sampleRate } = event.data
        if (capture.nextFrame !== null && frame !== capture.nextFrame) {
          capture.frameGaps.push({ expected: capture.nextFrame, actual: frame, sampleOffset: capture.samples.length })
        }
        capture.nextFrame = frame + samples.length
        capture.sampleRate = sampleRate
        capture.blocks.push({
          sampleOffset: capture.samples.length,
          sampleCount: samples.length,
          frame,
          playbackTime: frame / sampleRate,
          audioContextTime: this.currentTime,
          sampleRate
        })
        capture.samples.push(...samples)
      }
      capture.ready = true
      resolveReady?.()
    }).catch((error: unknown) => {
      capture.readyError = String(error)
      resolveReady?.()
    })
    return compressor
  }
}

for (const { transition, startupDelayMs } of [
  { transition: 'control', startupDelayMs: 0 },
  { transition: 'none', startupDelayMs: 0 },
  { transition: 'fade', startupDelayMs: 0 },
  { transition: 'none', startupDelayMs: 80 }
] as const) {
  test(
    startupDelayMs > 0
      ? 'keeps inserted-video preview audio routed through delayed fallback startup'
      : transition === 'control'
      ? 'keeps continuous first-clip preview audio stable without an insert'
      : `keeps inserted-video preview audio audible through a ${transition} join`,
    async () => {
      test.setTimeout(60_000)
      const directory = mkdtempSync(join(tmpdir(), 'otc-audio-boundary-'))
      const first = join(directory, 'first.mp4')
      const second = join(directory, 'second.mp4')
      for (const path of [first, second]) {
        // End the first clip near a negative peak; begin the second near a positive
        // peak so abrupt audio handoffs cannot pass just by landing on zero crossings.
        const tone = path === first
          ? 'sine=frequency=440.25:sample_rate=48000:duration=3'
          : 'aevalsrc=0.125*cos(2*PI*440.25*t):s=48000:d=3'
        execFileSync(ffmpeg, [
          '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60:duration=3',
          '-f', 'lavfi', '-i', tone,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-shortest', path
        ])
      }
      const app = await electron.launch({
        args: [main, first],
        env: e2eEnvironment({ otc_E2E_VIDEO: second })
      })
      try {
        const page = await app.firstWindow()
        const errors: string[] = []
        page.on('console', (message) => {
          if (message.text().includes('MediaElementAudioSource outputs zeroes')) errors.push(message.text())
        })
        await dismissHardwareWarningIfNeeded(page)
        await page.addInitScript(installAudioCapture, { startupDelayMs, workletUrl })
        await page.reload()
        await dismissHardwareWarningIfNeeded(page)
        await app.evaluate(({ BrowserWindow }, path) => {
          BrowserWindow.getAllWindows()[0]?.webContents.send('app:open-path', path)
        }, first)
        await expect(page.getByText('first.mp4', { exact: true })).toBeVisible()
        if (transition === 'control') {
          await seekTimeline(page, 0)
        } else {
          // A pointer at the exact right edge can land outside the timeline.
          await seekTimeline(page, 0.9)
          await page.keyboard.press('ArrowRight')
          await expect(page.locator('.timeline-time')).toHaveText('00:03.00 / 00:03.00')
          await click(page.getByRole('button', { name: 'Video', exact: true }))
          const intoTransition = page.getByLabel('Into inserted video')
          await intoTransition.selectOption(transition)
          await expect(intoTransition).toHaveValue(transition)
          await click(page.getByRole('button', { name: 'Select video', exact: true }))
          await completeVideoPicker(page)
          await expect(page.locator('.source-segment')).toHaveCount(2)
          await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'first.mp4')
          if (transition === 'fade') {
            const insertedSegment = page.locator('.source-segment[title^="second.mp4"]')
            await expect(insertedSegment).toHaveCount(1)
            await expect(insertedSegment).toHaveAttribute('data-transition', 'fade')
          }
          const total = transition === 'none' ? 6 : 5.35
          const boundary = total - 3
          await seekTimeline(page, (boundary - 1) / total)
        }
        await page.evaluate(() => (window as unknown as { audioCaptureReady: Promise<void> }).audioCaptureReady)
        await click(page.getByRole('button', { name: 'Play', exact: true }))
        await page.waitForTimeout(transition === 'control' ? 1_800 : 2_000)
        await click(page.getByRole('button', { name: 'Pause', exact: true }))
        const capture = await page.evaluate(() => (window as unknown as { audioCapture: AudioCapture }).audioCapture)
        const attachmentStem = `audio-boundary-${transition}-${startupDelayMs}-${test.info().repeatEachIndex}-${test.info().retry}`
        const { samples, ...trace } = capture
        const traceBody = JSON.stringify({ transition, startupDelayMs, corsErrors: errors, sampleCount: samples.length, ...trace }, null, 2)
        const pcmBody = Buffer.from(new Float32Array(samples).buffer)
        const tracePath = test.info().outputPath(`${attachmentStem}.json`)
        const pcmPath = test.info().outputPath(`${attachmentStem}.f32le`)
        writeFileSync(tracePath, traceBody)
        writeFileSync(pcmPath, pcmBody)
        await test.info().attach(`${attachmentStem}.json`, { path: tracePath, contentType: 'application/json' })
        await test.info().attach(`${attachmentStem}.f32le`, { path: pcmPath, contentType: 'application/octet-stream' })
        expect(capture.ready).toBe(true)
        expect(capture.readyError).toBeNull()
        expect(capture.sampleRate).toBeGreaterThan(0)
        const firstSound = capture.samples.findIndex((sample) => Math.abs(sample) > 0.02)
        let lastSound = capture.samples.length - 1
        while (lastSound > firstSound && Math.abs(capture.samples[lastSound] ?? 0) <= 0.02) lastSound -= 1
        expect(lastSound - firstSound).toBeGreaterThan(capture.sampleRate)
        // Worklet attachment can begin before playback and contain silent startup gaps;
        // only frame gaps inside the audible PCM interval are continuity failures.
        expect(capture.frameGaps.filter(({ sampleOffset }) => sampleOffset >= firstSound && sampleOffset <= lastSound)).toEqual([])
        let silent = 0
        let longestSilence = 0
        for (const sample of capture.samples.slice(firstSound, lastSound + 1)) {
          silent = Math.abs(sample) < 0.00001 ? silent + 1 : 0
          longestSilence = Math.max(longestSilence, silent)
        }
        let largestStep = 0
        const margin = Math.round(capture.sampleRate * 0.1)
        for (let index = firstSound + margin; index < lastSound - margin; index += 1) {
          const step = Math.abs((capture.samples[index] ?? 0) - (capture.samples[index - 1] ?? 0))
          largestStep = Math.max(largestStep, step)
        }
        console.log(JSON.stringify({ transition, longestSilenceMs: longestSilence * 1000 / capture.sampleRate, largestStep, corsErrors: errors }))
        expect(errors).toEqual([])
        // A tone's zero crossings are individual samples. A decoder-sized silent
        // interval at the join exposes a missing audio route or an interrupted player.
        const silenceBound = 0.05 + startupDelayMs / 1000
        expect(longestSilence / capture.sampleRate).toBeLessThan(silenceBound)
        // A 440 Hz, 1/8-scale sine changes by about 0.0072 per sample at 48 kHz.
        expect(largestStep).toBeLessThan(0.02)
      } finally {
        await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
}
