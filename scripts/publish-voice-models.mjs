import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Publishing weights is separate from pushing app code or making an app release.
// Wait for uploads already in progress; never publish a partially filled release.
const repo = 'mstasenko/one-track-cat'
const tag = 'models-voice-v1'
const directory = 'dist/voice-pack-cache/model-publication/assets'
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 })
const expected = []
for (const name of await readdir(directory)) {
  const path = join(directory, name)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Unexpected model publication directory')
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  expected.push({ name, size: info.size, digest: `sha256:${hash.digest('hex')}` })
}
for (;;) {
  const release = JSON.parse(gh('api', `repos/${repo}/releases`, '--jq', `.[] | select(.tag_name == "${tag}")`))
  for (const asset of release.assets) {
    const file = expected.find((item) => item.name === asset.name)
    if (!file) throw new Error(`Unexpected release asset: ${asset.name}`)
    if (asset.state === 'uploaded' && (file.size !== asset.size || file.digest !== asset.digest)) {
      throw new Error(`Release asset verification failed: ${asset.name}`)
    }
  }
  const complete = release.assets.filter((asset) => asset.state === 'uploaded').length
  console.log(`Verified voice model uploads: ${complete}/${expected.length}`)
  if (complete === expected.length) break
  await new Promise((resolve) => setTimeout(resolve, 60_000))
}
gh('release', 'edit', tag, '--repo', repo, '--notes-file', 'assets/voice/models-release.md', '--draft=false', '--latest=false')
console.log(`Published verified voice models: https://github.com/${repo}/releases/tag/${tag}`)
