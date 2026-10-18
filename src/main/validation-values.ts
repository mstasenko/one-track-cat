export type UnknownRecord = Record<string, unknown>

export function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as UnknownRecord
}

export function text(value: unknown, label: string, maximumLength = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

export function identifier(value: unknown, label: string): string {
  const id = text(value, label, 128)
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${label} contains unsafe characters`)
  return id
}

export function number(value: unknown, label: string, minimum = 0, maximum = 1e9): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its allowed range`)
  }
  return value
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

export function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label} is not supported`)
  return value as T
}

export function validateUniqueIds(items: readonly { id: string }[], label: string): void {
  const ids = new Set(items.map((item) => item.id))
  if (ids.size !== items.length) throw new Error(`${label} IDs must be unique`)
}
