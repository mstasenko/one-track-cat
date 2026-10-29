import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

// Native RIFE-only stream check, NOT Electron/FFmpeg/audio/spatial qualification.
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, '..', 'dist', 'upscale-pack')
const width = 64, height = 64, frameBytes = width * height * 3
const makeInput = (frameCount) => {
  // A low-contrast gradient avoids accidentally exercising scene-cut detection.
  const input = Buffer.alloc(frameBytes * frameCount)
  for (let frame = 0; frame < frameCount; ++frame) {
    for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
      const offset = frame * frameBytes + (y * width + x) * 3
      input[offset] = 16 + x + frame * 2
      input[offset + 1] = 24 + y + frame * 2
      input[offset + 2] = 32 + ((x + y) >> 1) + frame * 2
    }
  }
  return input
}
const fail = (label, result, expectedBytes) => {
  const stderr = result.stderr ? result.stderr.toString() : ''
  const bytes = result.stdout ? result.stdout.length : 0
  process.stderr.write(`${label}: status=${result.status} signal=${result.signal} ` +
    `error=${result.error ? result.error.message : 'none'} bytes=${bytes}/${expectedBytes}\n${stderr}`)
  throw new Error(label)
}
const frames = 2
const input = makeInput(frames)
const result = spawnSync(join(root, 'otc-upscale'), [
  '--rife', join(root, 'rife.xml'), '--width', String(width), '--height', String(height),
  '--fps', '30', '--output-width', String(width), '--output-height', String(height),
  '--output-fps', '60', '--duration', String(frames / 30), '--device', 'CPU'
], { input, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
if (result.error || result.signal || result.status !== 0 ||
    (result.stdout ? result.stdout.length : 0) !== frameBytes * 4)
  fail('RIFE-only native smoke failed', result, frameBytes * 4)
console.log('PASS native CPU RIFE-only: 2 RGB24 inputs →4 outputs, same64x64 geometry; no FlashVSR+ sources')
for (const rate of [50.426654053916, 59]) {
  // Even 59→60 needs an interior gap; two source frames can only pad the tail.
  const fractionalFrames = 61
  const fractionalInput = makeInput(fractionalFrames)
  const duration = fractionalFrames / rate
  // Match native outputFrameCount; the margin absorbs decimal-duration roundoff.
  const expectedFrames = Math.ceil(fractionalFrames * 60 / rate - 1e-9)
  const converted = spawnSync(join(root, 'otc-upscale'), [
    '--rife', join(root, 'rife.xml'), '--width', String(width), '--height', String(height),
    '--fps', String(rate), '--output-width', String(width), '--output-height', String(height),
    '--output-fps', '60', '--duration', String(duration), '--device', 'CPU'
  ], { input: fractionalInput, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
  const expectedBytes = frameBytes * expectedFrames
  const stderr = converted.stderr ? converted.stderr.toString() : ''
  if (converted.error || converted.signal || converted.status !== 0 ||
      (converted.stdout ? converted.stdout.length : 0) !== expectedBytes || !stderr.includes('rife-device=CPU'))
    fail(`RIFE conversion failed at ${rate} fps`, converted, expectedBytes)
  const sourceSlots = []
  for (let frame = 0; frame < fractionalFrames; ++frame)
    sourceSlots.push(Math.round(frame * 60 / rate))
  const gap = sourceSlots.findIndex((slot, index) => index > 0 && slot - sourceSlots[index - 1] > 1)
  if (gap < 1) fail(`RIFE conversion at ${rate} fps produced no interior gap`, converted, expectedBytes)
  const outputSlot = sourceSlots[gap - 1] + 1
  const middle = converted.stdout.subarray(outputSlot * frameBytes, (outputSlot + 1) * frameBytes)
  const left = fractionalInput.subarray((gap - 1) * frameBytes, gap * frameBytes)
  const right = fractionalInput.subarray(gap * frameBytes, (gap + 1) * frameBytes)
  if (middle.equals(left) || middle.equals(right))
    fail(`RIFE conversion at ${rate} fps produced a trivial interior frame`, converted, expectedBytes)
  console.log(`PASS native CPU RIFE: ${rate} fps →60 fps; ${expectedFrames} output frames, interior gap, CPU marker`)
}

const repeated = Buffer.concat([input.subarray(0, frameBytes), input.subarray(0, frameBytes),
  input.subarray(frameBytes), input.subarray(frameBytes)])
const mixed = spawnSync(join(root, 'otc-upscale'), [
  '--rife', join(root, 'rife.xml'), '--width', String(width), '--height', String(height),
  '--fps', '60', '--output-width', String(width), '--output-height', String(height),
  '--output-fps', '60', '--duration', String(4 / 60), '--device', 'CPU', '--interpolation-range', '0:4'
], { input: repeated, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
if (mixed.error || mixed.signal || mixed.status !== 0 ||
    (mixed.stdout ? mixed.stdout.length : 0) !== frameBytes * 4 ||
    !mixed.stderr.toString().includes('rife-device=CPU') ||
    mixed.stdout.subarray(frameBytes, frameBytes * 2).equals(input.subarray(0, frameBytes)) ||
    mixed.stdout.subarray(frameBytes, frameBytes * 2).equals(input.subarray(frameBytes)))
  fail('Mixed-rate RIFE conversion did not generate the missing intermediate frame', mixed, frameBytes * 4)
console.log('PASS native CPU RIFE: fills repeated frames of a lower-rate clip on a 60 fps timeline')

const missing = spawnSync(join(root, 'otc-upscale'), [
  '--mode', 'turbo', '--models', join(root, 'missing-models'), '--width', '64', '--height', '64', '--fps', '30',
  '--output-width', '3840', '--output-height', '2160', '--output-fps', '30',
  '--duration', String(frames / 30), '--device', 'GPU.1'
], { input, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
if (missing.error || missing.signal || missing.status === 0 || (missing.stdout ? missing.stdout.length : 0) ||
    !missing.stderr.toString().includes('--models directory is required'))
  fail('Missing spatial models did not fail with the expected setup hint', missing, 0)
console.log('PASS missing FlashVSR+ models rejected before inference with explicit --models setup hint')
