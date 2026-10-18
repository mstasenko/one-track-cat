import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'
import { fitVideoRangeTransition } from '../video-range-transition'

function seconds(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function smoothRamp(time: string, start: number, duration: number): string {
  const progress = `min(1,max(0,((${time})-${seconds(start)})/${seconds(duration)}))`
  return `(${progress}*${progress}*(3-2*${progress}))`
}

function edgeWeight(time: string, start: number, duration: number, outgoing = false): string {
  const ramp = smoothRamp(time, start, duration)
  return `between(${time},${seconds(start)},${seconds(start + duration)})*(${outgoing ? ramp : `1-${ramp}`})`
}

function activeWeight(weights: string[], time: string): string {
  return weights.map((weight) => weight.replaceAll(time, 't')).join('+')
}

function frameBlend(name: string, weights: string[], initialOpacity: number, time: string): string {
  const weight = weights.length === 1 ? weights[0] : `max(${weights.join(',')})`
  // Evaluate once per frame, not once per pixel. Send after blending to avoid
  // framesync read-ahead applying future opacity to buffered frames. The command
  // sets the next frame's opacity; the first frame is initialized explicitly.
  const opacity = `1-(${weight})`.replaceAll(',', '\\\\,')
  const planes = [0, 1, 2, 3]
  const initial = planes.map((plane) => `c${plane}_opacity=${initialOpacity}`).join(':')
  // Set planes directly: FFmpeg's all_opacity command does not restore 1.0.
  const commands = planes.map((plane) => `[expr] blend@${name} c${plane}_opacity ${opacity}`).join(',')
  // Keep sendcmd priming the next frame, but bypass per-pixel blending between transition edges.
  return `blend@${name}=all_mode=normal:${initial}:enable='gt(${activeWeight(weights, time)},0)',sendcmd=c='0 ${commands}'`
}

export function addVideoRangeTransitionFilters(filters: string[], request: ExportRequest, input: string): string {
  let current = input
  const nextTime = `(round((round(T*${request.canvas.fps})+1)*1000000/${request.canvas.fps})/1000000)`
  for (const [index, rawEffect] of (request.videoTransitions ?? []).entries()) {
    const effect = fitVideoRangeTransition(rawEffect)
    const fadeWeights: string[] = []
    if (effect.into?.effect === 'fade' || effect.into?.effect === 'dissolve') {
      fadeWeights.push(edgeWeight(nextTime, effect.start, effect.into.duration))
    }
    if (effect.out?.effect === 'fade' || effect.out?.effect === 'dissolve') {
      fadeWeights.push(edgeWeight(nextTime, effect.start + effect.duration - effect.out.duration, effect.out.duration, true))
    }
    if (fadeWeights.length > 0) {
      const clean = `vrfadeclean${index}`
      const black = `vrblack${index}`
      const output = `vrfade${index}`
      filters.push(
        `[${current}]null[${clean}]`,
        `color=c=black:s=${request.canvas.width}x${request.canvas.height}:r=${request.canvas.fps}:d=${seconds(timelineDuration(request.segments))},settb=AVTB[${black}]`,
        `[${clean}][${black}]${frameBlend(output, fadeWeights, effect.start === 0 && (effect.into?.effect === 'fade' || effect.into?.effect === 'dissolve') ? 0 : 1, nextTime)}[${output}]`
      )
      current = output
    }

    const blurWeights: string[] = []
    if (effect.into?.effect === 'hblur' || effect.into?.effect === 'dissolve') {
      blurWeights.push(edgeWeight(nextTime, effect.start, effect.into.duration))
    }
    if (effect.out?.effect === 'hblur' || effect.out?.effect === 'dissolve') {
      blurWeights.push(edgeWeight(nextTime, effect.start + effect.duration - effect.out.duration, effect.out.duration, true))
    }
    if (blurWeights.length > 0) {
      const clean = `vrclean${index}`
      const blurInput = `vrblurin${index}`
      const blurred = `vrblur${index}`
      const output = `vrout${index}`
      const active = activeWeight(blurWeights, nextTime)
      filters.push(
        `[${current}]split=2[${clean}][${blurInput}]`,
        `[${blurInput}]gblur=sigma=18:steps=2:enable='gt(${active},0)'[${blurred}]`,
        `[${clean}][${blurred}]${frameBlend(output, blurWeights, effect.start === 0 && (effect.into?.effect === 'hblur' || effect.into?.effect === 'dissolve') ? 0 : 1, nextTime)}[${output}]`
      )
      current = output
    }
  }
  return current
}
