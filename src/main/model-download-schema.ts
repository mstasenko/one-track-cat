import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ModelArtifact {
  readonly name: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  readonly destination: string
}

/**
 * The small, deliberately boring manifest consumed by the first-use model
 * downloader.  Keep this separate from the runtime pack's provenance
 * manifest: this file is an input to a networked operation and is therefore
 * parsed with a much stricter schema.
 */
export interface ModelManifestArtifact {
  readonly path: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

export interface ModelManifest {
  readonly format: 1
  readonly modelId: string
  readonly artifacts: readonly ModelManifestArtifact[]
}

const MAX_DESTINATION_LENGTH = 4_096
const MAX_NAME_LENGTH = MAX_DESTINATION_LENGTH
const MAX_MODEL_ID_LENGTH = 128
const MAX_MANIFEST_PATH_LENGTH = 4_096
const MAX_MANIFEST_ARTIFACTS = 160
export interface NormalizedArtifact extends ModelArtifact {
  readonly destination: string
}

function invalidArtifact(message: string): never {
  throw new Error(`Invalid model artifact: ${message}`)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

function invalidManifest(message: string): never {
  throw new Error(`Invalid model manifest: ${message}`)
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const known = new Set(allowed)
  const unexpected = Object.keys(value).filter((key) => !known.has(key))
  if (unexpected.length > 0) invalidManifest(`${context} contains unexpected field ${unexpected[0]}`)
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_ID_LENGTH ||
      value !== value.trim() || containsControl(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    invalidManifest('modelId is invalid')
  }
  return value
}

function normalizeManifestPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MANIFEST_PATH_LENGTH ||
      value !== value.trim() || containsControl(value) || value.includes('\\') || isAbsolute(value) ||
      /^[A-Za-z]:/u.test(value)) {
    invalidManifest('artifact path is not a safe relative path')
  }
  const parts = value.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    invalidManifest('artifact path is not a safe relative path')
  }
  return value
}

function normalizeManifestUrl(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    invalidManifest(`${path} has an invalid URL`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalidManifest(`${path} has an invalid URL`)
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    invalidManifest(`${path} URL must use HTTPS`)
  }
  return value
}

function normalizeManifestBytes(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalidManifest(`${path} has an invalid byte count`)
  }
  return value
}

function normalizeManifestHash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) {
    invalidManifest(`${path} has an invalid SHA-256`)
  }
  return value.toLowerCase()
}

/** Parse and validate a first-use model manifest without touching the filesystem. */
export function parseModelManifest(value: unknown): ModelManifest {
  if (!isObject(value)) invalidManifest('manifest must be an object')
  rejectUnexpectedKeys(value, ['format', 'modelId', 'artifacts'], 'manifest')
  if (value.format !== 1) invalidManifest('unsupported format')
  const modelId = normalizeModelId(value.modelId)
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > MAX_MANIFEST_ARTIFACTS) {
    invalidManifest('artifacts must be a non-empty bounded list')
  }
  const paths = new Set<string>()
  const artifacts: ModelManifestArtifact[] = []
  let totalBytes = 0
  for (const [index, item] of value.artifacts.entries()) {
    if (!isObject(item)) invalidManifest(`artifact ${index} must be an object`)
    rejectUnexpectedKeys(item, ['path', 'url', 'bytes', 'sha256'], `artifact ${index}`)
    const path = normalizeManifestPath(item.path)
    const pathKey = path.toLocaleLowerCase('en-US')
    if (paths.has(pathKey)) invalidManifest(`duplicate artifact path ${path}`)
    paths.add(pathKey)
    const bytes = normalizeManifestBytes(item.bytes, path)
    if (totalBytes > Number.MAX_SAFE_INTEGER - bytes) invalidManifest('artifact total is too large')
    totalBytes += bytes
    artifacts.push({
      path,
      url: normalizeManifestUrl(item.url, path),
      bytes,
      sha256: normalizeManifestHash(item.sha256, path)
    })
  }
  return { format: 1, modelId, artifacts }
}

export async function readModelManifest(path: string): Promise<ModelManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid model manifest: malformed JSON', { cause: error })
    throw error
  }
  return parseModelManifest(value)
}

/** Resolve a validated manifest path below its model-id directory. */
export function modelArtifactDestination(root: string, path: string): string {
  const modelRoot = resolve(root)
  const destination = resolve(modelRoot, normalizeManifestPath(path))
  const relativePath = relative(modelRoot, destination)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    invalidManifest('artifact path escapes the model directory')
  }
  return destination
}

export function modelManifestArtifacts(manifest: ModelManifest, root: string): ModelArtifact[] {
  const normalized = parseModelManifest(manifest)
  return normalized.artifacts.map((artifact) => ({
    name: artifact.path,
    url: artifact.url,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    destination: modelArtifactDestination(root, artifact.path)
  }))
}

export function normalizeArtifact(value: unknown): NormalizedArtifact {
  if (!isObject(value)) invalidArtifact('artifact must be an object')
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH || containsControl(name)) {
    invalidArtifact('name is empty or too long')
  }
  if (typeof value.url !== 'string') invalidArtifact(`${name} has no URL`)
  let parsedUrl: URL
  try {
    parsedUrl = new URL(value.url)
  } catch {
    invalidArtifact(`${name} has an invalid URL`)
  }
  if (parsedUrl.protocol !== 'https:') invalidArtifact(`${name} URL must use HTTPS`)
  const bytes = value.bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    invalidArtifact(`${name} has an invalid byte count`)
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.sha256)) {
    invalidArtifact(`${name} has an invalid SHA-256`)
  }
  if (typeof value.destination !== 'string' || value.destination.length === 0 ||
      value.destination.length > MAX_DESTINATION_LENGTH || value.destination.includes('\u0000')) {
    invalidArtifact(`${name} has an invalid destination`)
  }
  return {
    name,
    url: value.url,
    bytes,
    sha256: value.sha256.toLowerCase(),
    destination: resolve(value.destination)
  }
}

export function normalizeArtifacts(artifacts: readonly ModelArtifact[]): NormalizedArtifact[] {
  if (!Array.isArray(artifacts)) invalidArtifact('artifact list must be an array')
  const normalized: NormalizedArtifact[] = []
  const destinations = new Set<string>()
  for (const artifact of artifacts) {
    const item = normalizeArtifact(artifact)
    if (destinations.has(item.destination)) invalidArtifact(`duplicate destination for ${item.name}`)
    destinations.add(item.destination)
    normalized.push(item)
  }
  return normalized
}
