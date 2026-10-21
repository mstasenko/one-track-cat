import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('disables npm lockfile creation and ignores generated lockfiles', () => {
  expect(readFileSync('.npmrc', 'utf8')).toMatch(/^package-lock=false$/m)
  expect(readFileSync('.gitignore', 'utf8')).toMatch(/^package-lock\.json$/m)
})

it('rejects ZIP extraction through a destination symlink without overwriting its target', () => {
  // Match the Node build scripts, not jsdom's separate Uint8Array realm.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import AdmZip from 'adm-zip'
    const directory = fs.mkdtempSync(join(tmpdir(), 'otc-zip-security-'))
    try {
      const target = join(directory, 'outside.txt'), destination = join(directory, 'extract')
      fs.writeFileSync(target, 'unchanged')
      fs.mkdirSync(destination)
      fs.symlinkSync(target, join(destination, 'file.txt'))
      const archive = new AdmZip()
      archive.addFile('file.txt', Buffer.from('overwritten'))
      assert.throws(() => new AdmZip(archive.toBuffer()).extractAllTo(destination, true))
      assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged')
    } finally { fs.rmSync(directory, { recursive: true }) }
  `], { timeout: 5_000 })
})

it('keeps the packager downloader proxy working with its security override', async () => {
  const requested: string[] = []
  const proxy = createServer((request, response) => {
    requested.push(request.url ?? '')
    response.end('proxied')
  })
  try {
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Proxy test has no TCP port')
    // Bootstrap in a child: global-agent intentionally patches Node's HTTP globals.
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module'
      import http from 'node:http'
      const require = createRequire(import.meta.url)
      const builder = createRequire(require.resolve('app-builder-lib'))
      const downloader = createRequire(builder.resolve('@electron/get'))
      downloader('global-agent').bootstrap()
      http.get('http://otc-proxy-test.invalid/artifact.zip', response => {
        response.pipe(process.stdout)
      }).on('error', error => { console.error(error); process.exitCode = 1 })
    `], {
      timeout: 5_000,
      env: { ...process.env, GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${address.port}`, GLOBAL_AGENT_NO_PROXY: '' }
    })
    expect(stdout).toBe('proxied')
    expect(requested).toEqual(['http://otc-proxy-test.invalid/artifact.zip'])
  } finally {
    await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
  }
})
