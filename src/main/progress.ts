export function ffmpegProgress(line: string, duration: number): number | null {
  const [key, value] = line.split('=', 2)
  if (key !== 'out_time_us' && key !== 'out_time_ms') return null
  if (!value || duration <= 0) return null
  const timestamp = Number(value)
  // FFmpeg reports out_time_us=N/A before some encoders have produced a frame.
  // Ignore that status instead of allowing NaN into the renderer's progress UI.
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, Math.min(0.99, timestamp / 1_000_000 / duration))
}

/** Estimates only from observed progress; callers should leave the value absent at startup. */
export function estimateEtaSeconds(progress: number, startedAt: number, now = Date.now()): number | undefined {
  if (!Number.isFinite(progress) || progress <= 0 || progress >= 1) return undefined
  const elapsed = (now - startedAt) / 1000
  if (!Number.isFinite(elapsed) || elapsed <= 0) return undefined
  return elapsed * (1 - progress) / progress
}
