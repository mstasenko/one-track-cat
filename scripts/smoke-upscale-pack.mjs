import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

// Native RIFE-only stream check, NOT Electron/FFmpeg/audio/spatial qualification.
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, '..', 'dist', 'upscale-pack')
const width = 64, height = 64, frames = 2, frameBytes = width * height * 3
const input = Buffer.alloc(frameBytes * frames)
for (let frame = 0; frame < frames; ++frame) {
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const offset = frame * frameBytes + (y * width + x) * 3
    input[offset] = (x * 3 + frame * 17) % 256
    input[offset + 1] = (y * 3 + frame * 31) % 256
    input[offset + 2] = (x + y + frame * 47) % 256
  }
}
const result = spawnSync(join(root, 'otc-upscale'), [
  '--rife', join(root, 'rife.xml'), '--width', String(width), '--height', String(height),
  '--fps', '30', '--output-width', String(width), '--output-height', String(height),
  '--output-fps', '60', '--duration', String(frames / 30), '--device', 'CPU'
], { input, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
if (result.error || result.signal || result.status !== 0 || result.stdout.length !== frameBytes * 4) {
  process.stderr.write(result.stderr ?? '')
  throw new Error(`RIFE-only native smoke failed: status=${result.status} signal=${result.signal} bytes=${result.stdout?.length}`)
}
console.log('PASS native CPU RIFE-only: 2 RGB24 inputs →4 outputs, same64x64 geometry; no FlashVSR+ sources')
for (const rate of [50.426654053916, 59]) {
  const converted = spawnSync(join(root, 'otc-upscale'), [
    '--rife', join(root, 'rife.xml'), '--width', String(width), '--height', String(height),
    '--fps', String(rate), '--output-width', String(width), '--output-height', String(height),
    '--output-fps', '60', '--duration', String(frames / rate), '--device', 'CPU'
  ], { input, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
  if (converted.error || converted.signal || converted.status !== 0 || converted.stdout.length !== frameBytes * 3 ||
      !converted.stderr.toString().includes('rife-device=CPU')) throw new Error(`RIFE conversion failed at ${rate} fps`)
  console.log(`PASS native CPU RIFE: ${rate} fps →60 fps; no 50 fps cutoff`)
}
const repeated = Buffer.concat([input.subarray(0, frameBytes), input.subarray(0, frameBytes),
  input.subarray(frameBytes), input.subarray(frameBytes)])
const mixed = spawnSync(join(root, 'otc-upscale'), [
  '--rife', join(root, 'rife.xml'), '--width', String(width), '--height', String(height),
  '--fps', '60', '--output-width', String(width), '--output-height', String(height),
  '--output-fps', '60', '--duration', String(4 / 60), '--device', 'CPU', '--interpolation-range', '0:4'
], { input: repeated, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
if (mixed.error || mixed.signal || mixed.status !== 0 || mixed.stdout.length !== frameBytes * 4 ||
    !mixed.stderr.toString().includes('rife-device=CPU') ||
    mixed.stdout.subarray(frameBytes, frameBytes * 2).equals(input.subarray(0, frameBytes)) ||
    mixed.stdout.subarray(frameBytes, frameBytes * 2).equals(input.subarray(frameBytes))) {
  throw new Error('Mixed-rate RIFE conversion did not generate the missing intermediate frame')
}
console.log('PASS native CPU RIFE: fills repeated frames of a lower-rate clip on a 60 fps timeline')
const missing = spawnSync(join(root, 'otc-upscale'), [
  '--mode', 'turbo', '--models', join(root, 'missing-models'), '--width', '64', '--height', '64', '--fps', '30',
  '--output-width', '3840', '--output-height', '2160', '--output-fps', '30',
  '--duration', String(frames / 30), '--device', 'GPU.1'
], { input, maxBuffer: 1024 * 1024, env: { ...process.env, otc_CPU_ONLY: '1' } })
if (missing.error || missing.signal || missing.status === 0 || missing.stdout.length ||
    !missing.stderr.toString().includes('--models directory is required')) {
  throw new Error('Missing spatial models did not fail with the expected setup hint')
}
console.log('PASS missing FlashVSR+ models rejected before inference with explicit --models setup hint')
