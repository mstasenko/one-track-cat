import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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

function privatePulseAudioCommand(socket) {
  return {
    command: 'pulseaudio',
    args: [
      '--daemonize=no', '--exit-idle-time=-1', '--log-target=stderr', '--fail=yes', '-n',
      '-L', 'module-null-sink rate=48000 channels=2 norewinds=1 sink_name=otc-headless',
      '-L', `module-native-protocol-unix socket=${socket} auth-anonymous=1`
    ]
  }
}

function isSocket(path) {
  try { return statSync(path).isSocket() } catch { return false }
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

async function waitForSocket(path, child, readLog, label = 'Headless compositor', failed = () => false, ready = existsSync) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (failed() || child.exitCode !== null) throw new Error(`${label} exited early\n${readLog()}`)
    if (ready(path)) return
    await delay(100)
  }
  throw new Error(`${label} did not create ${path}\n${readLog()}`)
}

function launchPrivatePulseAudio(socket, environment) {
  const spec = privatePulseAudioCommand(socket)
  const pulseEnvironment = { ...environment }
  delete pulseEnvironment.PULSE_SERVER
  const child = spawn(spec.command, spec.args, {
    env: pulseEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  let startupError
  const capture = (chunk) => { log = `${log}${chunk}`.slice(-16_000) }
  const readLog = () => `${log}${startupError ? `\n${startupError.message}` : ''}`
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.once('error', (error) => { startupError = error })
  return { child, readLog, failed: () => startupError !== undefined }
}

async function stopPrivatePulseAudio(server) {
  const child = server?.child
  if (child) {
    if (child.exitCode === null) {
      try { child.kill('SIGTERM') } catch { /* already stopped */ }
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2_000)])
      if (child.exitCode === null) {
        try { child.kill('SIGKILL') } catch { /* already stopped */ }
      }
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

async function stopCompositor(compositor, runtimeDirectory) {
  if (compositor && compositor.exitCode === null && compositor.pid) {
    try { process.kill(-compositor.pid, 'SIGTERM') } catch { /* already stopped */ }
    await Promise.race([new Promise((resolve) => compositor.once('exit', resolve)), delay(2_000)])
    if (compositor.exitCode === null) {
      try { process.kill(-compositor.pid, 'SIGKILL') } catch { /* already stopped */ }
    }
  }
  // Give detached compositor helpers time to leave the private runtime tree.
  await delay(250)
  compositor?.stdout?.destroy()
  compositor?.stderr?.destroy()
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
    NO_AT_BRIDGE: '1',
    PLAYWRIGHT_FORCE_TTY: process.env.PLAYWRIGHT_FORCE_TTY ?? '0'
  }
  let compositor
  let pulseAudio
  try {
    const compositorSpec = compositorCommand(socket)
    // Prevent Electron and the private audio server from falling back to the
    // user's visible X11 desktop.
    delete environment.DISPLAY
    const hostPulseSocket = process.env.XDG_RUNTIME_DIR && join(process.env.XDG_RUNTIME_DIR, 'pulse', 'native')
    if (!environment.PULSE_SERVER && hostPulseSocket && isSocket(hostPulseSocket)) {
      // Keep using the user's desktop server without changing or stopping it.
      environment.PULSE_SERVER = `unix:${hostPulseSocket}`
    } else if (!environment.PULSE_SERVER && available('pulseaudio')) {
      const privatePulseSocket = join(runtimeDirectory, 'pulse-native')
      pulseAudio = launchPrivatePulseAudio(privatePulseSocket, environment)
      await waitForSocket(privatePulseSocket, pulseAudio.child, pulseAudio.readLog, 'PulseAudio', pulseAudio.failed, isSocket)
      if (pulseAudio.failed() || pulseAudio.child.exitCode !== null) {
        throw new Error(`PulseAudio exited early\n${pulseAudio.readLog()}`)
      }
      environment.PULSE_SERVER = `unix:${privatePulseSocket}`
    }

    compositor = spawn(compositorSpec.command, compositorSpec.args, {
      detached: true,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    const capture = (chunk) => { log = `${log}${chunk}`.slice(-16_000) }
    compositor.stdout.on('data', capture)
    compositor.stderr.on('data', capture)
    await waitForSocket(join(runtimeDirectory, socket), compositor, () => log)
    return await runCommand(command, args, environment)
  } finally {
    await stopPrivatePulseAudio(pulseAudio)
    await stopCompositor(compositor, runtimeDirectory)
  }
}

process.exitCode = await main()
