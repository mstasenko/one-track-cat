import { basename } from 'node:path'

export function ffmpegEnvironment(executable: string, reuseFrames = false): NodeJS.ProcessEnv | undefined {
  if (process.platform !== 'linux' || basename(executable) !== 'ffmpeg') return undefined
  // Keep freed UHD frame buffers from accumulating in glibc arenas across cuts
  // and captions. Apply only to FFmpeg, not the editor or AI inference workers.
  // Larger decoder thresholds reuse frame-sized allocations. Keep this scoped:
  // encoders and remuxes still need the conservative memory-release profile.
  return {
    ...process.env,
    MALLOC_ARENA_MAX: '2',
    MALLOC_MMAP_THRESHOLD_: reuseFrames ? '33554432' : '131072',
    MALLOC_TRIM_THRESHOLD_: reuseFrames ? '67108864' : '131072'
  }
}
