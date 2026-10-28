import type { CSSProperties } from 'react'
import { smoothstep } from '@shared/focus-zoom'
import type { EditSession, SourceSegment, TransitionEffect, VideoTransition } from '@shared/types'
import { spinTransform } from '@shared/spin-transition'
import { clamp, isFreezeSegment, positionAtOutputTime, sourceForSegment } from './timeline'
import { videoRangeStyleAtTime } from './video-range-transition'

interface ActiveTransition extends VideoTransition {
  previousSegmentIndex: number
  progress: number
}

interface TransitionStyles {
  current: CSSProperties
  previous: CSSProperties
}

export interface TransitionPreview {
  active: ActiveTransition
  currentSourceTime: number
  currentPath: string
  currentPlaybackRate: number
  previousSourceTime: number
  previousPath: string
  previousPlaybackRate: number
  styles: TransitionStyles
}

/** Returns the transition active during the beginning of the current segment. */
export function transitionAtOutputTime(
  segments: SourceSegment[],
  outputTime: number
): ActiveTransition | null {
  const position = positionAtOutputTime(segments, outputTime)
  const previous = position ? segments[position.segmentIndex - 1] : undefined
  if (!position || position.segmentIndex === 0 || isFreezeSegment(position.segment) || !previous) return null
  const transition = position.segment.transition
  if (!transition) return null
  const elapsed = outputTime - position.outputStart
  if (elapsed < 0 || elapsed >= transition.duration) return null
  return {
    ...transition,
    previousSegmentIndex: position.segmentIndex - 1,
    progress: clamp(elapsed / transition.duration, 0, 1)
  }
}

function spinStyle(progress: number, incoming: boolean, aspectRatio: number): CSSProperties {
  const transform = spinTransform(progress, incoming, aspectRatio)
  return {
    ...(incoming ? { opacity: smoothstep(progress) } : {}),
    transform: `rotate(${transform.angle * 180 / Math.PI}deg) scale(${transform.scale})`
  }
}

function currentStyle(effect: TransitionEffect, progress: number, aspectRatio: number): CSSProperties {
  const remaining = 1 - progress
  switch (effect) {
    case 'fade':
      return { opacity: progress * progress * (3 - 2 * progress) }
    case 'dissolve':
      return { opacity: progress, filter: `blur(${10 * progress * remaining}px)` }
    case 'wipeleft':
      return { clipPath: `inset(0 ${remaining * 100}% 0 0)` }
    case 'wiperight':
      return { clipPath: `inset(0 0 0 ${remaining * 100}%)` }
    case 'slideleft':
      return { transform: `translateX(${remaining * 100}%)` }
    case 'slideright':
      return { transform: `translateX(${-remaining * 100}%)` }
    case 'circleopen':
      return { clipPath: `circle(${progress * 75}% at 50% 50%)` }
    case 'zoomin':
      return { opacity: progress, transform: `scale(${0.72 + progress * 0.28})` }
    case 'hblur':
      return { opacity: progress, filter: `blur(${remaining * 18}px)` }
    case 'spin': return spinStyle(progress, true, aspectRatio)
  }
}

function previousStyle(effect: TransitionEffect, progress: number, aspectRatio: number): CSSProperties {
  switch (effect) {
    case 'slideleft':
      return { transform: `translateX(${-progress * 28}%)` }
    case 'slideright':
      return { transform: `translateX(${progress * 28}%)` }
    case 'dissolve':
      return { filter: `blur(${10 * progress * (1 - progress)}px)` }
    case 'zoomin':
      return { filter: `brightness(${1 - progress * 0.3})`, transform: `scale(${1 + progress * 0.08})` }
    case 'hblur':
      return { filter: `blur(${progress * 12}px)` }
    case 'spin': return spinStyle(progress, false, aspectRatio)
    default:
      return {}
  }
}

export function transitionStyles(transition: Pick<ActiveTransition, 'effect' | 'progress'>,
  canvas?: Pick<EditSession['canvas'], 'width' | 'height'>): TransitionStyles {
  const progress = clamp(transition.progress, 0, 1)
  const aspectRatio = canvas && canvas.height > 0 ? canvas.width / canvas.height : 16 / 9
  return {
    current: currentStyle(transition.effect, progress, aspectRatio),
    previous: previousStyle(transition.effect, progress, aspectRatio)
  }
}

export function transitionPreviewAtOutputTime(
  session: EditSession,
  outputTime: number
): TransitionPreview | null {
  const position = positionAtOutputTime(session.segments, outputTime)
  const active = transitionAtOutputTime(session.segments, outputTime)
  if (!active || !position) return null
  const previous = session.segments[active.previousSegmentIndex]
  if (!previous) return null
  const previousSource = sourceForSegment(session, previous)
  const currentSource = sourceForSegment(session, position.segment)
  if (!previousSource || !currentSource) return null
  const styles = transitionStyles(active, session.canvas)
  const rangeStyle = videoRangeStyleAtTime(session.videoTransitions ?? [], outputTime)
  const merge = (style: CSSProperties): CSSProperties => ({
    ...rangeStyle,
    ...style,
    opacity: (typeof rangeStyle.opacity === 'number' ? rangeStyle.opacity : 1) *
      (typeof style.opacity === 'number' ? style.opacity : 1),
    filter: [rangeStyle.filter, style.filter].filter(Boolean).join(' ') || undefined
  })
  return {
    active,
    currentSourceTime: position.sourceTime,
    currentPath: currentSource.playbackPath,
    currentPlaybackRate: isFreezeSegment(position.segment) ? 0 : (position.segment.playbackRate ?? 1),
    previousPath: previousSource.playbackPath,
    previousPlaybackRate: isFreezeSegment(previous) ? 0 : (previous.playbackRate ?? 1),
    // Continue past the cut using available source footage; never rewind the tail.
    previousSourceTime: isFreezeSegment(previous)
      ? previous.sourceTime
      : Math.min(previousSource.metadata.duration - 1 / previousSource.metadata.fps,
        previous.sourceEnd + active.progress * active.duration * (previous.playbackRate ?? 1)),
    styles: { current: merge(styles.current), previous: merge(styles.previous) }
  }
}
