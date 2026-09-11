import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'

const projectRoot = resolve(import.meta.dirname, '..')
const defaultRoot = join(projectRoot, 'dist', 'face-pack')
const defaultArchive = join(projectRoot, 'release', 'otc-face-pack.zip')
const retinafaceLicenseSha256 = '41034e3430e3b7fd63031bcc6f9dd9740fa910328f3168208ca032807f026147'
const sourceRevision = 'b984b4b775b2c4dced95c1eadd195a5c7d32a60b'
const modelYmlUrl = 'https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/6697dead54ed1cdd664b0313189c2cb52ee6335e/models/public/retinaface-resnet50-pytorch/model.yml'
const modelYmlSha256 = '8c9ec044f315921c57f757f9fa028dd64190b7191d2770f5e72d9c4c20efe2b9'
const weightsUrl = 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/retinaface-resnet50-pytorch/Resnet50_Final.pth'
const weightsSha384 = '80453e582f22ff7786b1392fb0ffb54e0e220ffb71a1381ca05de77673b0da3afeae70540076776a448b0972976c7a3c'
const licenseUrl = `https://raw.githubusercontent.com/biubug6/Pytorch_Retinaface/${sourceRevision}/LICENSE.MIT`
const sourceHashes = new Map([
  ['models/retinaface.py', 'def46f34640a3f597838f48a6defe1a08e2eb624251dde189cac46a3148bf9f1159bf259308fb74b0ba8a8a4f24a02e4'],
  ['models/net.py', '6d7791ce8526ddc9068552dff37023a048ef39b25c491e67ee91b0ef780ddba86d895cf88cae5ffc4a181e4849e8383a'],
  ['data/config.py', '2c139b1b41adf97f09437959fdc24490c7febfa886d4eeb017e63b8f08bda0407735e54de4c8c1ce14be12a18304cd3d']
])
const knownFixtureSpec = {
  defaultDirectory: join(projectRoot, 'dist', 'face-pack-cache', 'fixtures'),
  source: { name: 's78-35302~medium.jpg', url: 'https://images-assets.nasa.gov/image/s78-35302/s78-35302~medium.jpg', sha256: 'b6d858730ec0efe464365c14cc7fb4d85dfaa015fd3c9c8e36d06fe3cf606edd' },
  large: { name: 'large.ppm', sha256: 'f560c87a385e1cf5d51e7ef22fb975050cff835dccb8a0bfc58765709f6ce78e', width: 512, height: 512, roi: [177, 65, 275, 177], detail: 0 },
  small: { name: 'small.ppm', sha256: '8a533a36e7bb0d85564784b665b2ddc07fe90eaef526b17113013ab0b866f876', width: 1024, height: 1024, roi: [500, 500, 524, 528], detail: 1 }
}

function fail(message) { throw new Error(`Face pack verification failed: ${message}`) }
function digest(path, algorithm = 'sha256') { return createHash(algorithm).update(readFileSync(path)).digest('hex') }

function parseArgs(argv) {
  const options = { root: defaultRoot, archive: defaultArchive, quiet: false }
  const keys = { '--root': 'root', '--archive': 'archive' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') { process.stdout.write('Usage: node scripts/verify-face-pack.mjs [--root DIR] [--archive FILE] [--quiet]\n'); process.exit(0) }
    if (argument === '--quiet') options.quiet = true
    else if (keys[argument]) { if (index + 1 >= argv.length) fail(`missing value for ${argument}`); options[keys[argument]] = resolve(argv[++index]) }
    else fail(`unknown option ${argument}`)
  }
  return options
}

function verifyFiles(root, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length < 8) fail('manifest files list is incomplete')
  for (const file of manifest.files) {
    if (!file.path || file.path.startsWith('/') || file.path.split('/').includes('..')) fail(`unsafe file path ${file.path}`)
    const path = join(root, file.path)
    if (!existsSync(path) || !statSync(path).isFile()) fail(`missing ${file.path}`)
    if (digest(path) !== file.sha256 || statSync(path).size !== file.bytes) fail(`hash or size mismatch for ${file.path}`)
  }
  const launcher = join(root, 'otc-face-blur'); const binary = join(root, 'otc-face-blur.bin')
  if ((statSync(launcher).mode & 0o111) === 0) fail('launcher is not executable')
  if (readFileSync(binary).subarray(0, 4).toString('ascii') !== '\u007fELF') fail('native helper is not an ELF executable')
}

function verifyManifest(root) {
  const manifestPath = join(root, 'manifest.json'); if (!existsSync(manifestPath)) fail('manifest.json is missing')
  let manifest; try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { fail('manifest.json is not valid JSON') }
  if (manifest.format !== 1 || manifest.model !== 'retinaface-resnet50' || manifest.modelZooName !== 'retinaface-resnet50-pytorch') fail('unsupported manifest model')
  if (manifest.protocol?.stdin !== 'RGB24' || manifest.protocol?.stdout !== 'RGB24' || manifest.protocol?.maxInFlightRequests !== 1) fail('raw-frame protocol is incorrect')
  if (manifest.protocol?.maxHoldSeconds !== 1 || manifest.protocol?.maxEffectRows !== 100 || manifest.protocol?.maxFps !== 1000) fail('protocol bounds are incorrect')
  if (manifest.runtime?.name !== 'OpenVINO Runtime' || manifest.runtime?.version !== '2025.3.0') fail('runtime pin is incorrect')
  if (!Array.isArray(manifest.runtime.libraries) || manifest.runtime.libraries.some((name) => /npu|auto|hetero|onnx|paddle|tensorflow/i.test(name))) fail('unsupported runtime plugin is bundled')
  if (!manifest.runtime.libraries.some((name) => name.startsWith('libopenvino_intel_cpu_plugin.so'))) fail('CPU runtime plugin is missing')
  if (!manifest.runtime.libraries.some((name) => name.startsWith('libopenvino_intel_gpu_plugin.so'))) fail('Intel GPU runtime plugin is missing')
  if (manifest.conversion?.python?.python !== '3.11' || manifest.conversion?.device !== 'CPU' || manifest.conversion?.threads !== 4 || manifest.conversion?.pretrained !== false) fail('conversion provenance is incorrect')
  const provenance = manifest.provenance
  if (provenance?.sourceRevision !== sourceRevision || provenance.modelYml !== modelYmlUrl || provenance.modelYmlSha256 !== modelYmlSha256) fail('model source pin is incorrect')
  if (provenance.weightsUrl !== weightsUrl || provenance.weightsSha384 !== weightsSha384 || provenance.weightsSize !== 109497761) fail('model weight pin is incorrect')
  if (provenance?.license?.spdx !== 'MIT' || provenance.license.url !== licenseUrl || provenance.license.sha256 !== retinafaceLicenseSha256) fail('MIT model license provenance is missing')
  if (JSON.stringify(provenance.input?.shape) !== JSON.stringify([1, 3, 640, 640]) || provenance.input.layout !== 'NCHW' || provenance.input.order !== 'BGR' || JSON.stringify(provenance.input.mean) !== JSON.stringify([104, 117, 123])) fail('model input preprocessing is incorrect')
  if (JSON.stringify(provenance.outputs) !== JSON.stringify(['face_rpn_bbox_pred', 'face_rpn_cls_prob', 'face_rpn_landmark_pred'])) fail('RetinaFace output specification is incorrect')
  if (manifest.verification?.entrypoint !== 'otc-face-blur-smoke' || manifest.verification?.device !== 'CPU') fail('native CPU smoke provenance is missing')
  if (manifest.verification?.status !== undefined && manifest.verification.status !== 'fixture-not-supplied') fail('native smoke verification status is invalid')
  if (!Array.isArray(provenance.sources) || provenance.sources.length !== 3) fail('pinned source list is incomplete')
  for (const source of provenance.sources) if (sourceHashes.get(source.path) !== source.sha384 || !source.url.includes(sourceRevision)) fail(`source pin is incorrect for ${source.path}`)
  verifyFiles(root, manifest)
  if (digest(join(root, 'LICENSE-RETINAFACE-MIT.txt')) !== retinafaceLicenseSha256) fail('bundled RetinaFace MIT license is not the pinned source license')
  if (statSync(join(root, 'LICENSE-OPENVINO.txt')).size < 512) fail('bundled OpenVINO license is incomplete')
  if (digest(join(root, 'model.xml')) !== provenance.ir?.xmlSha256 || digest(join(root, 'model.bin')) !== provenance.ir?.binSha256) fail('IR hashes do not match provenance')
  return manifest
}

function verifyRuntimeDependencies(root) {
  const binary = join(root, 'otc-face-blur.bin')
  let output; try { output = execFileSync('ldd', [binary], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: join(root, 'lib') } }) } catch (error) { fail(`runtime dependency check failed: ${error}`) }
  if (/not found/i.test(output)) fail(`runtime dependency is missing:\n${output}`)
  return output.split('\n').filter((line) => line.trim().length > 0).length
}

function verifyArchive(archivePath, manifest) {
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) fail('release archive is missing')
  const zip = new AdmZip(archivePath); const entries = zip.getEntries(); const names = entries.map((entry) => entry.entryName)
  if (!names.includes('face-pack/manifest.json') || !names.includes('face-pack/otc-face-blur')) fail('archive does not contain required face-pack files')
  if (new Set(names).size !== names.length || entries.some((entry) => !entry.entryName.startsWith('face-pack/') || entry.entryName.includes('..') || entry.entryName.includes('\\'))) fail('archive contains duplicate or unsafe paths')
  const launcher = entries.find((entry) => entry.entryName === 'face-pack/otc-face-blur')
  const helper = entries.find((entry) => entry.entryName === 'face-pack/otc-face-blur.bin')
  const mode = launcher ? launcher.header.fileAttr & 0o777 : 0
  const helperMode = helper ? helper.header.fileAttr & 0o777 : 0
  if ((mode & 0o111) === 0 || (helperMode & 0o111) === 0) fail('archive executables do not retain executable permission')
  const archiveManifest = zip.readAsText('face-pack/manifest.json')
  if (JSON.stringify(JSON.parse(archiveManifest)) !== JSON.stringify(manifest)) fail('archive manifest differs from the verified pack')
  for (const file of manifest.files) {
    const entryName = `face-pack/${file.path}`; if (!names.includes(entryName)) fail(`archive is missing ${file.path}`)
    const entry = zip.getEntry(entryName); const data = entry.getData()
    if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) fail(`archive hash or size mismatch for ${file.path}`)
  }
  return { bytes: statSync(archivePath).size, sha256: digest(archivePath) }
}

function readPpm(path, expected) {
  const bytes = readFileSync(path)
  if (digest(path) !== expected.sha256) fail(`${expected.name} fixture checksum is incorrect`)
  let offset = 0
  const token = () => {
    while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1
    const start = offset
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset]))) offset += 1
    if (start === offset) fail(`${expected.name} fixture header is incomplete`)
    return bytes.subarray(start, offset).toString('ascii')
  }
  if (token() !== 'P6' || Number(token()) !== expected.width || Number(token()) !== expected.height || token() !== '255') fail(`${expected.name} fixture header is incorrect`)
  if (offset >= bytes.length) fail(`${expected.name} fixture has no RGB payload`)
  offset += 1
  const payload = bytes.subarray(offset)
  if (payload.length !== expected.width * expected.height * 3) fail(`${expected.name} fixture payload size is incorrect`)
  return payload
}

function fixtureDirectory() {
  const configured = process.env.otc_FACE_FIXTURE_DIR
  const candidate = configured ? resolve(configured) : knownFixtureSpec.defaultDirectory
  if (!existsSync(candidate)) return null
  const large = join(candidate, knownFixtureSpec.large.name); const small = join(candidate, knownFixtureSpec.small.name)
  if (!existsSync(large) || !existsSync(small)) {
    if (configured) fail(`known face fixture directory is incomplete: ${candidate}`)
    return null
  }
  return { directory: candidate, large, small }
}

function findBundledFfmpeg() {
  const candidates = [process.env.otc_FACE_FFMPEG, join(projectRoot, 'dist', 'ffmpeg-vaapi', 'ffmpeg'), join(projectRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg')].filter(Boolean)
  const ffmpeg = candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate))
  if (!ffmpeg) fail('known-face verification requires bundled FFmpeg (set otc_FACE_FFMPEG or run the FFmpeg build step)')
  return ffmpeg
}

async function fetchPinnedFixtureSource(path) {
  if (existsSync(path) && digest(path) === knownFixtureSpec.source.sha256) return path
  const response = await fetch(knownFixtureSpec.source.url, { headers: { 'User-Agent': 'OneTrackCat face-pack verifier' } })
  if (!response.ok) fail(`known-face source download failed: HTTP ${response.status}`)
  const temporary = `${path}.part`; mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(temporary, Buffer.from(await response.arrayBuffer()))
  try {
    if (digest(temporary) !== knownFixtureSpec.source.sha256) fail('known-face source checksum mismatch')
    renameSync(temporary, path)
  } catch (error) { rmSync(temporary, { force: true }); throw error }
  return path
}

function prepareFixture(ffmpeg, source, path, spec, filter) {
  if (existsSync(path) && digest(path) === spec.sha256) return path
  const temporary = `${path}.part.ppm`
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-hwaccel', 'none', '-i', source, '-vf', filter, '-frames:v', '1', '-f', 'image2', temporary], { stdio: 'inherit', env: { ...process.env, CUDA_VISIBLE_DEVICES: '', LIBVA_DRIVER_NAME: 'null' } })
    if (digest(temporary) !== spec.sha256) fail(`${spec.name} generated fixture checksum mismatch`)
    renameSync(temporary, path); chmodSync(path, 0o644)
  } catch (error) { rmSync(temporary, { force: true }); throw error }
  return path
}

async function ensureKnownFixtures() {
  const configured = process.env.otc_FACE_FIXTURE_DIR
  if (configured) return fixtureDirectory() ?? fail(`known face fixture directory is incomplete: ${resolve(configured)}`)
  const existing = fixtureDirectory()
  if (existing) return existing
  const directory = knownFixtureSpec.defaultDirectory; mkdirSync(directory, { recursive: true })
  const source = await fetchPinnedFixtureSource(join(directory, knownFixtureSpec.source.name))
  const ffmpeg = findBundledFfmpeg()
  const large = prepareFixture(ffmpeg, source, join(directory, knownFixtureSpec.large.name), knownFixtureSpec.large, 'crop=360:400:320:240,scale=128:128:flags=lanczos,pad=512:512:160:54:color=gray')
  const small = prepareFixture(ffmpeg, source, join(directory, knownFixtureSpec.small.name), knownFixtureSpec.small, 'crop=360:400:320:240,scale=32:32:flags=lanczos,pad=1024:1024:496:496:color=gray')
  return { directory, large, small }
}

function runKnownFixture(root, fixturePath, spec) {
  const input = readPpm(fixturePath, spec); const temporary = mkdtempSync(join(tmpdir(), 'otc-face-known-')); const effects = join(temporary, 'effects.tsv')
  writeFileSync(effects, `0\t1\t0.70\t${spec.detail}\t0.50\t1.00\t2\n`)
  const result = spawnSync(join(root, 'otc-face-blur'), ['--model', join(root, 'model.xml'), '--width', String(spec.width), '--height', String(spec.height), '--fps', '1', '--effects', effects, '--device', 'CPU'], { input, env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', LD_LIBRARY_PATH: join(root, 'lib') }, timeout: 120_000, maxBuffer: input.length + 2 * 1024 * 1024 })
  try {
    if (result.error) fail(`known ${spec.name} CPU inference could not start: ${result.error.message}`)
    if (result.status !== 0) fail(`known ${spec.name} CPU inference failed with status ${result.status}: ${String(result.stderr)}`)
    if (result.stdout.length !== input.length) fail(`known ${spec.name} CPU inference returned ${result.stdout.length} bytes, expected ${input.length}`)
    if (!String(result.stderr).includes('device=CPU')) fail(`known ${spec.name} inference did not report CPU execution`)
    const [left, top, right, bottom] = spec.roi; let changed = 0
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const index = (y * spec.width + x) * 3
      if (input[index] !== result.stdout[index] || input[index + 1] !== result.stdout[index + 1] || input[index + 2] !== result.stdout[index + 2]) changed += 1
    }
    if (changed === 0) fail(`known ${spec.name} CPU inference did not alter the expected face ROI`)
    return { name: spec.name, width: spec.width, height: spec.height, changedFacePixels: changed }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

function runKnownFaceSmoke(root, fixtures) {
  const large = runKnownFixture(root, fixtures.large, knownFixtureSpec.large); const small = runKnownFixture(root, fixtures.small, knownFixtureSpec.small)
  return { frames: 2, fixtures: [large, small] }
}

function runCpuSmoke(root) {
  const temporary = mkdtempSync(join(tmpdir(), 'otc-face-verify-'))
  const effects = join(temporary, 'effects.tsv')
  const rows = ['0\t1\t0.70\t0\t0.25\t0.70\t0', '1\t2\t0.70\t1\t0.50\t0.70\t1', '2\t3\t0.70\t0\t0.75\t0.70\t2']
  writeFileSync(effects, `${rows.join('\n')}\n`)
  const width = 64; const height = 64; const frameBytes = width * height * 3; const input = Buffer.alloc(frameBytes * 3, 0x80)
  const result = spawnSync(join(root, 'otc-face-blur'), ['--model', join(root, 'model.xml'), '--width', String(width), '--height', String(height), '--fps', '1', '--effects', effects, '--device', 'CPU'], { input, env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1', LD_LIBRARY_PATH: join(root, 'lib') }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
  try {
    if (result.error) fail(`CPU smoke could not start: ${result.error.message}`)
    if (result.status !== 0) fail(`CPU smoke failed with status ${result.status}: ${String(result.stderr)}`)
    if (result.stdout.length !== input.length) fail(`CPU smoke returned ${result.stdout.length} bytes, expected ${input.length}`)
    if (!String(result.stderr).includes('device=CPU')) fail('CPU smoke did not report CPU execution')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
  return { frames: 3, styles: ['pixelate', 'blur', 'mask'], holdSeconds: [0.25, 0.5, 0.75] }
}

const options = parseArgs(process.argv.slice(2))
const manifest = verifyManifest(options.root)
const dependencyCount = verifyRuntimeDependencies(options.root)
const archive = verifyArchive(options.archive, manifest)
const smoke = runCpuSmoke(options.root)
const knownFixtures = await ensureKnownFixtures()
const knownSmoke = runKnownFaceSmoke(options.root, knownFixtures)
if (!options.quiet) {
  process.stdout.write(`Verified ${options.root}\n`)
  process.stdout.write(`Archive SHA-256: ${archive.sha256} (${archive.bytes} bytes)\n`)
  process.stdout.write(`Runtime dependencies: ${dependencyCount} resolved by ldd; CPU execution; CPU+Intel GPU plugins shipped\n`)
  process.stdout.write(`CPU inference: ${smoke.frames} frames; styles=${smoke.styles.join(',')}; holdSeconds=${smoke.holdSeconds.join(',')}\n`)
  process.stdout.write(`Known-face CPU inference: ${knownSmoke.fixtures.map((fixture) => `${fixture.name}=${fixture.changedFacePixels} changed ROI pixels`).join(', ')}\n`)
}
