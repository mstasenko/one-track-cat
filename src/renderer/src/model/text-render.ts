import type { RenderedTextBitmap, TextOverlay } from '@shared/types'

function wrapParagraph(context: CanvasRenderingContext2D, paragraph: string, maximumWidth: number): string[] {
  const output: string[] = []
  let line = ''
  for (const word of paragraph.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && context.measureText(candidate).width > maximumWidth) {
      output.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  output.push(line)
  return output
}

function wrapLines(context: CanvasRenderingContext2D, text: string, maximumWidth: number): string[] {
  return text.split('\n').flatMap((paragraph) => wrapParagraph(context, paragraph, maximumWidth))
}

export async function renderTextBitmap(overlay: TextOverlay, width: number, height: number): Promise<RenderedTextBitmap> {
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('Canvas text renderer is unavailable')
  const pixels = Math.max(12, height * overlay.fontSize / 100)
  await document.fonts.load(`700 ${pixels}px "${overlay.fontFamily}"`)
  measure.font = `700 ${pixels}px "${overlay.fontFamily}"`
  const boxWidth = Math.max(2, width * overlay.width)
  const boxHeight = Math.max(2, height * overlay.height)
  const lines = wrapLines(measure, overlay.text, boxWidth)
  const outline = overlay.outlineWidth * Math.max(1, height / 720)
  const shadow = overlay.shadow ? Math.max(4, height / 100) + Math.max(2, height / 180) : 0
  const padding = Math.ceil(outline + shadow + 2)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.ceil(boxWidth + padding * 2))
  canvas.height = Math.max(2, Math.ceil(Math.max(boxHeight, lines.length * pixels * 1.12) + padding * 2))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas text renderer is unavailable')
  context.font = `700 ${pixels}px "${overlay.fontFamily}"`
  context.textBaseline = 'top'
  context.textAlign = overlay.align
  context.fillStyle = overlay.color
  context.strokeStyle = overlay.outlineColor
  context.lineJoin = 'round'
  context.lineWidth = outline
  if (overlay.shadow) {
    context.shadowColor = 'rgba(0,0,0,.8)'
    context.shadowBlur = Math.max(4, height / 100)
    context.shadowOffsetY = Math.max(2, height / 180)
  }
  const boxX = (canvas.width - boxWidth) / 2
  const boxY = (canvas.height - boxHeight) / 2
  const textX = overlay.align === 'left' ? boxX : overlay.align === 'right' ? boxX + boxWidth : boxX + boxWidth / 2
  lines.forEach((line, index) => {
    const lineY = boxY + index * pixels * 1.12
    if (overlay.outlineWidth > 0) context.strokeText(line, textX, lineY, boxWidth)
    context.fillText(line, textX, lineY, boxWidth)
  })
  const anchorX = width * (overlay.x + overlay.width / 2)
  const anchorY = height * (overlay.y + overlay.height / 2)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    x: anchorX - canvas.width / 2,
    y: anchorY - canvas.height / 2,
    anchorX,
    anchorY
  }
}
