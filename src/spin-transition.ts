import { smoothstep, smoothstepExpression } from './focus-zoom'

const fullTurnRadians = Math.PI * 2
const defaultAspectRatio = 16 / 9

function boundedProgress(progress: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0))
}

function coverScale(angle: number, aspectRatio: number): number {
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : defaultAspectRatio
  const cosine = Math.abs(Math.cos(angle))
  const sine = Math.abs(Math.sin(angle))
  const scale = Math.max(cosine + sine / ratio, cosine + sine * ratio)
  return Math.abs(scale - 1) < 1e-12 ? 1 : scale
}

/** Rotation and cover scale shared by the CSS preview and the encoded effect. */
export function spinTransform(progress: number, incoming: boolean, aspectRatio = defaultAspectRatio): {
  angle: number
  scale: number
} {
  const value = smoothstep(boundedProgress(progress))
  const angle = incoming ? -fullTurnRadians * (1 - value) : fullTurnRadians * value
  return { angle, scale: coverScale(angle, aspectRatio) }
}

/** Native rotate/zoompan expressions use one output frame per input frame. */
export function spinFilterExpressions(fps: number, duration: number, incoming: boolean,
  width: number, height: number): { angle: string; scale: string } {
  const rotateProgress = `t/${duration}`
  const zoomProgress = `on/${fps * duration}`
  const rotateEase = smoothstepExpression(rotateProgress)
  const zoomEase = smoothstepExpression(zoomProgress)
  const angle = incoming ? `-${fullTurnRadians}*(1-${rotateEase})` : `${fullTurnRadians}*${rotateEase}`
  const zoomAngle = incoming ? `-${fullTurnRadians}*(1-${zoomEase})` : `${fullTurnRadians}*${zoomEase}`
  const scale = `max(abs(cos(${zoomAngle}))+${height}/${width}*abs(sin(${zoomAngle})),abs(cos(${zoomAngle}))+${width}/${height}*abs(sin(${zoomAngle})))`
  return { angle, scale }
}

export function spinVideoFilter(input: string, output: string, fps: number, duration: number,
  incoming: boolean, width: number, height: number): string {
  const { angle, scale } = spinFilterExpressions(fps, duration, incoming, width, height)
  return `${input}rotate=angle='${angle}':ow=iw:oh=ih:fillcolor=black,` +
    `zoompan=z='${scale}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},` +
    `settb=AVTB,setpts=N/${fps}/TB,fps=${fps},format=yuv420p${output}`
}

export function spinTransitionFilters(outgoingInput: string, incomingInput: string, outgoing: string,
  incoming: string, mixed: string, fps: number, duration: number, width: number, height: number): string[] {
  const outgoingLabel = `[${outgoing}spin]`
  const incomingLabel = `[${incoming}spin]`
  const blend = "custom:expr='A*(P*P*(3-2*P))+B*(1-P*P*(3-2*P))'"
  return [
    spinVideoFilter(outgoingInput, outgoingLabel, fps, duration, false, width, height),
    spinVideoFilter(incomingInput, incomingLabel, fps, duration, true, width, height),
    `${outgoingLabel}${incomingLabel}xfade=transition=${blend}:duration=${Math.max(0, duration).toFixed(6)}:offset=0${mixed}`
  ]
}
