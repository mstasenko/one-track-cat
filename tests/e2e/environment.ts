export function e2eEnvironment(overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  const environment = {
    ...process.env,
    XDG_SESSION_TYPE: 'wayland',
    // Hardware must be an explicit per-test opt-in; inherited values are unsafe defaults.
    otc_CPU_ONLY: '1',
    ...overrides
  }
  return Object.fromEntries(Object.entries(environment))
}
