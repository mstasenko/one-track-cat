import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function available(command) {
  return spawnSync('sh', ['-c', `command -v "$1"`, 'sh', command], { stdio: 'ignore' }).status === 0
}

function compositorCommand(socket) {
  if (available('gnome-shell')) {
    return {
      command: 'dbus-run-session',
      args: [
        '--', 'gnome-shell', '--wayland', '--headless', '--no-x11',
        '--virtual-monitor', '1920x1080', '--wayland-display', socket
      ]
    }
  }
  if (available('weston')) {
    return {
      command: 'weston',
      args: [
        '--backend=headless-backend.so', `--socket=${socket}`,
        '--width=1920', '--height=1080', '--idle-time=0'
      ]
    }
  }
  throw new Error('Hidden GUI commands require GNOME Shell or Weston')
}

function runCommand(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', async (code, signal) => {
      // timeout(1) can exit before Electron's subprocesses. End its private process
      // group so none can keep writing into the disposable profile during cleanup.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* already stopped */ }
      }
      await delay(250)
      resolve(signal ? 1 : (code ?? 1))
    })
  })
}

async function waitForSocket(path, compositor, readLog) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (existsSync(path)) return
    if (compositor.exitCode !== null) throw new Error(`Headless compositor exited early\n${readLog()}`)
    await delay(100)
  }
  throw new Error(`Headless compositor did not create ${path}\n${readLog()}`)
}

async function stopCompositor(compositor, runtimeDirectory) {
  if (compositor.exitCode === null && compositor.pid) {
    try { process.kill(-compositor.pid, 'SIGTERM') } catch { /* already stopped */ }
    await Promise.race([new Promise((resolve) => compositor.once('exit', resolve)), delay(2_000)])
    if (compositor.exitCode === null) {
      try { process.kill(-compositor.pid, 'SIGKILL') } catch { /* already stopped */ }
    }
  }
  // GNOME and Electron may leave private portal/GVFS FUSE mounts behind.
  for (const mount of ['doc', 'gvfs']) {
    spawnSync('fusermount3', ['-uz', join(runtimeDirectory, mount)], { stdio: 'ignore' })
  }
  rmSync(runtimeDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('Usage: node scripts/run-headless-wayland.mjs <command> [arguments...]')

  const runtimeDirectory = mkdtempSync(join(tmpdir(), 'otc-wayland-'))
  chmodSync(runtimeDirectory, 0o700)
  for (const directory of ['cache', 'config', 'data']) mkdirSync(join(runtimeDirectory, directory))
  const socket = `otc-test-${process.pid}`
  const environment = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDirectory,
    XDG_CACHE_HOME: join(runtimeDirectory, 'cache'),
    XDG_CONFIG_HOME: join(runtimeDirectory, 'config'),
    XDG_DATA_HOME: join(runtimeDirectory, 'data'),
    XDG_SESSION_TYPE: 'wayland',
    XDG_CURRENT_DESKTOP: 'GNOME',
    WAYLAND_DISPLAY: socket,
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    otc_HEADLESS_TEST: '1',
    LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE ?? '1',
    GIO_USE_VFS: 'local',
    NO_AT_BRIDGE: '1'
  }
  // Moving XDG_RUNTIME_DIR also hides the desktop audio socket. Keep a real
  // audio clock for PCM tests instead of Chromium's discontinuous dummy sink.
  const pulseSocket = process.env.XDG_RUNTIME_DIR && join(process.env.XDG_RUNTIME_DIR, 'pulse', 'native')
  if (!environment.PULSE_SERVER && pulseSocket && existsSync(pulseSocket)) {
    environment.PULSE_SERVER = `unix:${pulseSocket}`
  }
  // Prevent Electron from falling back to the user's visible X11 desktop.
  delete environment.DISPLAY

  const compositorSpec = compositorCommand(socket)
  const compositor = spawn(compositorSpec.command, compositorSpec.args, {
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  const capture = (chunk) => { log = `${log}${chunk}`.slice(-16_000) }
  compositor.stdout.on('data', capture)
  compositor.stderr.on('data', capture)

  try {
    await waitForSocket(join(runtimeDirectory, socket), compositor, () => log)
    return await runCommand(command, args, environment)
  } finally {
    await stopCompositor(compositor, runtimeDirectory)
  }
}

process.exitCode = await main()
