import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, copyFile, cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

// Package a qualified torch-free environment, never the conversion environment
// or its weights. Building in a new directory also leaves the dev pack untouched.
const cache = resolve(process.argv[2] ?? 'dist/voice-pack-cache')
const output = resolve(process.argv[3] ?? 'dist/voice-pack-release')
const archive = resolve(process.argv[4] ?? 'release/otc-voice-pack.zip')
if (!output.startsWith(resolve('dist') + sep)) throw new Error('Voice pack output must be a child of dist/')
const sourcePython = join(cache, 'venv/bin/python')
// These contracts use fake models: no downloads or GPU access.
for (const test of ['test_narration_vad.py', 'test_narration_voice.py', 'test_narration_worker.py']) {
  execFileSync(sourcePython, ['-B', join('scripts', test)], { stdio: 'inherit' })
}
const layout = JSON.parse(execFileSync(sourcePython, ['-I', '-c',
  'import json,sys,sysconfig; print(json.dumps(dict(stdlib=sysconfig.get_path("stdlib"), version=f"{sys.version_info.major}.{sys.version_info.minor}")))'
], { encoding: 'utf8' }))
const packages = join(cache, `venv/lib/python${layout.version}/site-packages`)
for (const name of ['torch', 'nncf', 'transformers', 'vllm']) {
  if (await access(join(packages, name)).then(() => true, () => false)) throw new Error(`Build environment contains ${name}`)
}
const helper = join(cache, 'voxcpm2_tts_helper.py')
if (createHash('sha256').update(await readFile(helper)).digest('hex') !== '942455d80931f5cc2b69fc37d4a0de39bf0d38fb6b0719398d05809ddc4b21af') {
  throw new Error('VoxCPM adapter does not match the reviewed revision')
}
await mkdir(output) // Refuse to merge into a stale or occupied build.
const pack = join(output, 'voice-pack')
const runtime = join(pack, 'runtime')
await mkdir(join(runtime, 'bin'), { recursive: true })
await mkdir(join(runtime, 'lib'), { recursive: true })
await copyFile(await realpath(sourcePython), join(runtime, 'bin/python'))
await chmod(join(runtime, 'bin/python'), 0o755)
const excluded = new Set(['__pycache__', 'site-packages', 'test', 'tests', 'ensurepip', 'idlelib', 'tkinter'])
const filter = (path) => !path.split(sep).some((part) => excluded.has(part))
await cp(layout.stdlib, join(runtime, `lib/python${layout.version}`), { recursive: true, dereference: true, filter })
await cp(packages, join(runtime, `lib/python${layout.version}/site-packages`), {
  recursive: true, dereference: true, filter: (path) => !path.split(sep).includes('__pycache__')
})
// Debian's site.py otherwise uses dist-packages, while venv wheels use
// site-packages. Pin relative import roots; never borrow host/user packages.
await writeFile(join(runtime, 'bin/python._pth'), [
  '../..', `../lib/python${layout.version}`, `../lib/python${layout.version}/lib-dynload`,
  `../lib/python${layout.version}/site-packages`, 'import site', ''
].join('\n'))
for (const name of ['narration_worker.py', 'narration_separator.py', 'narration_voice.py', 'narration_vad.py']) {
  await copyFile(join('scripts', name), join(pack, name))
}
await copyFile(helper, join(pack, 'voxcpm2_tts_helper.py'))
await copyFile('assets/voice/sources.json', join(pack, 'sources.json'))
await copyFile('assets/voice/NOTICE.md', join(pack, 'NOTICE.md'))
await mkdir(join(pack, 'licenses'))
await copyFile('assets/voice/LICENSE-Whisper-MIT.txt', join(pack, 'licenses/Whisper.txt'))
await copyFile('assets/voice/LICENSE-Silero-VAD-MIT.txt', join(pack, 'licenses', 'Silero-VAD.txt'))
for (const [name, source] of Object.entries({ VoxCPM: join(cache, 'VoxCPM/LICENSE'),
  ClearerVoice: join(cache, 'ClearerVoice-Studio/LICENSE'), Python: `/usr/share/doc/python${layout.version}/copyright` })) {
  await copyFile(source, join(pack, 'licenses', `${name}.txt`))
}
// -I, a different cwd, and no venv config prove this runtime relocates without
// PYTHONHOME/PYTHONPATH or the builder's system-installed Python packages.
execFileSync(join(runtime, 'bin/python'), ['-I', '-B', '-c',
  'import importlib.util,openvino,openvino_genai,numpy,scipy,soundfile,librosa,narration_worker; assert importlib.util.find_spec("torch") is None'
], { cwd: '/', stdio: 'inherit' })
await writeFile(join(pack, 'manifest.json'), JSON.stringify({ format: 1, python: layout.version,
  openvino: '2026.4.1', models: 'download-on-first-use' }, null, 2) + '\n')
await mkdir(dirname(archive), { recursive: true })
if (await access(archive).then(() => true, () => false)) throw new Error('Voice pack archive already exists; choose a new archive path')
execFileSync('zip', ['-q', '-r', archive, 'voice-pack'], { cwd: output, stdio: 'inherit' })
console.log(`Created ${archive} (${(await stat(archive)).size} bytes); no model weights included.`)
