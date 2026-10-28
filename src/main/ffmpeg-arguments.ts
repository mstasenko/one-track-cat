import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Linux limits each argv string, even when the total command fits ARG_MAX.
 * Keep large graphs in the existing private job directory; its owner removes
 * them on success, failure or cancellation along with the other scratch files. */
export async function prepareFfmpegArguments(args: string[], directory: string): Promise<string[]> {
  const prepared = [...args]
  for (let index = 0; index < prepared.length - 1; index += 1) {
    if (prepared[index] !== '-filter_complex') continue
    const graph = prepared[index + 1] ?? ''
    if (Buffer.byteLength(graph, 'utf8') < 32 * 1024) continue
    const path = join(directory, `filter-${randomUUID()}.txt`)
    await writeFile(path, graph, { mode: 0o600, flag: 'wx' })
    prepared[index] = '-filter_complex_script'
    prepared[index + 1] = path
    index += 1
  }
  return prepared
}
