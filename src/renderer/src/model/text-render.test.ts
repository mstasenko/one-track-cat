import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextOverlay } from '@shared/types'
import { renderTextBitmap } from './text-render'

const overlay = (patch: Partial<TextOverlay> = {}): TextOverlay => ({
  id: 'text', type: 'text', name: 'Title', start: 0, duration: 2, zIndex: 1,
  x: 0.1, y: 0.2, width: 0.5, height: 0.2, opacity: 1, text: 'BIG WIN NOW',
  fontFamily: 'Anton', fontSize: 10, color: '#fff', outlineColor: '#000',
  outlineWidth: 2, shadow: true, align: 'center', ...patch
})

function canvasContext(): { context: CanvasRenderingContext2D; strokeText: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn> } {
  const strokeText = vi.fn()
  const fillText = vi.fn()
  const context = {
    measureText: (text: string) => ({ width: text.length * 12 }) as TextMetrics,
    strokeText,
    fillText
  } as unknown as CanvasRenderingContext2D
  return { context, strokeText, fillText }
}

let fontLoad: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.restoreAllMocks()
  fontLoad = vi.fn().mockResolvedValue([])
  Object.defineProperty(document, 'fonts', {
    value: { load: fontLoad },
    configurable: true
  })
})

describe('text export bitmap', () => {
  it('renders wrapped bold text into a padded local bitmap with a stable anchor', async () => {
    const { context, strokeText, fillText } = canvasContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==')
    const bitmap = await renderTextBitmap(overlay({ text: 'BIG WIN\nRIGHT NOW' }), 320, 180)
    expect(fontLoad).toHaveBeenCalledWith('700 18px "Anton"')
    expect(context.font).toBe('700 18px "Anton"')
    expect(strokeText).toHaveBeenCalled()
    expect(fillText).toHaveBeenCalledTimes(2)
    expect(bitmap.dataUrl).toBe('data:image/png;base64,AA==')
    expect(bitmap.anchorX).toBeCloseTo(112)
    expect(bitmap.anchorY).toBeCloseTo(54)
  })

  it('supports left and right alignment without an outline or shadow', async () => {
    const { context, strokeText } = canvasContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==')
    await renderTextBitmap(overlay({ align: 'left', outlineWidth: 0, shadow: false }), 200, 100)
    expect(strokeText).not.toHaveBeenCalled()
    expect(context.textAlign).toBe('left')
    await renderTextBitmap(overlay({ align: 'right', outlineWidth: 0, shadow: false }), 200, 100)
    expect(context.textAlign).toBe('right')
  })

  it('reports an unavailable canvas renderer', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(renderTextBitmap(overlay(), 320, 180)).rejects.toThrow('Canvas text renderer is unavailable')
  })
})
