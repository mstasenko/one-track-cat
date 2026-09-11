import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { e2eEnvironment } from './e2e/environment'

describe('e2eEnvironment', () => {
  let inheritedCpuOnly: string | undefined

  beforeEach(() => {
    inheritedCpuOnly = process.env.otc_CPU_ONLY
  })

  afterEach(() => {
    if (inheritedCpuOnly === undefined) delete process.env.otc_CPU_ONLY
    else process.env.otc_CPU_ONLY = inheritedCpuOnly
  })

  it('defaults to CPU-only when the inherited flag is unset', () => {
    delete process.env.otc_CPU_ONLY
    expect(e2eEnvironment().otc_CPU_ONLY).toBe('1')
  })

  it('overrides an inherited GPU-enabled value', () => {
    process.env.otc_CPU_ONLY = '0'
    expect(e2eEnvironment().otc_CPU_ONLY).toBe('1')
  })

  it('preserves an explicit per-test override', () => {
    process.env.otc_CPU_ONLY = '1'
    expect(e2eEnvironment({ otc_CPU_ONLY: '0' }).otc_CPU_ONLY).toBe('0')
  })
})
