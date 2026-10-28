import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { link, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'

const cache = resolve(process.argv[2] ?? 'dist/voice-pack-cache/models')
const output = resolve(process.argv[3] ?? 'dist/voice-pack-cache/model-publication')
const release = 'https://github.com/mstasenko/one-track-cat/releases/download/models-voice-v1/'
if (!relative(resolve('dist'), output) || relative(resolve('dist'), output).startsWith('..')) throw new Error('Output must be inside dist/')
const sources = [
  ['whisper', 'whisper-large-v3-fp16', 'https://huggingface.co/OpenVINO/whisper-large-v3-fp16-ov/resolve/220761e60602a5ca694c409d5f424563b75d6820/'],
  ['cleanup', 'qwen3.5-4b-int8', 'https://huggingface.co/OpenVINO/Qwen3.5-4B-int8-ov/resolve/e4d8de7a25bc3007261c28785bc190c97cabd243/'],
  ['voice', 'voxcpm2-fp16', ''], ['separator', 'mossformer2-se-48k-real-reference', ''],
  ['vad', 'silero-vad', 'https://raw.githubusercontent.com/snakers4/silero-vad/066409f3d9db45a30d21dfcbf9147826ffdd7052/src/silero_vad/data/silero_vad_openvino_16k.onnx']
]
await mkdir(join(output, 'assets'), { recursive: true })
const artifacts = []
const assemblies = []
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
for (const [directory, local, upstream] of sources) {
  for (const entry of await readdir(join(cache, local), { withFileTypes: true })) {
    // Exclude conversion probes, local caches and recordings. Only deployable
    // model files leave the host; upstream weights retain their official URLs.
    if (!entry.isFile() || !/\.(?:bin|xml|onnx|json|txt|jinja|md)$/i.test(entry.name) || entry.name === 'provenance.json') continue
    const source = join(cache, local, entry.name)
    const bytes = (await stat(source)).size
    const path = `${directory}/${entry.name}`
    const sha256 = await digest(source)
    if (upstream) { artifacts.push({ path, bytes, sha256, url: upstream.endsWith('/') ? upstream + entry.name : upstream }); continue }
    const parts = []
    for (let start = 0, index = 0; start < bytes; start += 1024 ** 3, index++) {
      const part = bytes > 1024 ** 3 ? `${path}.part${index}` : path
      const name = part.replaceAll('/', '--')
      const destination = join(output, 'assets', name)
      const size = Math.min(1024 ** 3, bytes - start)
      if (part === path) await link(source, destination)
      else await pipeline(createReadStream(source, { start, end: start + size - 1 }), createWriteStream(destination, { flags: 'wx' }))
      artifacts.push({ path: part, bytes: size, sha256: part === path ? sha256 : await digest(destination), url: release + name })
      parts.push(part)
    }
    if (parts.length > 1) assemblies.push({ path, bytes, sha256, parts })
  }
}
await writeFile(join(output, 'sources.json'), JSON.stringify({ format: 1, modelId: 'otc-voice-models', artifacts, assemblies }, null, 2) + '\n', { flag: 'wx' })
console.log(`Prepared ${artifacts.length} model files; ${assemblies.length} require reassembly. No weights go into the runtime ZIP.`)
