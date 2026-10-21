import type { Reporter, Suite, TestCase, TestError, TestResult } from '@playwright/test/reporter'
import { resultSummary, statusMark, suiteName, testName } from './names'

function text(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8')
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

function fileOf(test: TestCase): string {
  let suite: Suite | undefined = test.parent
  while (suite) {
    if (suite.type === 'file') return suite.title
    suite = suite.parent
  }
  return test.location.file
}

function describesOf(test: TestCase): string[] {
  const describes: string[] = []
  let suite: Suite | undefined = test.parent
  while (suite && suite.type !== 'file' && suite.type !== 'project' && suite.type !== 'root') {
    if (oneLine(suite.title)) describes.unshift(testName(suite.title))
    suite = suite.parent
  }
  return describes
}

function failure(test: TestCase, result: TestResult): boolean {
  return result.status !== 'skipped' && result.status !== test.expectedStatus
}

function errorText(error: TestError): string {
  return error.stack ?? error.message ?? error.value ?? error.snippet ?? 'Unknown error'
}

function writeOutput(label: string, chunks: (string | Buffer)[]): void {
  if (!chunks.length) return
  const output = chunks.map(text).join('')
  if (!output.trim()) return
  process.stderr.write(`${label}:\n${output.endsWith('\n') ? output : `${output}\n`}`)
}

export default class CompactPlaywrightReporter implements Reporter {
  private currentFile?: string
  private currentDescribes: string[] = []
  private results = new Map<TestCase, 'passed' | 'failed' | 'skipped'>()
  private errors = 0

  printsToStdio(): boolean {
    return true
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const file = fileOf(test)
    if (file !== this.currentFile) {
      this.currentFile = file
      this.currentDescribes = []
      process.stdout.write(`${suiteName(file)}\n`)
    }

    const describes = describesOf(test)
    let common = 0
    while (common < describes.length && describes[common] === this.currentDescribes[common]) common += 1
    for (let index = common; index < describes.length; index += 1) {
      process.stdout.write(`${'  '.repeat(index + 1)}${describes[index]}\n`)
    }
    this.currentDescribes = describes

    const state = result.status === 'skipped' ? 'skipped' : failure(test, result) ? 'failed' : 'passed'
    this.results.set(test, state)
    const marker = statusMark(state)
    process.stdout.write(`${'  '.repeat(describes.length + 1)}${marker} ${testName(test.title)}\n`)

    if (failure(test, result)) {
      for (const error of result.errors.length ? result.errors : result.error ? [result.error] : []) {
        process.stderr.write(`${errorText(error)}\n`)
      }
      writeOutput(`stdout (${oneLine(test.title)})`, result.stdout)
      for (const attachment of result.attachments) {
        process.stderr.write(`attachment ${attachment.name}: ${attachment.path ?? `[${attachment.contentType}]`}\n`)
      }
    }
    writeOutput(`stderr (${oneLine(test.title)})`, result.stderr)
  }

  onError(error: TestError): void {
    this.errors += 1
    process.stderr.write(`${errorText(error)}\n`)
  }

  onEnd(): void {
    const states = [...this.results.values()]
    process.stdout.write(`${resultSummary(
      states.filter((state) => state === 'passed').length,
      states.filter((state) => state === 'failed').length + this.errors,
      states.filter((state) => state === 'skipped').length
    )}\n`)
  }
}
