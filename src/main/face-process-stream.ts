import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { PassThrough, type Readable, type Writable } from 'node:stream'

/** A pipeline child always has output streams, but direct decoder input has no stdin wrapper. */
export type FaceProcess = ChildProcessByStdio<Writable | null, Readable, Readable>

export function spawnFaceProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  directInput?: Readable
): FaceProcess {
  const child = spawn(executable, args, {
    stdio: directInput ? [directInput, 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    env
  }) as FaceProcess
  if (directInput) {
    // The child owns the duplicated descriptor; closing this parent wrapper lets
    // the decoder close event describe the actual producer lifecycle.
    // This retired wrapper carries no data; child exits report real I/O failures.
    directInput.on('error', () => undefined)
    directInput.destroy()
  }
  return child
}

export function cleanupFaceInputBuffer(buffer: PassThrough | undefined, source?: Readable): PassThrough | undefined {
  if (!buffer) return buffer
  source?.unpipe(buffer)
  buffer.unpipe()
  buffer.destroy()
  return undefined
}
