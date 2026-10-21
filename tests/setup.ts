import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest'

let errors: MockInstance<typeof console.error>
let warnings: MockInstance<typeof console.warn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error')
  warnings = vi.spyOn(console, 'warn')
})
afterEach(() => {
  const messages = [...errors.mock.calls, ...warnings.mock.calls]
  errors.mockRestore()
  warnings.mockRestore()
  // React warnings are test failures, not noise to hide in a passing report.
  expect(messages, 'Unexpected console errors or warnings').toEqual([])
})

Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: vi.fn().mockResolvedValue(undefined)
})
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  value: vi.fn()
})
