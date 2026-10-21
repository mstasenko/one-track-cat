import { afterEach, expect, it, vi } from 'vitest'
import type { TestCase, TestResult } from '@playwright/test/reporter'
import type { TestModule, Vitest } from 'vitest/node'
import { spawnSync } from 'node:child_process'
import Reporter from './reporters/playwright'
import VitestReporter from './reporters/vitest'
import { suiteName, testName } from './reporters/names'

afterEach(() => { vi.restoreAllMocks() })

function testCase(title: string): TestCase {
  return {
    title, expectedStatus: 'passed', location: { file: '/tests/dialogs.spec.ts' },
    parent: { type: 'describe', title: 'Reset', parent: { type: 'file', title: 'dialogs.spec.ts' } }
  } as unknown as TestCase
}

function result(status = 'passed'): TestResult {
  return {
    status, errors: [], stdout: ['debug output'], stderr: [],
    attachments: [{ name: 'trace', path: '/report/trace.zip' }]
  } as unknown as TestResult
}

it('groups short passing names without blank rows, diagnostics or repeated headings', () => {
  vi.stubEnv('FORCE_COLOR', '1')
  vi.stubEnv('NO_COLOR', undefined)
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const reporter = new Reporter()
  reporter.onTestEnd(testCase('confirm'), result())
  reporter.onTestEnd(testCase('Cancel'), { ...result(), stderr: ['\n'] })
  const output = stdout.mock.calls.map(([line]) => line).join('')
  expect(output).toBe('Dialogs\n  Reset\n    \x1b[32m✓\x1b[0m Confirm\n    \x1b[32m✓\x1b[0m Cancel\n')
  expect(stderr).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})

it('uses sentence case across suites and tests without changing identifiers or acronyms', () => {
  expect(suiteName('/tests/face-apply.spec.ts')).toBe('Face apply')
  expect(suiteName('/tests/ai-export.test.tsx')).toBe('AI export')
  expect(suiteName('/tests/Preview.handoff.test.tsx')).toBe('Preview handoff')
  expect(testName('  restores\n  GPU state  ')).toBe('Restores GPU state')
  expect(testName('uses cpu and gpu for ai')).toBe('Uses CPU and GPU for AI')
  expect(testName('useFacePreview')).toBe('useFacePreview')
  expect(testName('')).toBe('')
})

it('retains failure stacks, captured output, attachments and unexpected stderr', () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const reporter = new Reporter()
  const failed = result('failed')
  failed.errors = [{ stack: 'Failure stack', message: 'Failure' }]
  failed.stderr = ['error details']
  reporter.onTestEnd(testCase('Confirm'), failed)
  reporter.onTestEnd(testCase('Cancel'), { ...result(), stderr: ['unexpected warning'] })
  const output = stderr.mock.calls.map(([line]) => line).join('')
  for (const detail of ['Failure stack', 'debug output', 'error details', '/report/trace.zip', 'unexpected warning']) {
    expect(output).toContain(detail)
  }
})

it('prints identical grouped results and summaries for Vitest, Playwright and Python', () => {
  vi.stubEnv('FORCE_COLOR', '1')
  vi.stubEnv('NO_COLOR', undefined)
  try {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const playwright = new Reporter()
    for (const name of ['Cancel', 'Confirm']) playwright.onTestEnd(testCase(name), result())
    playwright.onEnd()
    const expected = stdout.mock.calls.map(([line]) => line).join('')
    expect(expected).toBe('Dialogs\n  Reset\n    \x1b[32m✓\x1b[0m Cancel\n    \x1b[32m✓\x1b[0m Confirm\nResults: 2 passed, 0 failed, 0 skipped\n')

    const tests = ['cancel', 'confirm'].map((name) => ({ type: 'test', name, result: () => ({ state: 'passed' }) }))
    const suite = { type: 'suite', name: 'Reset', errors: () => [], children: { array: () => tests } }
    const module = {
      relativeModuleId: 'dialogs.test.ts', state: () => 'passed', errors: () => [],
      children: { array: () => [suite], allTests: () => tests, allSuites: () => [suite] }
    } as unknown as TestModule
    stdout.mockClear()
    const vitest = new VitestReporter()
    vitest.onInit({ logger: { printError: vi.fn() } } as unknown as Vitest)
    vitest.onTestModuleEnd(module)
    vitest.onTestRunEnd([module], [])
    expect(stdout.mock.calls.map(([line]) => line).join('')).toBe(expected)

    const source = [
      'import sys, unittest', 'sys.path.insert(0, "scripts")',
      'from test_output import run_tests', '__file__ = "dialogs.py"',
      'class Reset(unittest.TestCase):',
      ' def test_cancel(self): pass', ' def test_confirm(self): pass',
      'raise SystemExit(run_tests())'
    ].join('\n')
    const python = spawnSync('python3', ['-c', source], { encoding: 'utf8', timeout: 5_000 })
    expect(python.status).toBe(0)
    expect(python.stderr).toBe(expected)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('retains Vitest test, hook, collection and unhandled errors plus failed-test logs', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const printError = vi.fn()
  const reporter = new VitestReporter()
  reporter.onInit({ logger: { printError } } as unknown as Vitest)
  reporter.onUserConsoleLog({ taskId: 'bad', content: 'failure details' } as never)
  reporter.onUserConsoleLog({ taskId: 'good', content: 'passing debug output' } as never)
  const module = {
    id: 'module', state: () => 'failed', errors: () => [new Error('collection')],
    children: {
      allSuites: () => [{ id: 'suite', errors: () => [new Error('hook')] }],
      allTests: () => [
        { id: 'bad', result: () => ({ state: 'failed', errors: [new Error('assertion')] }) },
        { id: 'good', result: () => ({ state: 'passed' }) },
        { id: 'skip', result: () => ({ state: 'skipped' }) }
      ]
    }
  } as unknown as TestModule
  reporter.onTestRunEnd([module], [{ message: 'unhandled' }])
  expect(printError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['collection', 'hook', 'assertion', 'unhandled'])
  expect(stderr.mock.calls.map(([line]) => line).join('')).toBe('failure details\n')
  expect(stdout.mock.calls.map(([line]) => line).join('')).toBe('Results: 1 passed, 4 failed, 1 skipped\n')
})
