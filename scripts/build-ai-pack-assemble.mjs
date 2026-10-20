import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { openVinoLauncher } from './openvino-launcher.mjs'
import {
  flashComplementFiles, flashStructuralFiles, matchesReleaseProvenance,
  gpuPluginPath, gpuPluginPin, modelNotice, payloadPins, releasePins, runtimeLibraryNames
} from './ai-pack-pins.mjs'

// Assembly only: native preparation and bulk model downloads happen later in
// the application's private model directory.  This command never handles
// bulk checkpoint payloads; it does include the pinned small derived assets.
const root = resolve(import.meta.dirname, '..')
const options = { out: join(root, 'dist', 'ai-pack'), archive: join(root, 'release', 'otc-ai-pack.zip') }
const keys = ['runtime', 'gpu-plugin', 'worker', 'models', 'complements', 'rife', 'licenses', 'catalog', 'provenance', 'out', 'archive']
const seen = new Set()
function fail(message) { throw new Error('AI pack build failed: ' + message) }

// Small deterministic-archive seam for the CPU contract test.  It avoids
// requiring a worker, native libraries, or model inputs just to test ZIP
// ordering and timestamps.
if (process.argv[2] === '--test-deterministic-archive') {
  if (process.argv.length !== 5) fail('usage: --test-deterministic-archive DIR ARCHIVE')
  const bytes = writeDeterministicArchive(resolve(process.argv[3]), resolve(process.argv[4]))
  console.log('deterministic archive bytes=' + bytes)
  process.exit(0)
}

for (let i = 2; i < process.argv.length; ++i) {
  const flag = process.argv[i]
  if (flag === '--help') {
    console.log('Usage: build-ai-pack-assemble.mjs --runtime DIR --gpu-plugin FILE --worker ELF --models DIR --complements DIR --rife DIR --licenses DIR --catalog JSON --provenance JSON [--out DIR] [--archive FILE]')
    console.log('FlashVSR+ structural assembly; bulk learned source files are never copied.')
    process.exit(0)
  }
  const key = flag.slice(2)
  if (!flag.startsWith('--') || !keys.includes(key) || seen.has(key) || !process.argv[i + 1]) fail('unknown/duplicate/missing option ' + flag)
  seen.add(key)
  options[key] = resolve(process.argv[++i])
}
for (const key of keys.slice(0, 9)) if (!options[key]) fail('missing --' + key)
if (process.platform !== 'linux' || process.arch !== 'x64') fail('only Linux x64 is qualified')
if (!options.out.startsWith(join(root, 'dist') + '/')) fail('--out must be a generated child of dist/')
if (existsSync(options.out) || existsSync(options.archive)) fail('output/archive exists; refusing overwrite')

function regular(path, limit = 1024 ** 3, allowEmpty = false) {
  const info = lstatSync(path)
  if (!info.isFile() || !Number.isSafeInteger(info.size) || (!allowEmpty && info.size < 1) || info.size > limit) fail('invalid regular file ' + path)
  return info
}
function hash(path) { regular(path, 2 * 1024 ** 3, true); return createHash('sha256').update(readFileSync(path)).digest('hex') }
function copy(source, destination, allowEmpty = false) {
  regular(source, 2 * 1024 ** 3, allowEmpty)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
function checkPin(path, pin, allowEmpty = false) {
  if (regular(path, 2 * 1024 ** 3, allowEmpty).size !== pin.bytes || hash(path) !== pin.sha256) fail('fixed payload pin differs: ' + path)
}
function checkGpuPlugin(path, record) {
  const actual = { bytes: regular(path, 2 * 1024 ** 3).size, sha256: hash(path) }
  if (!record || !Number.isSafeInteger(record.bytes) || !/^[a-f0-9]{64}$/.test(record.sha256) ||
      record.bytes !== actual.bytes || record.sha256 !== actual.sha256 ||
      record.sourceRevision !== releasePins.runtime.gpuSourceRevision ||
      record.patchSha256 !== releasePins.runtime.gpuPatchSha256 ||
      !['qualified-relocation', 'source'].includes(record.mode)) fail('GPU plugin provenance differs')
  if (record.mode === 'qualified-relocation' &&
      (record.bytes !== gpuPluginPin.bytes || record.sha256 !== gpuPluginPin.sha256)) {
    fail('qualified GPU plugin is not the known fast path')
  }
  return actual
}
function sortedFiles(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap((name) => {
    const path = join(directory, name)
    const relative = prefix + name
    const info = lstatSync(path)
    if (info.isSymbolicLink()) fail('symbolic link in pack output: ' + path)
    if (info.isDirectory()) return sortedFiles(path, relative + '/')
    if (!info.isFile()) fail('non-regular file in pack output: ' + path)
    regular(path, 2 * 1024 ** 3, true)
    return [{ path: relative, mode: info.mode & 0o777 }]
  })
}
function writeDeterministicArchive(directory, archive) {
  const zip = new AdmZip()
  const epoch = new Date(1980, 0, 1, 0, 0, 0)
  for (const file of sortedFiles(directory)) {
    const entry = zip.addFile('ai-pack/' + file.path, readFileSync(join(directory, file.path)), '', file.mode)
    entry.header.time = epoch
  }
  const encoded = zip.toBuffer()
  if (encoded.length >= 2 * 1024 ** 3) fail('archive exceeds 2GiB per-file limit')
  mkdirSync(dirname(archive), { recursive: true })
  writeFileSync(archive, encoded, { flag: 'wx' })
  return encoded.length
}

function safeCatalog(path) {
  regular(path, 1024 ** 2)
  const catalog = JSON.parse(readFileSync(path, 'utf8'))
  if (hash(path) !== releasePins.flash.catalogSha256 || catalog.format !== 1 || catalog.modelId !== releasePins.flash.modelId ||
      !Array.isArray(catalog.artifacts) || catalog.artifacts.length !== 6) fail('Flash source catalog differs')
  const names = new Set(catalog.artifacts.map((item) => item.path))
  const expected = new Set(['turbo/dit.safetensors', 'turbo/lq_proj_in.safetensors', 'base/dit.safetensors',
    'base/lq_proj_in.safetensors', 'shared/TCDecoder.ckpt', 'shared/posi_prompt.pth'])
  if (names.size !== expected.size || [...expected].some((name) => !names.has(name))) fail('Flash source catalog inventory differs')
  return catalog
}
const provenance = JSON.parse(readFileSync(options.provenance, 'utf8'))
if (!matchesReleaseProvenance(provenance)) fail('fixed release provenance differs')
safeCatalog(options.catalog)
checkGpuPlugin(options['gpu-plugin'], provenance.gpuPlugin)

for (const [name, pin] of Object.entries(payloadPins)) {
  const source = name.startsWith('lib/') ? join(options.runtime, name) :
    name.startsWith('rife.') ? join(options.rife, name) :
      name === 'runtime-source/reorder-cache.patch' ? join(root, 'assets/openvino/reorder-cache.patch') : join(options.licenses, name)
  checkPin(source, pin)
}
regular(options.worker, 64 * 1024 ** 2)
const env = { ...process.env, LD_LIBRARY_PATH: join(options.runtime, 'lib'), OPENVINO_LIB_PATH: join(options.runtime, 'lib') }
for (const mode of ['turbo', 'base']) {
  execFileSync(options.worker, ['--verify-models', '--mode', mode, '--models', options.models,
    '--complements', options.complements, '--structural-only'], { stdio: ['ignore', 'ignore', 'inherit'], env })
}

mkdirSync(dirname(options.out), { recursive: true })
mkdirSync(options.out, { mode: 0o755 })
copy(options.worker, join(options.out, 'otc-ai-enhance.bin'))
chmodSync(join(options.out, 'otc-ai-enhance.bin'), 0o755)
const launcher = openVinoLauncher('otc-ai-enhance.bin')
writeFileSync(join(options.out, 'otc-ai-enhance'), launcher, { mode: 0o755 })

for (const name of flashStructuralFiles) copy(join(options.models, name), join(options.out, 'flash', name), name.endsWith('.bin') && name === 'flash_text_bf16.bin')
for (const name of flashComplementFiles) copy(join(options.complements, name), join(options.out, 'flash-complements', name), name === 'empty-complement' || name === 'flash_text_bf16.bin')
copy(options.catalog, join(options.out, 'sources.json'))
copy(options.provenance, join(options.out, 'flash-provenance.json'))
checkPin(join(root, 'assets/openvino/reorder-cache.patch'), payloadPins['runtime-source/reorder-cache.patch'])
copy(join(root, 'assets/openvino/reorder-cache.patch'), join(options.out, 'runtime-source/reorder-cache.patch'))
copy(options['gpu-plugin'], join(options.out, gpuPluginPath))
for (const name of ['rife.xml', 'rife.bin']) copy(join(options.rife, name), join(options.out, name))
for (const name of Object.keys(payloadPins).filter((item) => item.startsWith('lib/'))) copy(join(options.runtime, name), join(options.out, name))
for (const name of Object.keys(payloadPins).filter((item) => item.startsWith('LICENSE-') || item.startsWith('NOTICE-'))) copy(join(options.licenses, name), join(options.out, name))
for (const name of ['LICENSE-ONE-TRACK-CAT.txt', 'LICENSE-OPENSSL.txt', 'LICENSE-OPENVINO.txt',
  'LICENSE-RIFE-MIT.txt', 'LICENSE-FLASHVSR-APACHE.txt', 'NOTICE-FLASHVSR.txt',
  'NOTICE-FLASHVSR-PROVENANCE.json']) {
  if (!existsSync(join(options.out, name))) fail('missing attribution ' + name)
}
writeFileSync(join(options.out, 'NOTICE-FLASHVSR-RIFE.txt'), modelNotice + '\n')

function inventory(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap((name) => {
    const path = join(directory, name), relative = prefix + name
    return lstatSync(path).isDirectory() ? inventory(path, relative + '/') :
      [{ path: relative, bytes: regular(path, 2 * 1024 ** 3, true).size, sha256: hash(path) }]
  })
}
const libraries = runtimeLibraryNames
const files = inventory(options.out)
writeFileSync(join(options.out, 'manifest.json'), JSON.stringify({
  format: 2,
  model: 'flashvsr-plus-rife-v4.25-v5',
  openvino: releasePins.runtime.version,
  modes: ['turbo', 'base'],
  runtime: { name: 'OpenVINO Runtime', version: releasePins.runtime.version, libraries },
  sources: { path: 'sources.json', modelId: releasePins.flash.modelId, learnedPayload: 'external' },
  structural: { directory: 'flash', complements: 'flash-complements', files: flashStructuralFiles, complementFiles: flashComplementFiles },
  prepared: { learnedPayloads: 'external', nativePreparation: '--prepare-models --mode turbo|base', files: 0, sourceBytes: 0 },
  provenance,
  files
}, null, 2) + '\n')

const dependencies = execFileSync('ldd', [join(options.out, 'otc-ai-enhance.bin')], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: join(options.out, 'lib') } })
if (/not found/.test(dependencies)) fail('runtime dependency closure incomplete')
execFileSync(options.worker, ['--verify-runtime', join(options.out, gpuPluginPath)], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, LD_LIBRARY_PATH: join(options.out, 'lib'), OPENVINO_LIB_PATH: join(options.out, 'lib') }
})
for (const mode of ['turbo', 'base']) {
  execFileSync(join(options.out, 'otc-ai-enhance'), ['--verify-models', '--mode', mode,
    '--models', join(options.out, 'flash'), '--complements', join(options.out, 'flash-complements'),
    '--structural-only'], { stdio: ['ignore', 'ignore', 'inherit'], env })
}

const archiveBytes = writeDeterministicArchive(options.out, options.archive)
console.log('Built FlashVSR+ native AI pack without bulk checkpoint payload: ' + archiveBytes + ' bytes')
