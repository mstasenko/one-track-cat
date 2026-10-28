import { app } from 'electron'
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, statfs } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { UpscaleMode, UpscalePackStatus } from '../types'
import flashSourceCatalogJson from '../../assets/flashvsr-plus/sources.json'
import {
  downloadModelManifest,
  isModelArtifactComplete,
  missingModelArtifactBytes,
  modelManifestArtifacts,
  parseModelManifest,
  type ModelArtifact,
  type ModelArtifactDownloader,
  type ModelDownloadProgress,
  type ModelManifest
} from './model-download'
import { cancelled, isAborted, normalizeFlashMode, runPackWorker, type UpscalePackWorker } from './upscale-pack-worker'
import { optionalPackDirectory } from './optional-pack'
import { ensurePrivateModelDirectory } from './model-directory'
export interface UpscalePack {
  executable: string
  models?: string
  rife: string
  /** Selected FlashVSR+ mode; optional for legacy test/injection objects. */
  mode?: UpscaleMode
}
export type { UpscalePackStatus } from '../types'
export type { UpscalePackWorker } from './upscale-pack-worker'

export interface UpscalePackOptions {
  spatial?: boolean
  mode?: UpscaleMode
  worker?: UpscalePackWorker
  directory?: string
  userDataDirectory?: string
  modelManifest?: unknown
  downloader?: ModelArtifactDownloader
}
export interface UpscaleModelDownloadOptions extends UpscalePackOptions {
  signal?: AbortSignal
  onProgress?: (progress: ModelDownloadProgress) => void
}
const modelManifestName = 'sources.json'
const flashModelId = 'flashvsr-plus'
const flashRuntimeModel = 'flashvsr-plus-rife-v4.25-v5'
const flashRuntimeOpenvino = '2026.5.0-23457-7d81aad55a5'
const flashModes = ['turbo', 'base'] as const
const missingPackMessage = 'Upscaling requires the optional OneTrackCat FlashVSR+ pack. Extract otc-upscale-pack.zip beside the AppImage. In development, place its upscale-pack folder in dist/upscale-pack.'
const invalidDownloadManifestMessage = 'The optional Upscale pack lacks a valid FlashVSR+ model source catalog.'
const legacySeedPackMessage = 'The installed Upscale pack is a legacy SeedVR pack; install the FlashVSR+ Upscale pack.'
const unsupportedPackMessage = 'Unsupported Upscale pack format; install the current OneTrackCat Upscale pack.'
const unavailableModelMessage = 'Download the Upscaling model to enable Upscaling.'
export const flashPreparedModeBytes = 3_493_228_156
export const flashPreparedSharedBytes = 94_871_238
export const flashPreparationReserveBytes = 512 * 1024 ** 2
const embeddedFlashSourceManifest = parseModelManifest(flashSourceCatalogJson)
export const flashSourceManifest: ModelManifest = Object.freeze({
  ...embeddedFlashSourceManifest,
  artifacts: Object.freeze(embeddedFlashSourceManifest.artifacts.map((artifact) => Object.freeze({ ...artifact })))
})
function assertEmbeddedFlashCatalog(manifest: ModelManifest): void {
  const expected = ['turbo/dit.safetensors', 'turbo/lq_proj_in.safetensors', 'base/dit.safetensors',
    'base/lq_proj_in.safetensors', 'shared/TCDecoder.ckpt', 'shared/posi_prompt.pth']
  const actual = manifest.artifacts.map(({ path }) => path)
  if (manifest.modelId !== flashModelId || actual.length !== expected.length || new Set(actual).size !== expected.length ||
      expected.some((path) => !actual.includes(path))) {
    throw new Error(invalidDownloadManifestMessage)
  }
}

assertEmbeddedFlashCatalog(flashSourceManifest)

interface RuntimePack {
  readonly executable: string
  readonly rife: string
  readonly mode: UpscaleMode
}

interface ActiveDownload {
  readonly controller: AbortController
  promise: Promise<void>
  readonly identity: string
}

const downloadListeners = new Set<(progress: ModelDownloadProgress) => void>()
let activeDownload: ActiveDownload | undefined

export function upscalePackDirectory(): string {
  return optionalPackDirectory('upscale')
}

export function upscaleModelDirectory(modelId: string, userDataDirectory = app.getPath('userData')): string {
  const root = resolve(userDataDirectory)
  const directory = resolve(root, modelId)
  const relativeDirectory = relative(root, directory)
  if (!relativeDirectory || relativeDirectory.startsWith('..') || resolve(relativeDirectory) === relativeDirectory) {
    throw new Error('Invalid model manifest: modelId escapes the app data directory')
  }
  return directory
}

async function readRuntimeManifest(directory: string): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as unknown
  } catch {
    throw new Error('Upscale pack runtime manifest is missing or invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(unsupportedPackMessage)
  }
  const manifest = value as Record<string, unknown>
  if (manifest.format === 1 || typeof manifest.modelId === 'string' && manifest.modelId.startsWith('seedvr')) {
    throw new Error(legacySeedPackMessage)
  }
  if (manifest.format !== 2 || manifest.model !== flashRuntimeModel ||
      manifest.openvino !== flashRuntimeOpenvino ||
      !Array.isArray(manifest.modes) || manifest.modes.length !== flashModes.length ||
      manifest.modes.some((mode, index) => mode !== flashModes[index])) {
    throw new Error(unsupportedPackMessage)
  }
}

async function inspectRuntime(directory: string, mode: UpscaleMode): Promise<RuntimePack> {
  await readRuntimeManifest(directory)
  const executable = join(directory, 'otc-upscale')
  const rife = join(directory, 'rife.xml')
  await Promise.all([
    access(executable, constants.X_OK),
    access(join(directory, 'otc-upscale.bin'), constants.X_OK),
    access(rife, constants.R_OK),
    access(join(directory, 'rife.bin'), constants.R_OK),
    access(join(directory, 'rife_warp.xml'), constants.R_OK),
    access(join(directory, 'rife_warp.cl'), constants.R_OK)
  ])
  return { executable, rife, mode }
}

function loadModelManifest(options: UpscalePackOptions): ModelManifest {
  return options.modelManifest === undefined ? flashSourceManifest : parseModelManifest(options.modelManifest)
}

function selectManifestForMode(manifest: ModelManifest, mode: UpscaleMode): ModelManifest {
  if (manifest.modelId !== flashModelId) return manifest
  const artifacts = manifest.artifacts.filter((artifact) =>
    artifact.path.startsWith(`${mode}/`) || artifact.path.startsWith('shared/'))
  if (artifacts.length !== 4) throw new Error(invalidDownloadManifestMessage)
  return { ...manifest, artifacts }
}

async function modelArtifactsComplete(manifest: ModelManifest, userDataDirectory: string, mode: UpscaleMode): Promise<{
  root: string
  artifacts: ModelArtifact[]
  missingBytes: number
}> {
  const selected = selectManifestForMode(manifest, mode)
  const root = join(upscaleModelDirectory(selected.modelId, userDataDirectory), 'sources')
  const artifacts = modelManifestArtifacts(selected, root)
  const missingBytes = await missingModelArtifactBytes(artifacts)
  return { root, artifacts, missingBytes }
}

const modePreparedNames = (mode: UpscaleMode): string[] => [
  ...([
    ['flash_pre_4096_bf16', 30], ['flash_post_4096_bf16_state', 30], ['flash_cross_kv_bf16', 30]
  ] as const).flatMap(([prefix, count]) =>
    Array.from({ length: count }, (_, index) => `${prefix}_${mode}_layer${String(index).padStart(2, '0')}.bin`)),
  ...['startup', 'prefix', 'suffix'].map((stage) => `flash_lq_projection_bf16_${mode}_${stage}.bin`),
  `flash_edges_prefix_bf16_${mode}.bin`, `flash_edges_suffix_bf16_${mode}.bin`, `flash_text_bf16_${mode}.bin`
]

const commonPreparedNames = [
  'flash_decoder_front_bf16.bin', 'flash_decoder_grow_memory_bf16.bin', 'flash_decoder_remote_frame_child_bf16.bin',
  'flash_prompt_bf16.bin'
]

const fixedStructuralNames = [
  'flash_pre_4096_bf16.xml', 'flash_pre_4096_bf16.bin', 'flash_post_4096_bf16.xml', 'flash_post_4096_bf16.bin',
  'flash_cross_kv_bf16.xml', 'flash_cross_kv_bf16.bin',
  'flash_lq_projection_startup_bf16.xml', 'flash_lq_projection_startup_bf16.bin', 'flash_lq_projection_stage1_bf16.xml',
  'flash_lq_projection_stage1_bf16.bin', 'flash_lq_projection_stage2_bf16.xml', 'flash_lq_projection_stage2_bf16.bin',
  'flash_edges_prefix_bf16.xml', 'flash_edges_prefix_bf16.bin', 'flash_edges_suffix_bf16.xml', 'flash_edges_suffix_bf16.bin',
  'flash_text_bf16.xml', 'flash_text_bf16.bin', 'flash_decoder_phased_front_bf16.xml', 'flash_decoder_phased_front_bf16.bin',
  'flash_decoder_phased_grow_memory_bf16.xml', 'flash_decoder_phased_grow_memory_bf16.bin',
  'flash_decoder_phased_remote_frame_child_bf16.xml', 'flash_decoder_phased_remote_frame_child_bf16.bin',
  'plus_split_key.xml', 'plus_split_key_dg2.xml', 'bf16_cross_bridge_custom_layers.xml', 'bf16_cross_bridge_20261017.cl',
  'plus_sparse_xmx.cl', 'flash_fixed_conditioning_bf16_turbo.bin', 'flash_fixed_conditioning_bf16_base.bin'
]

export function flashPreparedFileNames(mode: UpscaleMode): readonly string[] {
  return [...modePreparedNames(normalizeFlashMode(mode)), ...commonPreparedNames]
}

export function flashStructuralFileNames(): readonly string[] {
  return [...fixedStructuralNames]
}

let verifiedPrepared: { root: string; identity: string } | undefined

async function privateModelDirectory(directory: string): Promise<void> {
  await ensurePrivateModelDirectory(directory, 'The AI model directory must be private, owned, and not a symlink')
}

const occupiedPreparedMessage = 'An interrupted or invalid AI installation occupies models. Preserve it and remove it manually before retrying.'

async function preparedLearnedFilesComplete(directory: string, mode: UpscaleMode): Promise<boolean> {
  for (const name of flashPreparedFileNames(mode)) {
    try {
      const info = await lstat(join(directory, name), { bigint: true })
      if (!info.isFile() || (process.getuid && info.uid !== BigInt(process.getuid()))) return false
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }
  return true
}

async function refreshStructuralFiles(prepared: string, structural: string, signal: AbortSignal): Promise<void> {
  const structuralInfo = await lstat(structural, { bigint: true })
  if (!structuralInfo.isDirectory()) throw new Error('The Upscale pack structural directory must be a regular directory')
  const stage = await mkdtemp(join(dirname(prepared), '.flash-structural-'))
  try {
    await chmod(stage, 0o700)
    for (const name of fixedStructuralNames) {
      if (isAborted(signal)) throw cancelled()
      const source = join(structural, name)
      const sourceInfo = await lstat(source, { bigint: true })
      if (!sourceInfo.isFile()) {
        throw new Error(`The Upscale pack structural file is not a safe regular file: ${name}`)
      }
      const destination = join(prepared, name)
      let destinationMode = Number(sourceInfo.mode & 0o777n)
      try {
        const destinationInfo = await lstat(destination, { bigint: true })
        if (!destinationInfo.isFile() || (process.getuid && destinationInfo.uid !== BigInt(process.getuid()))) {
          throw new Error(`The prepared structural file is not a safe regular file: ${name}`)
        }
        destinationMode = Number(destinationInfo.mode & 0o777n)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const staged = join(stage, name)
      await copyFile(source, staged, constants.COPYFILE_EXCL)
      await chmod(staged, destinationMode)
    }
    for (const name of fixedStructuralNames) {
      if (isAborted(signal)) throw cancelled()
      const destination = join(prepared, name)
      try {
        const destinationInfo = await lstat(destination, { bigint: true })
        if (!destinationInfo.isFile() || (process.getuid && destinationInfo.uid !== BigInt(process.getuid()))) {
          throw new Error(`The prepared structural file is not a safe regular file: ${name}`)
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      await rename(join(stage, name), destination)
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function requireModelSpace(directory: string, missingSourceBytes: number, signal: AbortSignal): Promise<void> {
  if (isAborted(signal)) throw cancelled()
  const required = BigInt(missingSourceBytes) + BigInt(flashPreparedModeBytes) +
    BigInt(flashPreparedSharedBytes) + BigInt(flashPreparationReserveBytes)
  const disk = await statfs(directory, { bigint: true })
  if (isAborted(signal)) throw cancelled()
  if (disk.bavail * disk.bsize < required) {
    const gib = (required + 1024n ** 3n - 1n) / (1024n ** 3n)
    throw new Error(`Not enough free disk space to prepare the Upscaling model. Ensure at least ${gib} GiB is free and try again. Existing model files were preserved.`)
  }
}

async function preparedIdentity(directory: string, runtime: RuntimePack, mode: UpscaleMode): Promise<string | undefined> {
  try {
    const root = await lstat(directory, { bigint: true })
    if (!root.isDirectory() || (root.mode & 0o077n) !== 0n ||
        (process.getuid && root.uid !== BigInt(process.getuid()))) return undefined
    // A system-installed pack may be root-owned; only the private model
    // cache must belong to this user. Native verification authenticates it.
    const runtimeFiles = [runtime.executable, join(dirname(runtime.executable), 'otc-upscale.bin')]
    const files = [
      ...runtimeFiles,
      ...flashPreparedFileNames(mode).map((name) => join(directory, name)),
      ...fixedStructuralNames.map((name) => join(directory, name))
    ]
    const identities = []
    for (const path of files) {
      const info = await lstat(path, { bigint: true })
      if (!info.isFile() || (!runtimeFiles.includes(path) && process.getuid && info.uid !== BigInt(process.getuid()))) return undefined
      identities.push([path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String))
    }
    return JSON.stringify([String(root.dev), String(root.ino), identities])
  } catch { return undefined }
}

async function preparedComplete(directory: string, runtime: RuntimePack, options: UpscalePackOptions,
  mode: UpscaleMode,
  signal = new AbortController().signal, onProgress?: (progress: ModelDownloadProgress) => void): Promise<boolean> {
  if (isAborted(signal)) throw cancelled()
  const before = await preparedIdentity(directory, runtime, mode)
  if (isAborted(signal)) throw cancelled()
  if (!before) return false
  if (verifiedPrepared?.root === directory && verifiedPrepared.identity === before) return true
  try {
    await (options.worker ?? runPackWorker)(runtime.executable, ['--verify-models', '--mode', mode, '--models', directory], signal, onProgress)
  } catch (error) {
    if (isAborted(signal) || error instanceof Error && error.name === 'AbortError') throw error
    return false
  }
  const after = await preparedIdentity(directory, runtime, mode)
  if (isAborted(signal)) throw cancelled()
  if (after !== before) return false
  verifiedPrepared = { root: directory, identity: before }
  return true
}

function publicStatusUnavailable(message: string): UpscalePackStatus {
  return { available: false, message }
}

export async function requireUpscalePack(options: UpscalePackOptions = {}): Promise<UpscalePack> {
  const directory = options.directory ?? upscalePackDirectory()
  const mode = normalizeFlashMode(options.mode)
  try {
    const runtime = await inspectRuntime(directory, mode)
    if (options.spatial === false) return runtime
    const manifest = loadModelManifest(options)
    const root = join(upscaleModelDirectory(manifest.modelId, options.userDataDirectory), 'models', mode)
    if (activeDownload || !await preparedComplete(root, runtime, options, mode)) throw new Error('The Upscaling model is not prepared')
    return { ...runtime, models: root, mode }
  } catch (error) {
    if (error instanceof Error && error.message === legacySeedPackMessage) throw error
    throw new Error(missingPackMessage, { cause: error })
  }
}

export function requireRuntimeUpscalePack(options: UpscalePackOptions = {}): Promise<UpscalePack> {
  return requireUpscalePack({ ...options, spatial: false })
}

export async function upscalePackStatus(options: UpscalePackOptions = {}): Promise<UpscalePackStatus> {
  const directory = options.directory ?? upscalePackDirectory()
  let mode: UpscaleMode
  try { mode = normalizeFlashMode(options.mode) } catch (error) {
    return publicStatusUnavailable(error instanceof Error ? error.message : 'Invalid FlashVSR+ mode')
  }
  try {
    const runtime = await inspectRuntime(directory, mode)
    if (options.spatial === false) return { available: true, message: '' }
    const manifest = loadModelManifest(options)
    const data = options.userDataDirectory ?? app.getPath('userData')
    const prepared = join(upscaleModelDirectory(manifest.modelId, data), 'models', mode)
    if (!activeDownload && await preparedComplete(prepared, runtime, options, mode)) return { available: true, message: '' }
    const installed = await modelArtifactsComplete(manifest, data, mode)
    return {
      available: false, downloadable: true, downloadBytes: installed.missingBytes,
      message: installed.missingBytes > 0 ? unavailableModelMessage : 'Prepare the downloaded Upscaling model to enable Upscaling.'
    }
  } catch (error) {
    return publicStatusUnavailable(error instanceof Error &&
      (error.message === legacySeedPackMessage || error.message === unsupportedPackMessage ||
       error.message === invalidDownloadManifestMessage)
      ? error.message : missingPackMessage)
  }
}

export async function downloadUpscaleModel(options: UpscaleModelDownloadOptions = {}): Promise<void> {
  const directory = options.directory ?? upscalePackDirectory()
  const mode = normalizeFlashMode(options.mode)
  const runtime = await inspectRuntime(directory, mode)
  if (options.spatial === false) return
  const manifest = selectManifestForMode(loadModelManifest(options), mode)
  const root = upscaleModelDirectory(manifest.modelId, options.userDataDirectory)
  const sources = join(root, 'sources')
  const modelsRoot = join(root, 'models')
  const prepared = join(modelsRoot, mode)
  const signal = options.signal ?? new AbortController().signal
  const worker = options.worker ?? runPackWorker
  if (await preparedComplete(prepared, runtime, options, mode, signal, options.onProgress)) return
  await privateModelDirectory(root)
  await privateModelDirectory(modelsRoot)
  const structural = join(directory, 'flash')
  const complements = join(directory, 'flash-complements')
  await worker(runtime.executable, ['--verify-models', '--mode', mode, '--models', structural, '--complements', complements, '--structural-only'], signal, options.onProgress)
  let preparedExists = false
  try {
    const info = await lstat(prepared, { bigint: true })
    if (!info.isDirectory()) throw new Error(occupiedPreparedMessage)
    preparedExists = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (preparedExists) {
    await privateModelDirectory(prepared)
    if (!await preparedLearnedFilesComplete(prepared, mode)) throw new Error(occupiedPreparedMessage)
    await refreshStructuralFiles(prepared, structural, signal)
    verifiedPrepared = undefined
    if (!await preparedComplete(prepared, runtime, options, mode, signal, options.onProgress)) {
      throw new Error('The prepared AI model did not pass verification')
    }
    return
  }
  await privateModelDirectory(sources)
  const installed = await modelArtifactsComplete(manifest, options.userDataDirectory ?? app.getPath('userData'), mode)
  await requireModelSpace(root, installed.missingBytes, signal)
  if (isAborted(signal)) throw cancelled()
  await downloadModelManifest(manifest, sources, signal, options.onProgress, options.downloader)
  for (const artifact of modelManifestArtifacts(manifest, sources)) {
    if (!await isModelArtifactComplete(artifact, signal)) throw new Error('The downloaded AI model did not pass verification')
  }
  if (isAborted(signal)) throw cancelled()
  await requireModelSpace(root, 0, signal)
  if (isAborted(signal)) throw cancelled()
  await mkdir(prepared, { mode: 0o700 })
  await privateModelDirectory(prepared)
  const owned = await lstat(prepared, { bigint: true })
  let complete = false
  try {
    await refreshStructuralFiles(prepared, structural, signal)
    await worker(runtime.executable, ['--prepare-models', '--mode', mode, '--sources', sources, '--complements', complements, '--models', prepared], signal, options.onProgress)
    const ready = await preparedComplete(prepared, runtime, options, mode, signal, options.onProgress)
    if (isAborted(signal)) throw cancelled()
    if (!ready) {
      throw new Error('The prepared AI model did not pass verification')
    }
    complete = true
  } finally {
    if (!complete) {
      verifiedPrepared = undefined
      const now = await lstat(prepared, { bigint: true }).catch(() => undefined)
      if (now?.isDirectory() && now.dev === owned.dev && now.ino === owned.ino)
        await rm(prepared, { recursive: true })
    }
  }
}

export function subscribeUpscaleModelDownload(callback: (progress: ModelDownloadProgress) => void): () => void {
  downloadListeners.add(callback)
  return () => downloadListeners.delete(callback)
}

export function startUpscaleModelDownload(options: UpscaleModelDownloadOptions = {}): Promise<void> {
  const directory = resolve(options.directory ?? upscalePackDirectory())
  const userDataDirectory = resolve(options.userDataDirectory ?? app.getPath('userData'))
  const mode = normalizeFlashMode(options.mode)
  const identity = JSON.stringify({ directory, userDataDirectory, mode })
  if (activeDownload) {
    if (activeDownload.identity !== identity) {
      throw new Error('Another AI model download is already active for a different directory, user-data directory, or mode')
    }
    return activeDownload.promise
  }
  const controller = new AbortController()
  const record: ActiveDownload = { controller, promise: Promise.resolve(), identity }
  const onProgress = (progress: ModelDownloadProgress): void => {
    options.onProgress?.(progress)
    for (const listener of downloadListeners) {
      try { listener(progress) } catch { /* renderer subscribers are isolated */ }
    }
  }
  record.promise = downloadUpscaleModel({ ...options, directory, userDataDirectory, mode, signal: controller.signal, onProgress }).finally(() => {
    if (activeDownload === record) activeDownload = undefined
  })
  activeDownload = record
  return record.promise
}

export function cancelUpscaleModelDownload(): boolean {
  if (!activeDownload) return false
  activeDownload.controller.abort()
  return true
}

export async function shutdownUpscaleModelDownload(): Promise<void> {
  const active = activeDownload
  if (!active) return
  active.controller.abort()
  try { await active.promise } catch { /* cancellation is expected during app shutdown */ }
}

export const startModelDownload = startUpscaleModelDownload
export const cancelModelDownload = cancelUpscaleModelDownload
export const subscribeModelDownload = subscribeUpscaleModelDownload

export { modelManifestName }
