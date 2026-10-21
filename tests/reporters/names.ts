// Keep identifiers/acronyms intact; normalize prose rather than rewriting test IDs.
export function testName(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim()
    .replace(/\b(ai|cpu|gpu|ipc|svg|imkg|e2e)\b/gi, (word) => word.toUpperCase())
  return /^[a-z]\w*[A-Z]\w*(?:\s|$)/.test(name) ? name : name.charAt(0).toUpperCase() + name.slice(1)
}

export function suiteName(file: string): string {
  const name = file.replace(/^.*[\\/]/, '').replace(/\.(?:spec|test)\.[^.]+$/, '')
  return testName(name.replace(/[-_.]+/g, ' '))
}

export function statusMark(state: 'passed' | 'failed' | 'skipped'): string {
  const [code, mark] = state === 'passed' ? [32, '✓'] : state === 'failed' ? [31, '✗'] : [33, '-']
  return process.env.FORCE_COLOR === '0' || process.env.NO_COLOR !== undefined
    ? mark : `\u001b[${code}m${mark}\u001b[0m`
}

export function resultSummary(passed: number, failed: number, skipped: number): string {
  return `Results: ${passed} passed, ${failed} failed, ${skipped} skipped`
}
