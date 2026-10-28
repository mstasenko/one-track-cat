import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, main, seekTimeline, syntheticVideo } from './support'

test('Narration: open the transcript near the playhead without jumping while editing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-transcript-scroll-'))
  const input = syntheticVideo(directory)
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_COMPACT: '1', otc_E2E_GPU_OFF: '1' }) })
  try {
    await app.evaluate(({ ipcMain }, path) => {
      const draft = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stage: 'cleaned', approved: false, contentKey: 'test', range: [0, 6],
        language: 'en', strength: 'balanced', originalPath: path, speechPath: path, backgroundPath: path,
        phrases: Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, start: index / 5, end: index / 5 + 0.18,
          text: `Original ${index}.`, revisedText: `Revised ${index}.`, needsTimingReview: false })) }
      for (const name of ['status', 'analyze', 'load']) ipcMain.removeHandler(`narration:${name}`)
      ipcMain.handle('narration:status', () => ({ available: true, message: 'Test voice pack' }))
      ipcMain.handle('narration:analyze', () => draft)
      ipcMain.handle('narration:load', () => draft)
    }, input)
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await seekTimeline(page, 0.85)
    await click(page.getByRole('button', { name: 'Re-voice', exact: true }))
    await click(page.getByRole('button', { name: 'Recognize', exact: true }))
    await click(page.getByRole('button', { name: 'Edit transcript', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Edit narration transcript' })
    const field = dialog.locator('textarea[data-playhead]')
    const scroller = dialog.locator('.transcript-scroll')
    await expect(field).toBeFocused()
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const visible = await field.evaluate((element) => {
      const container = element.closest('.transcript-scroll')
      if (!container) return false
      const row = element.getBoundingClientRect(), bounds = container.getBoundingClientRect()
      return row.top >= bounds.top && row.bottom <= bounds.bottom
    })
    expect(visible).toBe(true)
    const before = await scroller.evaluate((element) => element.scrollTop)
    await field.fill('My corrected wording.')
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0)
    await click(dialog.getByRole('button', { name: 'Apply', exact: true }))
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Narration: edit cleaned text, generate, and switch timeline audio', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-narration-desktop-'))
  const input = syntheticVideo(directory)
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_COMPACT: '1', otc_E2E_GPU_OFF: '1' }) })
  try {
    await app.evaluate(({ ipcMain }, path) => {
      const draft = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stage: 'cleaned', approved: false, contentKey: 'test', range: [0, 6],
        language: 'en', strength: 'balanced', originalPath: path, speechPath: path, backgroundPath: path,
        phrases: [{ id: 'phrase-0', start: 1, end: 5, text: 'Um, please wait here.', revisedText: 'Please wait here.', needsTimingReview: false }] }
      for (const name of ['status', 'analyze', 'load', 'generate']) ipcMain.removeHandler(`narration:${name}`)
      ipcMain.handle('narration:status', () => ({ available: true, message: 'Test voice pack' }))
      ipcMain.handle('narration:analyze', (_event, _request, _range, language) => {
        if (language !== 'auto') throw new Error('Recognition must detect language automatically')
        return draft
      })
      ipcMain.handle('narration:load', (_event, id: string) => ({ ...draft, approved: id.startsWith('b'), id,
        phrases: draft.phrases.map((phrase) => ({ ...phrase, ...(id.startsWith('b') ? { revisedText: 'Wait here.', generatedTempo: 1.085 } : {}) })) }))
      let generations = 0
      ipcMain.handle('narration:generate', (_event, _request, _id, review: string, voiceStyle: string,
        mix: { levelVoice?: boolean; backgroundVolume?: number; subtitles?: boolean }) => {
        if (++generations > 1) throw new Error('Redo must reuse the generated audio')
        if (!review.includes('Wait here.') || voiceStyle !== 'cosy') throw new Error('Missing reviewed narration or style')
        if (mix.levelVoice !== true || mix.backgroundVolume !== 0.25) throw new Error('Missing voice/environment mix settings')
        if (mix.subtitles !== true) throw new Error('Missing requested subtitles')
        return { id: 'generated-narration', type: 'audio', name: 'Re-voice', path, volume: 1, sourceIn: 0,
          start: 0, duration: 6, zIndex: 1, narration: { draftId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', enabled: true, voiceStyle },
          subtitleLines: [{ start: 1.1, end: 2.1, text: 'Wait here.' }] }
      })
    }, input)
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await click(page.getByRole('button', { name: 'Re-voice', exact: true }))
    await expect(page.getByText('Whisper language', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Terminology hints', exact: true })).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: 'Even voice volume', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Subtitles', exact: true })).not.toBeChecked()
    await click(page.getByRole('button', { name: 'Recognize', exact: true }))
    await click(page.getByRole('button', { name: 'Edit transcript', exact: true }))
    const editor = page.getByRole('dialog', { name: 'Edit narration transcript' })
    await expect(editor).toBeVisible()
    await expect(editor.getByRole('tab')).toHaveCount(0)
    await expect(editor.getByRole('combobox')).toHaveCount(0)
    await expect(editor.getByRole('checkbox')).toHaveCount(0)
    await expect(editor.getByRole('button')).toHaveText(['Apply'])
    await expect(page.getByRole('textbox', { name: 'Revised phrase 1' })).toHaveValue('Please wait here.')
    await page.getByRole('textbox', { name: 'Revised phrase 1' }).fill('Wait here.')
    expect((await editor.boundingBox())?.width).toBeGreaterThan(700)
    await click(editor.getByRole('button', { name: 'Apply', exact: true }))
    await expect(editor).not.toBeVisible()
    await click(page.getByRole('button', { name: 'Edit transcript', exact: true }))
    await page.keyboard.press('Escape')
    await expect(editor).not.toBeVisible()
    await expect(page.getByLabel('Preview audio')).toHaveValue('original')
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled()
    await page.getByLabel('Voice style', { exact: true }).selectOption('cosy')
    await expect(page.getByRole('checkbox', { name: 'Even voice volume', exact: true })).toBeChecked()
    await page.getByRole('spinbutton', { name: 'Background', exact: true }).fill('25')
    const backgroundBounds = await page.getByRole('spinbutton', { name: 'Background', exact: true }).evaluate((element) => {
      const panel = element.closest('.narration-panel')
      if (!panel) throw new Error('Missing Re-voice panel')
      return { right: element.getBoundingClientRect().right,
        limit: panel.getBoundingClientRect().left + panel.clientWidth - parseFloat(getComputedStyle(panel).paddingRight) }
    })
    expect(backgroundBounds.right).toBeLessThanOrEqual(backgroundBounds.limit + 0.5)
    await page.getByLabel('Voice style', { exact: true }).focus()
    const focusRing = await page.getByLabel('Voice style', { exact: true }).evaluate((element) => {
      const style = getComputedStyle(element)
      return { offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth) }
    })
    // The ring must fit inside the control, even against an overflow-clipped panel edge.
    expect(focusRing.width).toBeGreaterThan(0)
    expect(focusRing.offset + focusRing.width).toBeLessThanOrEqual(0)
    await page.getByRole('checkbox', { name: 'Subtitles', exact: true }).check({ force: true })
    await click(page.getByRole('button', { name: 'Generate', exact: true }))
    await expect(page.getByLabel('Preview audio')).toHaveValue('ai')
    await seekTimeline(page, 0.25)
    await expect(page.locator('.preview-text')).toHaveText('Wait here.')
    await expect(page.locator('.timeline-overlay')).toHaveCount(1)
    await expect(page.locator('.visual-overlay')).toHaveCSS('pointer-events', 'none')
    await page.getByLabel('Preview audio').selectOption('original')
    await expect(page.getByLabel('Preview audio')).toHaveValue('original')
    await expect(page.locator('.preview-text')).toHaveCount(0)
    await page.getByLabel('Preview audio').selectOption('ai')
    await expect(page.locator('.preview-text')).toHaveText('Wait here.')
    await expect(page.locator('audio').first()).not.toHaveAttribute('muted')
    await expect(page.getByRole('button', { name: 'Remove Re-voice' })).toHaveCount(0)
    await click(page.getByRole('button', { name: 'Edit transcript', exact: true }))
    await expect(page.getByRole('dialog').locator('small')).toHaveText(' · 8.5% faster')
    await click(page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }))
    // Undo the two Original/AI switches, then the single applied Re-voice.
    await click(page.getByRole('button', { name: 'Undo', exact: true }))
    await click(page.getByRole('button', { name: 'Undo', exact: true }))
    await click(page.getByRole('button', { name: 'Undo', exact: true }))
    await expect(page.getByRole('button', { name: 'Re-voice', exact: true })).toBeVisible()
    await click(page.getByRole('button', { name: 'Redo', exact: true }))
    await expect(page.getByLabel('Preview audio')).toHaveValue('ai')
    await expect(page.locator('.preview-text')).toHaveText('Wait here.')
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})
