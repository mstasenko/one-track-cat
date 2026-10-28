import type { ProjectCanvas } from '../types'
import type { FaceCommand } from './face-process'
import type { FacePack } from './face-pack'
import { restrictedIntelRenderNode } from './intel-device'

type FaceWorkerCanvas = Pick<ProjectCanvas, 'width' | 'height' | 'fps'>

const pkexecPath = '/usr/bin/pkexec'

export function nativeFaceWorkerCommand(pack: FacePack, canvas: FaceWorkerCanvas, effects: string, device: 'CPU' | 'AUTO'): FaceCommand {
  return { executable: pack.executable, args: [
    '--model', pack.model, '--width', String(canvas.width), '--height', String(canvas.height), '--fps', String(canvas.fps),
    '--effects', effects, '--device', device
  ] }
}

export async function buildFaceWorkerCommand(
  pack: FacePack,
  canvas: ProjectCanvas,
  effects: string
): Promise<FaceCommand> {
  if (process.env.otc_CPU_ONLY === '1') return nativeFaceWorkerCommand(pack, canvas, effects, 'CPU')
  const restrictedNode = await restrictedIntelRenderNode()
  const autoCommand = nativeFaceWorkerCommand(pack, canvas, effects, 'AUTO')
  if (!restrictedNode) return autoCommand
  return {
    executable: pkexecPath,
    args: ['--disable-internal-agent', autoCommand.executable, ...autoCommand.args],
    elevated: true
  }
}
