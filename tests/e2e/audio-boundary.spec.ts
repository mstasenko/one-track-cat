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
  events: Record<string, string | number | boolean>[]
  frameGaps: { expected: number; actual: number; sampleOffset: number }[]
  nextFrame: number | null
  ready: boolean
  readyError: string | null
}

interface AudioBlock {
  recorder: number
  sequence: number
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
  mediaClockLagMs?: number
  primaryFrameDelayMs?: number
}

function installAudioCapture({ startupDelayMs, workletUrl, mediaClockLagMs = 0, primaryFrameDelayMs = 0 }: AudioCaptureOptions): void {
  const capture: AudioCapture = {
    samples: [],
    sampleRate: 0,
    blocks: [],
    events: [],
    frameGaps: [],
    nextFrame: null,
    ready: false,
    readyError: null
  }
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  let recorderCount = 0
  const gains = new WeakMap<AudioNode, number>()
  const mediaRoutes = new Map<number, HTMLMediaElement>()
  const mediaNodes = new WeakMap<AudioNode, HTMLMediaElement>()
  const recordConnection = (source: AudioNode, destination: AudioNode): void => {
    const media = mediaNodes.get(source)
    if (!media) return
    mediaNodes.set(destination, media)
    const gain = gains.get(destination)
    if (gain !== undefined) {
      mediaRoutes.set(gain, media)
      capture.events.push({ kind: 'route', gain, media: media.className, contextTime: source.context.currentTime })
    }
  }
  Object.assign(window, { audioCapture: capture, audioCaptureReady: ready })
  const NativeWorkletNode = AudioWorkletNode
  window.AudioWorkletNode = class extends NativeWorkletNode {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options)
      capture.events.push({ kind: 'processor', name, contextTime: context.currentTime })
      const connect = this.connect.bind(this)
      this.connect = ((destination: AudioNode) => {
        recordConnection(this, destination)
        return connect(destination)
      }) as typeof this.connect
    }
  }
  if (mediaClockLagMs > 0) {
    // The media clock and Web Audio render clock are not sample-synchronous.
    // Model a bounded lag while preserving the real decoder and its PCM.
    const clock = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with each media element below.
    const getCurrentTime = clock?.get
    if (!getCurrentTime) throw new Error('HTMLMediaElement.currentTime getter missing')
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...clock,
      get(this: HTMLMediaElement): number {
        const time = getCurrentTime.call(this) as number
        return this.classList.contains('preview-source-video') && !this.classList.contains('preview-transition-previous')
          ? Math.max(0, time - mediaClockLagMs / 1000) : time
      }
    })
  }
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
      }).finally(() => {
        // Coalesce pending starts, not later resumes after a pause or source change.
        pendingPlays.delete(this)
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
  if (primaryFrameDelayMs > 0) {
    // Delay registration of real primary presented-frame callbacks for one
    // source generation. The native callback still supplies the metadata; a
    // source change cancels every queued registration before it can go stale.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the delayed recording video element below.
    const nativeRequestVideoFrameCallback = HTMLVideoElement.prototype.requestVideoFrameCallback
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the delayed recording video element below.
    const nativeCancelVideoFrameCallback = HTMLVideoElement.prototype.cancelVideoFrameCallback
    interface DelayedRequest {
      id: number
      video: HTMLVideoElement
      source: string
      callback: VideoFrameRequestCallback
      nativeId?: number
      cancelled: boolean
    }
    interface DelayedSource {
      source: string
      released: boolean
      timer?: number
      requests: Map<number, DelayedRequest>
    }
    const delayedSources = new WeakMap<HTMLVideoElement, DelayedSource>()
    const delayedRequests = new Map<number, DelayedRequest>()
    let syntheticId = -1
    const isPrimary = (video: HTMLVideoElement): boolean =>
      video.classList.contains('preview-source-video') && !video.classList.contains('preview-transition-previous')
    const sourceFor = (video: HTMLVideoElement): string => video.getAttribute('src') ?? ''
    const cancelSource = (video: HTMLVideoElement, state: DelayedSource): void => {
      if (state.timer !== undefined) {
        window.clearTimeout(state.timer)
        state.timer = undefined
      }
      for (const request of state.requests.values()) {
        request.cancelled = true
        if (request.nativeId !== undefined) nativeCancelVideoFrameCallback.call(video, request.nativeId)
        delayedRequests.delete(request.id)
      }
      state.requests.clear()
    }
    const register = (request: DelayedRequest, state: DelayedSource): void => {
      if (request.cancelled) return
      request.nativeId = nativeRequestVideoFrameCallback.call(request.video, (now, metadata) => {
        state.requests.delete(request.id)
        delayedRequests.delete(request.id)
        if (request.cancelled || sourceFor(request.video) !== request.source) return
        capture.events.push({ kind: 'primary-frame-presented', source: request.source })
        request.callback(now, metadata)
      })
    }
    const release = (video: HTMLVideoElement, state: DelayedSource): void => {
      if (delayedSources.get(video) !== state) return
      state.timer = undefined
      if (sourceFor(video) !== state.source) {
        cancelSource(video, state)
        delayedSources.delete(video)
        return
      }
      state.released = true
      capture.events.push({ kind: 'primary-frame-released', source: state.source, wallTime: performance.now() })
      for (const request of state.requests.values()) register(request, state)
    }
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      if (!isPrimary(this)) return nativeRequestVideoFrameCallback.call(this, callback)
      const source = sourceFor(this)
      let state = delayedSources.get(this)
      if (state?.source !== source) {
        if (state) cancelSource(this, state)
        const sourceState: DelayedSource = { source, released: false, requests: new Map() }
        delayedSources.set(this, sourceState)
        capture.events.push({ kind: 'primary-frame-delayed', source, wallTime: performance.now() })
        sourceState.timer = window.setTimeout(() => release(this, sourceState), primaryFrameDelayMs)
        state = sourceState
      }
      if (state.released) {
        return nativeRequestVideoFrameCallback.call(this, (now, metadata) => {
          if (sourceFor(this) === source) callback(now, metadata)
        })
      }
      const id = syntheticId--
      const request: DelayedRequest = { id, video: this, source, callback, cancelled: false }
      state.requests.set(id, request)
      delayedRequests.set(id, request)
      return id
    }
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
      const request = delayedRequests.get(id)
      if (!request) {
        nativeCancelVideoFrameCallback.call(this, id)
        return
      }
      request.cancelled = true
      delayedRequests.delete(id)
      const state = delayedSources.get(request.video)
      state?.requests.delete(id)
      if (request.nativeId !== undefined) nativeCancelVideoFrameCallback.call(request.video, request.nativeId)
      if (state && !state.released && state.requests.size === 0 && state.timer !== undefined) {
        window.clearTimeout(state.timer)
        state.timer = undefined
        delayedSources.delete(request.video)
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the recording context below.
  const createCompressor = AudioContext.prototype.createDynamicsCompressor
  AudioContext.prototype.createDynamicsCompressor = function () {
    capture.events.push({ kind: 'context', baseLatency: this.baseLatency, outputLatency: this.outputLatency,
      sampleRate: this.sampleRate, contextTime: this.currentTime })
    const createGain = this.createGain.bind(this)
    let gainCount = 0
    this.createGain = () => {
      const gain = createGain()
      const id = gainCount++
      gains.set(gain, id)
      for (const name of ['setValueAtTime', 'linearRampToValueAtTime'] as const) {
        const schedule = gain.gain[name].bind(gain.gain)
        gain.gain[name] = (value, time) => {
          const media = mediaRoutes.get(id)
          capture.events.push({ kind: name, gain: id, value, time, contextTime: this.currentTime,
            wallTime: performance.now(), media: media?.className ?? '', sourceTime: media?.currentTime ?? -1,
            source: media?.getAttribute('src') ?? '', paused: media?.paused ?? true })
          return schedule(value, time)
        }
      }
      return gain
    }
    const createSource = this.createMediaElementSource.bind(this)
    this.createMediaElementSource = (media) => {
      const source = createSource(media)
      const disconnect = source.disconnect.bind(source)
      source.disconnect = (...args: unknown[]): void => {
        capture.events.push({ kind: 'source-disconnect', media: media.className,
          source: media.getAttribute('src') ?? '', contextTime: this.currentTime, wallTime: performance.now() })
        Reflect.apply(disconnect, source, args)
      }
      mediaNodes.set(source, media)
      const connect = source.connect.bind(source)
      source.connect = ((destination: AudioNode) => {
        recordConnection(source, destination)
        return connect(destination)
      }) as typeof source.connect
      return source
    }
    for (const name of ['playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'ratechange', 'emptied', 'loadstart']) {
      document.addEventListener(name, (event) => {
        const media = event.target
        if (media instanceof HTMLMediaElement) capture.events.push({ kind: name, media: media.className,
          sourceTime: media.currentTime, paused: media.paused, rate: media.playbackRate,
          source: media.getAttribute('src') ?? '',
          contextTime: this.currentTime })
      }, true)
    }
    const compressor = createCompressor.call(this)
    const originalConnect = compressor.connect.bind(compressor)
    compressor.connect = ((destination: AudioNode) => destination) as typeof compressor.connect
    void this.audioWorklet.addModule(workletUrl).then(() => {
      const recorder = new AudioWorkletNode(this, 'otc-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })
      const recorderId = recorderCount++
      originalConnect(recorder)
      recorder.connect(this.destination)
      recorder.port.onmessage = (event: MessageEvent<{ samples: number[]; frame: number; sampleRate: number; sequence: number }>): void => {
        const { samples, frame, sampleRate, sequence } = event.data
        if (capture.nextFrame !== null && frame !== capture.nextFrame) {
          capture.frameGaps.push({ expected: capture.nextFrame, actual: frame, sampleOffset: capture.samples.length })
        }
        capture.nextFrame = frame + samples.length
        capture.sampleRate = sampleRate
        capture.blocks.push({
          recorder: recorderId,
          sequence,
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

for (const variant of [
  { transition: 'control', startupDelayMs: 0, duration: 0 },
  { transition: 'none', startupDelayMs: 0, duration: 0 },
  { transition: 'fade', startupDelayMs: 0, duration: 0.65 },
  { transition: 'fade', startupDelayMs: 0, duration: 1.5 },
  { transition: 'none', startupDelayMs: 80, duration: 0 },
  { transition: 'fade', startupDelayMs: 80, duration: 0.65 },
  { transition: 'fade', startupDelayMs: 0, duration: 0.65, primaryFrameDelayMs: 900 },
  { transition: 'none', startupDelayMs: 0, duration: 0, mediaClockLagMs: 4 }
] as const) {
  const { transition, startupDelayMs, duration } = variant
  const mediaClockLagMs = ('mediaClockLagMs' in variant ? variant.mediaClockLagMs : 0) ?? 0
  const primaryFrameDelayMs = ('primaryFrameDelayMs' in variant ? variant.primaryFrameDelayMs : 0) ?? 0
  test(
    mediaClockLagMs > 0 ? 'Media clock trails audio'
      : primaryFrameDelayMs > 0 ? 'Late primary frame through fade end'
      : startupDelayMs > 0
      ? transition === 'fade' ? 'Delayed decoder through fade end' : 'Delayed decoder startup'
      : transition === 'control'
      ? 'Continuous playback'
      : `${transition} join${duration ? ` (${duration}s)` : ''}`,
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
        await page.addInitScript(installAudioCapture, { startupDelayMs, workletUrl, mediaClockLagMs, primaryFrameDelayMs })
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
          if (transition === 'fade') await page.getByLabel('Transition duration').selectOption(String(duration))
          await click(page.getByRole('button', { name: 'Select video', exact: true }))
          await completeVideoPicker(page)
          await expect(page.locator('.source-segment')).toHaveCount(2)
          await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'first.mp4')
          if (transition === 'fade') {
            const insertedSegment = page.locator('.source-segment[title^="second.mp4"]')
            await expect(insertedSegment).toHaveCount(1)
            await expect(insertedSegment).toHaveAttribute('data-transition', 'fade')
          }
          const total = 6 - duration
          // The timeline suffix is frames at 60 fps, not decimal hundredths.
          const seconds = Math.floor(total)
          const frames = String(Math.floor((total - seconds) * 60)).padStart(2, '0')
          await expect(page.locator('.timeline-time')).toContainText(`/ 00:0${seconds}.${frames}`)
          const boundary = total - 3
          await seekTimeline(page, (boundary - 1) / total)
        }
        await page.evaluate(() => (window as unknown as { audioCaptureReady: Promise<void> }).audioCaptureReady)
        await click(page.getByRole('button', { name: 'Play', exact: true }))
        await page.waitForTimeout(transition === 'control' ? 1_800 : 2_000 + duration * 1_000)
        await click(page.getByRole('button', { name: 'Pause', exact: true }))
        const capture = await page.evaluate(() => (window as unknown as { audioCapture: AudioCapture }).audioCapture)
        const attachmentStem = `audio-boundary-${transition}-${duration}-${startupDelayMs}-${test.info().repeatEachIndex}-${test.info().retry}`
        const { samples, ...trace } = capture
        const traceBody = JSON.stringify({ transition, duration, startupDelayMs, mediaClockLagMs, primaryFrameDelayMs, corsErrors: errors, sampleCount: samples.length, ...trace }, null, 2)
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
        expect(capture.events.some((event) => event.kind === 'processor' && event.name === 'otc-preview-startup')).toBe(true)
        const incomingSource = await page.locator('.preview-source-video:not(.preview-transition-previous)').getAttribute('src')
        if (transition !== 'control') {
          // Hidden-video frame callbacks may stall under a compositor. Both
          // frame and decoded-clock readiness must transfer audio to primary.
          expect(capture.events.some((event) => event.kind === 'linearRampToValueAtTime' && event.value === 1 &&
            event.media === 'preview-source-video' && event.source === incomingSource)).toBe(true)
        }
        if (primaryFrameDelayMs > 0) {
          expect(incomingSource).toBeTruthy()
          const incomingEvent = (kind: string): AudioCapture['events'][number] | undefined =>
            capture.events.find((event) => event.kind === kind && event.source === incomingSource)
          const delayed = incomingEvent('primary-frame-delayed')
          const released = incomingEvent('primary-frame-released')
          expect(Number(released?.wallTime) - Number(delayed?.wallTime)).toBeGreaterThan(duration * 1000)
        }
        const firstSound = capture.samples.findIndex((sample) => Math.abs(sample) > 0.02)
        let lastSound = capture.samples.length - 1
        while (lastSound > firstSound && Math.abs(capture.samples[lastSound] ?? 0) <= 0.02) lastSound -= 1
        expect(lastSound - firstSound).toBeGreaterThan(capture.sampleRate)
        // Chromium's currentFrame can repeat/catch up while the captured PCM
        // remains continuous. Keep that clock in diagnostics; validate actual
        // message order here and audible silence/sample jumps below instead.
        expect(capture.blocks.every((block, index) => block.recorder === 0 && block.sequence === index)).toBe(true)
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
