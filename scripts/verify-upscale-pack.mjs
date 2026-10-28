import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import {
  flashComplementFiles, flashStructuralFiles, gpuPluginPath, gpuPluginPin, matchesReleaseProvenance,
  modelNotice, payloadPins, releasePins, runtimeLibraryNames
} from './upscale-pack-pins.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const options = { root: join(projectRoot, 'dist', 'upscale-pack'), archive: join(projectRoot, 'release', 'otc-upscale-pack.zip') }
const seen = new Set()
function fail(message) { throw new Error('Upscale pack verification failed: ' + message) }
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === '--help') { console.log('Usage: verify-upscale-pack.mjs [--root DIR] [--archive FILE]'); process.exit(0) }
  const key = process.argv[i].slice(2)
  if (!process.argv[i].startsWith('--') || !['root', 'archive'].includes(key) || seen.has(key) || !process.argv[i + 1]) fail('unknown/duplicate/missing argument')
  seen.add(key); options[key] = resolve(process.argv[++i])
}
function regular(path, limit = 1024 ** 3, allowEmpty = false) {
  const info = lstatSync(path)
  if (!info.isFile() || !Number.isSafeInteger(info.size) || (!allowEmpty && info.size < 1) || info.size > limit) fail('invalid regular file ' + path)
  return info
}
function hash(data) { return createHash('sha256').update(data).digest('hex') }
function safe(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) fail('unsafe manifest path')
}
function fileHash(path, allowEmpty = false) { regular(path, 2 * 1024 ** 3, allowEmpty); return hash(readFileSync(path)) }
function isEmptyAllowed(path) { return path === 'flash-complements/empty-complement' || path === 'flash/flash_text_bf16.bin' || path === 'flash-complements/flash_text_bf16.bin' }
function gpuPluginRecord(record, path) {
  const actual = { bytes: regular(path, 2 * 1024 ** 3).size, sha256: fileHash(path) }
  if (!record || record.bytes !== actual.bytes || record.sha256 !== actual.sha256 ||
      record.sourceRevision !== releasePins.runtime.gpuSourceRevision ||
      record.patchSha256 !== releasePins.runtime.gpuPatchSha256 ||
      !['qualified-relocation', 'source'].includes(record.mode)) fail('GPU plugin provenance differs')
  if (record.mode === 'qualified-relocation' &&
      (record.bytes !== gpuPluginPin.bytes || record.sha256 !== gpuPluginPin.sha256)) fail('qualified GPU plugin is not the known fast path')
  return actual
}
function catalogCheck(path) {
  regular(path, 1024 ** 2)
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const names = new Set(value.artifacts?.map((item) => item.path))
  if (fileHash(path) !== releasePins.flash.catalogSha256 || value.format !== 1 || value.modelId !== releasePins.flash.modelId ||
      value.artifacts?.length !== 6 || names.size !== 6 ||
      !['turbo/dit.safetensors', 'turbo/lq_proj_in.safetensors', 'base/dit.safetensors',
        'base/lq_proj_in.safetensors', 'shared/TCDecoder.ckpt', 'shared/posi_prompt.pth'].every((name) => names.has(name))) fail('Flash source catalog differs')
}

regular(join(options.root, 'manifest.json'), 1024 ** 2)
const manifest = JSON.parse(readFileSync(join(options.root, 'manifest.json'), 'utf8'))
if (manifest.format !== 2 || manifest.model !== 'flashvsr-plus-rife-v4.25-v5' ||
    manifest.openvino !== releasePins.runtime.version ||
    JSON.stringify(manifest.modes) !== JSON.stringify(['turbo', 'base']) ||
    manifest.runtime?.name !== 'OpenVINO Runtime' ||
    JSON.stringify(manifest.runtime?.libraries) !== JSON.stringify(runtimeLibraryNames) ||
    manifest.sources?.path !== 'sources.json' || manifest.sources?.modelId !== releasePins.flash.modelId ||
    manifest.sources?.learnedPayload !== 'external' ||
    manifest.prepared?.files !== 0 || manifest.prepared?.sourceBytes !== 0 ||
    manifest.prepared?.nativePreparation !== '--prepare-models --mode turbo|base') fail('unsupported pack/model/runtime')
if (JSON.stringify(manifest.structural?.files) !== JSON.stringify(flashStructuralFiles) ||
    JSON.stringify(manifest.structural?.complementFiles) !== JSON.stringify(flashComplementFiles) ||
    manifest.structural?.directory !== 'flash' || manifest.structural?.complements !== 'flash-complements') fail('structural inventory differs')
if (!Array.isArray(manifest.files) || manifest.files.length < 50) fail('incomplete file inventory')
if (!matchesReleaseProvenance(manifest.provenance)) fail('fixed release provenance differs')
catalogCheck(join(options.root, 'sources.json'))
const gpuActual = gpuPluginRecord(manifest.provenance?.gpuPlugin, join(options.root, gpuPluginPath))

const names = new Set()
for (const file of manifest.files) {
  safe(file.path)
  if (names.has(file.path)) fail('duplicate inventory path')
  names.add(file.path)
  if (/\.(pth|onnx|safetensors|ckpt)$|python|torch/i.test(file.path)) fail('learned/build-only payload leaked: ' + file.path)
  const path = join(options.root, file.path)
  const allowEmpty = isEmptyAllowed(file.path)
  if (regular(path, 2 * 1024 ** 3, allowEmpty).size !== file.bytes || !/^[a-f0-9]{64}$/.test(file.sha256) || fileHash(path, allowEmpty) !== file.sha256) fail('file hash/size mismatch ' + file.path)
}
const gpuManifestEntry = manifest.files.find((file) => file.path === gpuPluginPath)
if (!gpuManifestEntry || gpuManifestEntry.bytes !== gpuActual.bytes || gpuManifestEntry.sha256 !== gpuActual.sha256) {
  fail('GPU plugin is missing or mismatched in the manifest')
}
for (const name of ['otc-upscale', 'otc-upscale.bin', 'sources.json', 'flash-provenance.json', 'rife.xml', 'rife.bin',
  'rife_warp.cl', 'rife_warp.xml',
  'NOTICE-FLASHVSR-RIFE.txt', 'NOTICE-FLASHVSR.txt', 'NOTICE-FLASHVSR-PROVENANCE.json',
  'LICENSE-ONE-TRACK-CAT.txt', 'LICENSE-OPENSSL.txt', 'LICENSE-OPENVINO.txt',
  'LICENSE-RIFE-MIT.txt', 'LICENSE-FLASHVSR-APACHE.txt']) if (!names.has(name)) fail('required payload missing ' + name)
if ((regular(join(options.root, 'otc-upscale')).mode & 0o111) === 0 ||
    (regular(join(options.root, 'otc-upscale.bin')).mode & 0o111) === 0 ||
    readFileSync(join(options.root, 'otc-upscale.bin')).subarray(0, 4).toString() !== '\u007fELF') fail('invalid native executable')
if (readFileSync(join(options.root, 'NOTICE-FLASHVSR-RIFE.txt'), 'utf8') !== modelNotice + '\n') fail('fixed model attribution differs')
for (const [name, pin] of Object.entries(payloadPins)) {
  if (!names.has(name) || regular(join(options.root, name)).size !== pin.bytes || fileHash(join(options.root, name)) !== pin.sha256) fail('fixed payload pin differs: ' + name)
}

const env = { ...process.env, LD_LIBRARY_PATH: join(options.root, 'lib'), OPENVINO_LIB_PATH: join(options.root, 'lib') }
const dependencies = execFileSync('ldd', [join(options.root, 'otc-upscale.bin')], { encoding: 'utf8', env })
if (/not found/.test(dependencies)) fail('runtime dependency closure incomplete')
execFileSync(join(options.root, 'otc-upscale.bin'), ['--verify-runtime', join(options.root, gpuPluginPath)], {
  stdio: ['ignore', 'ignore', 'inherit'], env
})
for (const mode of ['turbo', 'base']) {
  execFileSync(join(options.root, 'otc-upscale'), ['--verify-models', '--mode', mode,
    '--models', join(options.root, 'flash'), '--complements', join(options.root, 'flash-complements'),
    '--structural-only'], { stdio: ['ignore', 'ignore', 'inherit'], env })
}

regular(options.archive, 2 * 1024 ** 3 - 1)
const zip = new AdmZip(options.archive)
const archiveNames = new Set()
for (const entry of zip.getEntries()) {
  const entryName = entry.entryName.endsWith('/') ? entry.entryName.slice(0, -1) : entry.entryName
  safe(entryName)
  if (archiveNames.has(entry.entryName) || !entry.entryName.startsWith('upscale-pack/')) fail('unsafe/duplicate archive entry')
  archiveNames.add(entry.entryName)
  const relative = entry.entryName.slice('upscale-pack/'.length)
  if (!entry.isDirectory && relative !== 'manifest.json' && !names.has(relative)) fail('unmanifested archive file')
  if (entry.isDirectory) continue
  if (entry.entryName === 'upscale-pack/manifest.json') continue
  if (entry.header.size === 0 && !isEmptyAllowed(relative)) fail('unexpected empty archive file')
}
for (const file of manifest.files) {
  const entry = zip.getEntry('upscale-pack/' + file.path)
  if (!entry || entry.header.size !== file.bytes) fail('archive size mismatch: ' + file.path)
  const bytes = entry.getData()
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('archive hash mismatch: ' + file.path)
}
if (JSON.stringify(JSON.parse(zip.readAsText('upscale-pack/manifest.json'))) !== JSON.stringify(manifest)) fail('archive manifest differs')
for (const name of ['otc-upscale', 'otc-upscale.bin']) if ((zip.getEntry('upscale-pack/' + name).header.fileAttr & 0o111) === 0) fail('archive executable permissions missing')
console.log('Verified FlashVSR+ structural/derived-asset pack; bulk learned source/BIN preparation remains an explicit application step')
