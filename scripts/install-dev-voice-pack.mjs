import { access, chmod, copyFile, lstat, mkdir, symlink, readlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Development uses the already-qualified models in place, not another 14 GB copy.
// Redistributable packs contain the runtime/catalog; weights download separately.
const cache = resolve(process.argv[2] ?? 'dist/voice-pack-cache')
const pack = resolve('dist/voice-pack')
const links = {
  runtime: 'venv', separator: 'models/mossformer2-se-48k-real-reference',
  whisper: 'models/whisper-large-v3-fp16', cleanup: 'models/qwen3.5-4b-int8', voice: 'models/voxcpm2-fp16'
}
for (const source of Object.values(links)) await access(join(cache, source))
await mkdir(pack, { recursive: true, mode: 0o700 })
const info = await lstat(pack)
if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('Unsafe development voice pack directory')
// The dev pack also holds newly downloaded models; match the private release cache.
await chmod(pack, 0o700)
for (const [name, source] of Object.entries(links)) {
  const target = join(cache, source)
  try { await symlink(target, join(pack, name)) }
  catch (error) {
    if (error.code !== 'EEXIST' || await readlink(join(pack, name)) !== target) throw error
  }
}
for (const name of ['narration_worker.py', 'narration_separator.py', 'narration_voice.py', 'narration_vad.py']) {
  await copyFile(join('scripts', name), join(pack, name))
}
await copyFile(join(cache, 'voxcpm2_tts_helper.py'), join(pack, 'voxcpm2_tts_helper.py'))
await mkdir(join(pack, 'licenses'), { recursive: true })
await copyFile(join('assets', 'voice', 'LICENSE-Whisper-MIT.txt'), join(pack, 'licenses', 'Whisper.txt'))
await copyFile('assets/voice/LICENSE-Silero-VAD-MIT.txt', join(pack, 'licenses', 'Silero-VAD.txt'))
await copyFile(join('assets', 'voice', 'NOTICE.md'), join(pack, 'NOTICE.md'))
await copyFile(join('assets', 'voice', 'sources.json'), join(pack, 'sources.json'))
for (const [name, source] of Object.entries({ VoxCPM: 'VoxCPM/LICENSE', ClearerVoice: 'ClearerVoice-Studio/LICENSE' })) {
  await copyFile(join(cache, source), join(pack, 'licenses', `${name}.txt`))
}
console.log('Development voice pack installed in dist/voice-pack; model weights were not duplicated.')
