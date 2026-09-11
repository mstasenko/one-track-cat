import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import AdmZip from 'adm-zip'

const projectRoot = resolve(import.meta.dirname, '..')
const distRoot = join(projectRoot, 'dist')
const releaseRoot = join(projectRoot, 'release')
const nativeRoot = join(projectRoot, 'native', 'face-blur')
const runtimeSpec = {
  version: '2025.3.0', releaseDate: '2025-09-03',
  archive: 'openvino_toolkit_ubuntu22_2025.3.0.19807.44526285f24_x86_64.tgz',
  url: 'https://storage.openvinotoolkit.org/repositories/openvino/packages/2025.3/linux/openvino_toolkit_ubuntu22_2025.3.0.19807.44526285f24_x86_64.tgz',
  sha256: 'd701a115d3dc18088ff75b5b8e67a51fbf780022a3d40ee8ee7f2adfbd9915e6'
}
const modelSpec = {
  name: 'retinaface-resnet50-pytorch',
  modelYml: 'https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/6697dead54ed1cdd664b0313189c2cb52ee6335e/models/public/retinaface-resnet50-pytorch/model.yml',
  modelYmlSha256: '8c9ec044f315921c57f757f9fa028dd64190b7191d2770f5e72d9c4c20efe2b9',
  sourceRevision: 'b984b4b775b2c4dced95c1eadd195a5c7d32a60b',
  weightsUrl: 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/retinaface-resnet50-pytorch/Resnet50_Final.pth',
  weightsSha384: '80453e582f22ff7786b1392fb0ffb54e0e220ffb71a1381ca05de77673b0da3afeae70540076776a448b0972976c7a3c',
  weightsSize: 109497761,
  licenseUrl: 'https://raw.githubusercontent.com/biubug6/Pytorch_Retinaface/b984b4b775b2c4dced95c1eadd195a5c7d32a60b/LICENSE.MIT',
  licenseSha256: '41034e3430e3b7fd63031bcc6f9dd9740fa910328f3168208ca032807f026147',
  sources: [
    { path: 'models/retinaface.py', url: 'https://raw.githubusercontent.com/biubug6/Pytorch_Retinaface/b984b4b775b2c4dced95c1eadd195a5c7d32a60b/models/retinaface.py', sha384: 'def46f34640a3f597838f48a6defe1a08e2eb624251dde189cac46a3148bf9f1159bf259308fb74b0ba8a8a4f24a02e4', size: 4865 },
    { path: 'models/net.py', url: 'https://raw.githubusercontent.com/biubug6/Pytorch_Retinaface/b984b4b775b2c4dced95c1eadd195a5c7d32a60b/models/net.py', sha384: '6d7791ce8526ddc9068552dff37023a048ef39b25c491e67ee91b0ef780ddba86d895cf88cae5ffc4a181e4849e8383a', size: 4598 },
    { path: 'data/config.py', url: 'https://raw.githubusercontent.com/biubug6/Pytorch_Retinaface/b984b4b775b2c4dced95c1eadd195a5c7d32a60b/data/config.py', sha384: '2c139b1b41adf97f09437959fdc24490c7febfa886d4eeb017e63b8f08bda0407735e54de4c8c1ce14be12a18304cd3d', size: 928 }
  ]
}
const conversionSpec = { python: '3.11', openvino: '2024.6.0', torch: '2.3.1+cpu', torchvision: '0.18.1+cpu', onnx: '1.16.1', numpy: '1.26.4', scipy: '1.13.1' }
const knownFixtureSpec = {
  defaultDirectory: join(distRoot, 'face-pack-cache', 'fixtures'),
  large: { name: 'large.ppm', sha256: 'f560c87a385e1cf5d51e7ef22fb975050cff835dccb8a0bfc58765709f6ce78e' },
  small: { name: 'small.ppm', sha256: '8a533a36e7bb0d85564784b665b2ddc07fe90eaef526b17113013ab0b866f876' }
}

function fail(message) { throw new Error(`Face pack build failed: ${message}`) }

function parseArgs(argv) {
  const options = { archive: join(releaseRoot, 'otc-face-pack.zip'), cache: join(distRoot, 'face-pack-cache'), modelDir: null, output: join(distRoot, 'face-pack'), runtime: process.env.otc_FACE_RUNTIME_DIR ?? null, quiet: false, dryRun: false }
  const keys = { '--archive': 'archive', '--cache': 'cache', '--model-dir': 'modelDir', '--out': 'output', '--runtime': 'runtime' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      process.stdout.write('Usage: node scripts/build-face-pack.mjs [--model-dir DIR] [--runtime DIR] [--cache DIR] [--out DIR] [--archive FILE]\n')
      process.stdout.write('Build-only conversion uses a local Python 3.11 venv and pinned CPU packages.\n'); process.exit(0)
    }
    if (argument === '--quiet') options.quiet = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (keys[argument]) { if (index + 1 >= argv.length) fail(`missing value for ${argument}`); options[keys[argument]] = resolve(argv[++index]) }
    else fail(`unknown option ${argument}`)
  }
  if (!options.modelDir) options.modelDir = join(options.cache, 'model-ir')
  if (!options.dryRun) {
    const distPrefix = `${resolve(distRoot)}${process.platform === 'win32' ? '\\' : '/'}`
    if (!resolve(options.output).startsWith(distPrefix)) fail('--out must be a generated child of dist/')
    if (!resolve(options.cache).startsWith(distPrefix)) fail('--cache must be a generated child of dist/')
  }
  return options
}

function digest(path, algorithm = 'sha256') { return createHash(algorithm).update(readFileSync(path)).digest('hex') }

function assertPinned(path, expectedHash, algorithm, expectedSize) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`missing pinned input ${path}`)
  if (expectedSize !== undefined && statSync(path).size !== expectedSize) fail(`size mismatch for ${path}`)
  if (digest(path, algorithm) !== expectedHash) fail(`checksum mismatch for ${path}`)
}

function ensureReleaseDelay() {
  const release = Date.parse(`${runtimeSpec.releaseDate}T00:00:00Z`)
  if (!Number.isFinite(release) || Date.now() - release < 7 * 24 * 60 * 60 * 1000) fail(`pinned OpenVINO ${runtimeSpec.version} has not passed the seven-day release delay`)
}

async function fetchPinned(url, destination, expectedHash, algorithm = 'sha256', expectedSize) {
  if (existsSync(destination)) { try { assertPinned(destination, expectedHash, algorithm, expectedSize); return destination } catch { /* replace a partial cache entry */ } }
  mkdirSync(dirname(destination), { recursive: true })
  const response = await fetch(url, { headers: { 'User-Agent': 'OneTrackCat face pack builder' } })
  if (!response.ok) fail(`download failed for ${url}: HTTP ${response.status}`)
  const temporary = `${destination}.part`; writeFileSync(temporary, Buffer.from(await response.arrayBuffer()))
  try { assertPinned(temporary, expectedHash, algorithm, expectedSize) } catch (error) { rmSync(temporary, { force: true }); throw error }
  renameSync(temporary, destination); return destination
}

function copyPinned(source, destination, expectedHash, algorithm, expectedSize) {
  assertPinned(source, expectedHash, algorithm, expectedSize); mkdirSync(dirname(destination), { recursive: true })
  if (!existsSync(destination) || digest(destination, algorithm) !== expectedHash) copyFileSync(source, destination)
  assertPinned(destination, expectedHash, algorithm, expectedSize); return destination
}

function runtimeRootFromPath(path) {
  const resolved = resolve(path)
  if (existsSync(join(resolved, 'runtime', 'cmake'))) return resolved
  for (const entry of readdirSync(resolved, { withFileTypes: true })) if (entry.isDirectory() && existsSync(join(resolved, entry.name, 'runtime', 'cmake'))) return join(resolved, entry.name)
  fail(`OpenVINO runtime directory ${resolved} does not contain runtime/cmake`)
}

function unpackRuntime(archive, cache) {
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  const top = listing.split('\n').find((entry) => entry && !entry.startsWith('./'))?.split('/')[0]
  if (!top) fail('could not determine the OpenVINO archive top folder')
  const target = join(cache, top); if (!existsSync(join(target, 'runtime', 'cmake'))) execFileSync('tar', ['-xzf', archive, '-C', cache])
  return runtimeRootFromPath(target)
}

async function obtainRuntime(options) {
  ensureReleaseDelay()
  if (options.runtime) {
    const root = runtimeRootFromPath(options.runtime)
    const archiveCandidate = process.env.otc_FACE_RUNTIME_ARCHIVE ?? join(dirname(resolve(options.runtime)), runtimeSpec.archive)
    let archive = null
    if (existsSync(archiveCandidate)) { assertPinned(archiveCandidate, runtimeSpec.sha256, 'sha256'); archive = archiveCandidate }
    return { root, source: 'caller-provided', archive }
  }
  const archive = await fetchPinned(runtimeSpec.url, join(options.cache, runtimeSpec.archive), runtimeSpec.sha256)
  return { root: unpackRuntime(archive, options.cache), source: runtimeSpec.url, archive }
}

function omzCachePath(cache, hash) { return join(cache, '1', hash.slice(0, 2), hash.slice(2)) }

function seedOmzCache(cache, path, hash) {
  const target = omzCachePath(cache, hash); mkdirSync(dirname(target), { recursive: true })
  if (!existsSync(target)) copyFileSync(path, target); assertPinned(target, hash, 'sha384')
}

async function prepareSources(options) {
  const sourceRoot = join(options.cache, 'sources', `retinaface-${modelSpec.sourceRevision}`)
  const localRoot = process.env.otc_FACE_SOURCE_ROOT; const localWeights = process.env.otc_FACE_WEIGHTS
  const omzCache = join(options.cache, 'omz-download-cache'); const sourceFiles = []
  for (const source of modelSpec.sources) {
    const local = localRoot ? join(localRoot, source.path) : null
    const path = local && existsSync(local) ? copyPinned(local, join(sourceRoot, source.path), source.sha384, 'sha384', source.size) : await fetchPinned(source.url, join(sourceRoot, source.path), source.sha384, 'sha384', source.size)
    sourceFiles.push({ ...source, cachedPath: path }); seedOmzCache(omzCache, path, source.sha384)
  }
  const weightsPath = localWeights && existsSync(localWeights)
    ? copyPinned(localWeights, join(sourceRoot, 'Resnet50_Final.pth'), modelSpec.weightsSha384, 'sha384', modelSpec.weightsSize)
    : await fetchPinned(modelSpec.weightsUrl, join(sourceRoot, 'Resnet50_Final.pth'), modelSpec.weightsSha384, 'sha384', modelSpec.weightsSize)
  seedOmzCache(omzCache, weightsPath, modelSpec.weightsSha384)
  const modelYml = await fetchPinned(modelSpec.modelYml, join(options.cache, 'sources', 'retinaface-model.yml'), modelSpec.modelYmlSha256)
  const licenseSource = process.env.otc_FACE_LICENSE
  const license = licenseSource && existsSync(licenseSource) ? copyPinned(licenseSource, join(options.cache, 'sources', 'LICENSE.MIT'), modelSpec.licenseSha256, 'sha256', 1057) : await fetchPinned(modelSpec.licenseUrl, join(options.cache, 'sources', 'LICENSE.MIT'), modelSpec.licenseSha256)
  return { sourceFiles, weightsPath, modelYml, license, omzCache }
}

function findCommand(command) { try { return execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
function pythonVersion(python) { return execFileSync(python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'], { encoding: 'utf8' }).trim() }

function ensureBuildPython(cache) {
  const candidate = process.env.otc_FACE_PYTHON ?? process.env.PYTHON ?? findCommand('python3.11')
  if (!candidate) fail('Python 3.11 is required for face-model conversion; set otc_FACE_PYTHON or use the release setup-python step')
  const candidateVersion = pythonVersion(candidate)
  if (!candidateVersion.startsWith(`${conversionSpec.python}.`)) fail(`face conversion requires Python ${conversionSpec.python}.x, got ${candidateVersion}`)
  const venv = join(cache, 'python-venv'); const python = join(venv, 'bin', 'python')
  if (!existsSync(python)) execFileSync(candidate, ['-m', 'venv', venv], { stdio: 'inherit' })
  if (!pythonVersion(python).startsWith(`${conversionSpec.python}.`)) fail(`face conversion venv is not Python ${conversionSpec.python}.x`)
  const requirementsPath = join(projectRoot, 'scripts', 'face-pack-requirements.txt')
  const requirements = readFileSync(requirementsPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const requirementsHash = createHash('sha256').update(requirements.join('\n')).digest('hex').slice(0, 16)
  const marker = join(venv, `.otc-face-deps-${conversionSpec.openvino}-${conversionSpec.torch}-${requirementsHash}`)
  if (!existsSync(marker)) {
    const env = { ...process.env, CUDA_VISIBLE_DEVICES: '', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1' }
    const torchRequirements = requirements.filter((line) => line.startsWith('torch==') || line.startsWith('torchvision=='))
    const toolRequirements = requirements.filter((line) => !torchRequirements.includes(line))
    // Resolve the CPU wheels from the pinned PyTorch index without letting pip
    // resolve their dependencies from that index. The frozen transitive set
    // below is installed from PyPI immediately afterward; this avoids the
    // CPU index's underscore/hyphen metadata mismatch for typing_extensions.
    execFileSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--index-url', 'https://download.pytorch.org/whl/cpu', ...torchRequirements], { stdio: 'inherit', env })
    execFileSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', 'https://pypi.org/simple', ...toolRequirements], { stdio: 'inherit', env })
    writeFileSync(marker, `${JSON.stringify(conversionSpec)}\n`)
  }
  return python
}

function installedModelYml(python) {
  const root = execFileSync(python, ['-c', 'import omz_tools._common; print(omz_tools._common.MODEL_ROOT)'], { encoding: 'utf8' }).trim()
  const modelYml = join(root, 'public', modelSpec.name, 'model.yml'); assertPinned(modelYml, modelSpec.modelYmlSha256, 'sha256'); return modelYml
}

function cleanGeneratedPath(path, label) {
  const resolved = resolve(path)
  if (!resolved.startsWith(`${resolve(distRoot)}/`)) fail(`refusing to remove ${label} outside dist/: ${resolved}`)
  rmSync(resolved, { recursive: true, force: true })
}

function findConvertedModel(root, depth = 0) {
  if (!existsSync(root) || depth > 8) return null
  const entries = readdirSync(root, { withFileTypes: true }); const xml = entries.find((entry) => entry.isFile() && entry.name === `${modelSpec.name}.xml`); const bin = entries.find((entry) => entry.isFile() && entry.name === `${modelSpec.name}.bin`)
  if (xml && bin) return root
  for (const entry of entries) if (entry.isDirectory()) { const found = findConvertedModel(join(root, entry.name), depth + 1); if (found) return found }
  return null
}

function fixtureDirectory() {
  const configured = process.env.otc_FACE_FIXTURE_DIR
  const candidate = configured ? resolve(configured) : knownFixtureSpec.defaultDirectory
  if (!configured && !existsSync(candidate)) return null
  const large = join(candidate, knownFixtureSpec.large.name); const small = join(candidate, knownFixtureSpec.small.name)
  assertPinned(large, knownFixtureSpec.large.sha256, 'sha256'); assertPinned(small, knownFixtureSpec.small.sha256, 'sha256')
  return { directory: candidate, large, small }
}

function runKnownFaceSmoke(smokeBinary, modelXml, outputRoot) {
  const fixtures = fixtureDirectory()
  if (!fixtures) return null
  const env = { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1', OPENVINO_LIB_PATH: join(outputRoot, 'lib'), LD_LIBRARY_PATH: `${join(outputRoot, 'lib')}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`, OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4' }
  execFileSync(smokeBinary, ['--model', modelXml, '--fixture', fixtures.large, '--small-fixture', fixtures.small, '--device', 'CPU', '--threshold', '0.215'], { stdio: 'inherit', env })
  return { entrypoint: 'otc-face-blur-smoke', device: 'CPU', threshold: 0.215, fixtures: { large: knownFixtureSpec.large, small: knownFixtureSpec.small } }
}

async function prepareModel(options, sources) {
  const direct = [options.modelDir, process.env.otc_OMZ_MODEL_DIR].filter(Boolean).map((path) => resolve(path)).find((path) => (existsSync(join(path, 'model.xml')) && existsSync(join(path, 'model.bin'))) || (existsSync(join(path, `${modelSpec.name}.xml`)) && existsSync(join(path, `${modelSpec.name}.bin`))))
  if (direct) return { modelDir: direct, python: null, sources }
  const python = ensureBuildPython(options.cache); installedModelYml(python)
  const omzRoot = join(options.cache, 'omz-models'); const modelOutput = join(omzRoot, 'public', modelSpec.name); cleanGeneratedPath(modelOutput, 'stale OMZ model output'); mkdirSync(omzRoot, { recursive: true })
  const env = { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4' }
  const downloader = join(dirname(python), 'omz_downloader')
  execFileSync(downloader, ['--name', modelSpec.name, '--output_dir', omzRoot, '--cache_dir', sources.omzCache, '--num_attempts', '1', '--jobs', '1'], { stdio: 'inherit', env })
  for (const source of sources.sourceFiles) {
    const sourcePath = join(omzRoot, 'public', modelSpec.name, source.path)
    // OMZ keeps the raw source beside retinaface.py as .orig, then rewrites
    // the imported ResNet constructor to pretrained=False. The raw source was
    // already verified before seeding the downloader cache; verify that copy
    // here and validate the intentional post-processing separately.
    if (source.path === 'models/retinaface.py') {
      const originalPath = `${sourcePath}.orig`
      if (existsSync(originalPath)) assertPinned(originalPath, source.sha384, 'sha384', source.size)
      const patched = readFileSync(sourcePath, 'utf8')
      if (!patched.includes('pretrained=False')) fail('OMZ postprocessing did not force pretrained=False in models/retinaface.py')
    } else {
      assertPinned(sourcePath, source.sha384, 'sha384', source.size)
    }
  }
  assertPinned(join(omzRoot, 'public', modelSpec.name, 'Resnet50_Final.pth'), modelSpec.weightsSha384, 'sha384', modelSpec.weightsSize)
  execFileSync(python, [join(projectRoot, 'scripts', 'convert-face-model.py'), '--download-dir', omzRoot, '--output-dir', omzRoot], { stdio: 'inherit', env })
  const converted = findConvertedModel(omzRoot); if (!converted) fail('OMZ conversion completed without a retinaface-resnet50-pytorch XML/BIN pair')
  return { modelDir: converted, python, sources }
}

function walkSharedLibraries(root, depth = 0) {
  if (!existsSync(root) || depth > 4) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) files.push(...walkSharedLibraries(path, depth + 1)); else if ((entry.isFile() || entry.isSymbolicLink()) && /\.so(?:\.|$)/.test(entry.name)) files.push(path) }
  return files
}

function copyRuntimeLibraries(runtimeRoot, outputRoot) {
  const roots = [join(runtimeRoot, 'runtime', 'lib', 'intel64'), join(runtimeRoot, 'runtime', '3rdparty', 'tbb', 'lib')]; mkdirSync(join(outputRoot, 'lib'), { recursive: true }); const copied = new Set()
  for (const path of roots.flatMap((root) => walkSharedLibraries(root))) {
    const name = basename(path); const needed = name.startsWith('libopenvino.so') || name.startsWith('libopenvino_ir_frontend.so') || name.startsWith('libopenvino_intel_cpu_plugin.so') || name.startsWith('libopenvino_intel_gpu_plugin.so') || name.startsWith('libtbb.so') || name.startsWith('libtbbbind_2_5.so') || name.startsWith('libtbbmalloc.so') || name.startsWith('libtbbmalloc_proxy.so') || name.startsWith('libhwloc.so')
    if (!needed || copied.has(name)) continue; copyFileSync(path, join(outputRoot, 'lib', name)); copied.add(name)
  }
  if (!Array.from(copied).some((name) => name.startsWith('libopenvino.so'))) fail('runtime archive has no libopenvino.so')
  if (!Array.from(copied).some((name) => name.startsWith('libopenvino_intel_cpu_plugin.so'))) fail('runtime archive has no CPU plugin')
  if (!Array.from(copied).some((name) => name.startsWith('libopenvino_intel_gpu_plugin.so'))) fail('runtime archive has no Intel GPU plugin')
  return [...copied].sort()
}

function runBuild(runtimeRoot, cache) {
  const buildRoot = join(cache, 'native-build'); cleanGeneratedPath(buildRoot, 'native build directory'); mkdirSync(cache, { recursive: true })
  const args = ['-S', nativeRoot, '-B', buildRoot, '-DCMAKE_BUILD_TYPE=Release', '-DFACE_BLUR_BUILD_TESTS=ON', '-DFACE_BLUR_BUILD_SMOKE=ON', `-DOpenVINO_DIR=${join(runtimeRoot, 'runtime', 'cmake')}`]
  const tbbPkg = join(runtimeRoot, 'runtime', '3rdparty', 'tbb', 'lib', 'pkgconfig'); const env = { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', PKG_CONFIG_PATH: `${tbbPkg}${process.env.PKG_CONFIG_PATH ? `:${process.env.PKG_CONFIG_PATH}` : ''}` }
  execFileSync('cmake', args, { stdio: 'inherit', env }); execFileSync('cmake', ['--build', buildRoot, '--parallel', '2'], { stdio: 'inherit', env }); execFileSync('ctest', ['--test-dir', buildRoot, '--output-on-failure'], { stdio: 'inherit', env }); return { binary: join(buildRoot, 'otc-face-blur'), smoke: join(buildRoot, 'otc-face-blur-smoke') }
}

async function copyLicenses(runtimeRoot, outputRoot, modelLicense) {
  copyFileSync(modelLicense, join(outputRoot, 'LICENSE-RETINAFACE-MIT.txt'))
  const licenses = [[join(runtimeRoot, 'docs', 'licensing', 'LICENSE'), 'LICENSE-OPENVINO.txt'], [join(runtimeRoot, 'docs', 'licensing', 'runtime-third-party-programs.txt'), 'NOTICE-OPENVINO-RUNTIME.txt'], [join(runtimeRoot, 'docs', 'licensing', 'onetbb_third-party-programs.txt'), 'NOTICE-OPENVINO-TBB.txt'], [join(runtimeRoot, 'docs', 'licensing', 'onednn_third-party-programs.txt'), 'NOTICE-OPENVINO-ONEDNN.txt'], [join(runtimeRoot, 'docs', 'licensing', 'Apache_license.txt'), 'LICENSE-OPENVINO-APACHE.txt'], [join(runtimeRoot, 'runtime', '3rdparty', 'tbb', 'TBB-LICENSE'), 'LICENSE-TBB.txt']]
  for (const [source, destination] of licenses) if (existsSync(source)) copyFileSync(source, join(outputRoot, destination))
  if (!existsSync(join(outputRoot, 'LICENSE-OPENVINO.txt'))) fail('runtime archive does not contain the OpenVINO license')
}

function verifyModel(modelDir) {
  const prefix = existsSync(join(modelDir, 'model.xml')) ? 'model' : modelSpec.name
  const xml = join(modelDir, `${prefix}.xml`); const bin = join(modelDir, `${prefix}.bin`)
  if (!existsSync(xml) || !statSync(xml).isFile() || !existsSync(bin) || !statSync(bin).isFile()) fail('--model-dir must contain regular model.xml and model.bin files')
  return { xml, bin }
}

function sourceManifest() {
  const files = readdirSync(nativeRoot).filter((name) => ['.cpp', '.hpp', '.txt', '.md'].includes(extname(name)) || name === 'CMakeLists.txt')
  return files.sort().map((name) => ({ path: `native/face-blur/${name}`, sha256: digest(join(nativeRoot, name)) }))
}

function writeLauncher(outputRoot) {
  const launcher = '#!/bin/sh\nset -eu\npack_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport OPENVINO_LIB_PATH="$pack_root/lib"\nexport LD_LIBRARY_PATH="$pack_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nexport CUDA_VISIBLE_DEVICES=""\nif [ -n "${PKEXEC_UID:-}" ]; then\n  export NEO_CACHE_PERSISTENT=0\nfi\nexec "$pack_root/otc-face-blur.bin" "$@"\n'
  writeFileSync(join(outputRoot, 'otc-face-blur'), launcher, { mode: 0o755 }); chmodSync(join(outputRoot, 'otc-face-blur'), 0o755)
}

function makeManifest(outputRoot, runtime, modelFiles, libraries, verification) {
  const manifest = {
    format: 1, model: 'retinaface-resnet50', modelZooName: modelSpec.name,
    protocol: { stdin: 'RGB24', stdout: 'RGB24', frameBytes: 'width*height*3', effectsTsv: ['start_seconds', 'end_seconds', 'sensitivity_0to1', 'detail_0or1', 'hold_seconds', 'strength_0to1', 'style_0pixelate_1blur_2mask'], maxInFlightRequests: 1, maxEffectRows: 100, maxHoldSeconds: 1, maxFrameDimensions: '100000x100000 subject to 256MiB RGB24 bound', maxFps: 1000 },
    runtime: { name: 'OpenVINO Runtime', version: runtimeSpec.version, releaseDate: runtimeSpec.releaseDate, source: runtime.source, archiveSha256: runtime.archive ? digest(runtime.archive) : null, libraries },
    conversion: { python: conversionSpec, pretrained: false, device: 'CPU', threads: 4 },
    provenance: { modelYml: modelSpec.modelYml, modelYmlSha256: modelSpec.modelYmlSha256, weightsUrl: modelSpec.weightsUrl, weightsSha384: modelSpec.weightsSha384, weightsSize: modelSpec.weightsSize, sourceRevision: modelSpec.sourceRevision, sources: modelSpec.sources.map(({ path, url, sha384, size }) => ({ path, url, sha384, size })), license: { spdx: 'MIT', url: modelSpec.licenseUrl, sha256: modelSpec.licenseSha256 }, input: { shape: [1, 3, 640, 640], layout: 'NCHW', order: 'BGR', mean: [104, 117, 123], meanAppliedBy: 'OMZ Model Optimizer IR' }, outputs: ['face_rpn_bbox_pred', 'face_rpn_cls_prob', 'face_rpn_landmark_pred'], ir: { xmlSha256: digest(modelFiles.xml), binSha256: digest(modelFiles.bin), xmlBytes: statSync(modelFiles.xml).size, binBytes: statSync(modelFiles.bin).size } },
    sourceManifest: sourceManifest(), verification, files: []
  }
  const legalFiles = readdirSync(outputRoot).filter((name) => name === 'LICENSE' || name.startsWith('LICENSE-') || name.startsWith('NOTICE-')).sort(); const requiredFiles = ['otc-face-blur', 'otc-face-blur.bin', 'model.xml', 'model.bin', ...legalFiles]
  for (const name of requiredFiles) { const path = join(outputRoot, name); manifest.files.push({ path: name, sha256: digest(path), bytes: statSync(path).size }) }
  for (const name of libraries) { const path = join(outputRoot, 'lib', name); manifest.files.push({ path: `lib/${name}`, sha256: digest(path), bytes: statSync(path).size }) }
  writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); return manifest
}

async function build(options) {
  if (options.dryRun) { process.stdout.write(`${JSON.stringify({ runtime: runtimeSpec, model: modelSpec, conversion: conversionSpec, output: options.output, archive: options.archive }, null, 2)}\n`); return }
  const sources = await prepareSources(options); const model = await prepareModel(options, sources); const runtime = await obtainRuntime(options); const modelFiles = verifyModel(model.modelDir); const binaries = runBuild(runtime.root, options.cache)
  cleanGeneratedPath(options.output, 'face-pack output'); mkdirSync(options.output, { recursive: true }); copyFileSync(binaries.binary, join(options.output, 'otc-face-blur.bin')); copyFileSync(modelFiles.xml, join(options.output, 'model.xml')); copyFileSync(modelFiles.bin, join(options.output, 'model.bin')); copyFileSync(join(projectRoot, 'LICENSE'), join(options.output, 'LICENSE'))
  await copyLicenses(runtime.root, options.output, sources.license); const libraries = copyRuntimeLibraries(runtime.root, options.output); writeLauncher(options.output)
  const verification = runKnownFaceSmoke(binaries.smoke, join(options.output, 'model.xml'), options.output) ?? { entrypoint: 'otc-face-blur-smoke', device: 'CPU', status: 'fixture-not-supplied' }
  const manifest = makeManifest(options.output, runtime, { xml: join(options.output, 'model.xml'), bin: join(options.output, 'model.bin') }, libraries, verification)
  const zip = new AdmZip(); zip.addLocalFolder(options.output, 'face-pack'); mkdirSync(dirname(options.archive), { recursive: true }); zip.writeZip(options.archive)
  if (!options.quiet) process.stdout.write(`Created ${options.archive} (${statSync(options.archive).size} bytes), ${manifest.files.length} files\n`)
}

await build(parseArgs(process.argv.slice(2)))
