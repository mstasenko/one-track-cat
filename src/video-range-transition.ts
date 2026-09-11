import type { VideoRangeTransition } from './types'

/** Timeline edits can shorten a range without updating its nested edge durations. */
export function fitVideoRangeTransition(effect: VideoRangeTransition): VideoRangeTransition {
  const maximum = effect.duration / (effect.into && effect.out ? 2 : 1)
  const into = effect.into && effect.into.duration > maximum ? { ...effect.into, duration: maximum } : effect.into
  const out = effect.out && effect.out.duration > maximum ? { ...effect.out, duration: maximum } : effect.out
  return into === effect.into && out === effect.out ? effect : {
    ...effect,
    ...(into ? { into } : {}),
    ...(out ? { out } : {})
  }
}
