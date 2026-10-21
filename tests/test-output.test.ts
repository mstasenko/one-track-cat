import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

function output(source: string, environment: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['scripts/run-tests.mjs', process.execPath, '-e', source], {
    env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 5_000
  })
}

it('forwards complete lines without blank rows and preserves errors and exit codes', () => {
  const first = JSON.stringify('  ✓ first')
  const rest = JSON.stringify('\r\n  ✓ second\nlast partial line')
  const error = JSON.stringify('failure details\n')
  const result = output(`process.stdout.write(${first}); setTimeout(() => {
    process.stdout.write(${rest}); process.stderr.write(${error}); process.exitCode = 7
  }, 10)`)
  expect(result.stdout).toBe('  ✓ first\n  ✓ second\nlast partial line\n')
  expect(result.stderr).toBe('failure details\n')
  expect(result.status).toBe(7)
})

it('enables color and disables terminal redraws without conflicting NO_COLOR', () => {
  const result = output('process.stdout.write(JSON.stringify(process.env))', { NO_COLOR: '1', FORCE_COLOR: undefined })
  const environment = JSON.parse(String(result.stdout)) as NodeJS.ProcessEnv
  expect(environment.FORCE_COLOR).toBe('1')
  expect(environment.PLAYWRIGHT_FORCE_TTY).toBe('0')
  expect(environment.NO_COLOR).toBeUndefined()
  expect(result.status).toBe(0)
})

it('preserves explicit color opt-out and reports launch failures', () => {
  expect(output('process.stdout.write(process.env.FORCE_COLOR)', { FORCE_COLOR: '0' }).stdout).toBe('0\n')
  const failure = spawnSync(process.execPath, ['scripts/run-tests.mjs', '/otc-missing-test-command'], {
    encoding: 'utf8', timeout: 5_000
  })
  expect(failure.status).toBe(1)
  expect(failure.stderr).toContain('ENOENT')
})

it('prints Python pass, failure and skip names while preserving failure diagnostics', () => {
  const source = [
    'import sys, unittest',
    'sys.path.insert(0, "scripts")',
    'from test_output import run_tests',
    'class Cases(unittest.TestCase):',
    ' def test_pass(self): pass',
    ' def test_fail(self): self.fail("expected diagnostic")',
    ' @unittest.skip("intentional")',
    ' def test_skip(self): pass',
    'raise SystemExit(run_tests())'
  ].join('\n')
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', 'python3', '-c', source], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, FORCE_COLOR: '1' }
  })
  expect(result.stderr).toContain('\x1b[32m✓\x1b[0m')
  expect(result.stderr).toContain('\x1b[31m✗\x1b[0m')
  expect(result.stderr).toContain('\x1b[33m-\x1b[0m')
  expect(result.stderr).toContain('  Cases\n')
  expect(result.stderr).toContain('✓\x1b[0m Pass')
  expect(result.stderr).toContain('expected diagnostic')
  expect(result.stderr).toContain('Results: 1 passed, 1 failed, 1 skipped\n')
  expect(result.stderr).not.toMatch(/^-{3,}|^Ran \d+ tests|^OK$/m)
  expect(result.status).toBe(1)
})

it.each([0, 7])('totals completed suites across both streams and preserves exit %i', (status) => {
  const source = [
    'process.stdout.write("Results: 2 passed, 0 failed, 1 skipped\\n")',
    'process.stderr.write("Results: 4 passed, 1 failed, 2 skipped\\n")',
    // Similar-looking diagnostics and result rows must not be double counted.
    'process.stdout.write("  ✓ A test\\nNot Results: 99 passed, 0 failed, 0 skipped\\n")',
    `process.exitCode = ${status}`
  ].join(';')
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--total', process.execPath, '-e', source], {
    encoding: 'utf8', timeout: 5_000
  })
  expect(result.stdout).toContain('Grand total: 7 run, 6 passed, 1 failed, 3 skipped\n')
  expect(result.stdout.match(/Grand total:/g)).toHaveLength(1)
  expect(result.stderr.includes('completed suites only')).toBe(status !== 0)
  expect(result.status).toBe(status)
})
