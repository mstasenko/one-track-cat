import { basename } from 'node:path'

export function ffmpegEnvironment(executable: string): NodeJS.ProcessEnv | undefined {
  if (process.platform !== 'linux' || basename(executable) !== 'ffmpeg') return undefined
  // Keep freed UHD frame buffers from accumulating in glibc arenas across cuts
  // and captions. Apply only to FFmpeg, not the editor or AI inference workers.
  return {
    ...process.env,
    MALLOC_ARENA_MAX: '2',
    MALLOC_MMAP_THRESHOLD_: '131072',
    MALLOC_TRIM_THRESHOLD_: '131072'
  }
}
