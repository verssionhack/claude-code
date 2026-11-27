import { readFile, stat } from 'node:fs/promises'
import { AbortError, errorMessage } from 'src/utils/errors.js'
import { formatFileSize } from 'src/utils/format.js'
import { expandPath } from 'src/utils/path.js'
import { SYSTEMONE_MAX_STATE_BYTES } from './constants.js'

export function expandStateSource(source: string): string {
  return expandPath(source)
}

/**
 * Read the context from a local file so the model only has to pass a path,
 * not copy the file's contents into a JSON argument.
 */
export async function readStateFile(
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new AbortError()
  }
  const path = expandPath(source)
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      throw new Error(`State path is not a file: "${source}"`)
    }
    size = info.size
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('State path is')) {
      throw error
    }
    throw new Error(
      `Cannot read state file "${source}": ${errorMessage(error)}`,
    )
  }
  if (size > SYSTEMONE_MAX_STATE_BYTES) {
    throw new Error(
      `State file "${source}" is ${formatFileSize(size)}; the limit is ${formatFileSize(SYSTEMONE_MAX_STATE_BYTES)}`,
    )
  }
  let content: string
  try {
    content = await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    if (signal?.aborted) {
      throw new AbortError()
    }
    throw new Error(
      `Cannot read state file "${source}": ${errorMessage(error)}`,
    )
  }
  const actualBytes = Buffer.byteLength(content, 'utf8')
  if (actualBytes > SYSTEMONE_MAX_STATE_BYTES) {
    throw new Error(
      `State file "${source}" is ${formatFileSize(actualBytes)}; the limit is ${formatFileSize(SYSTEMONE_MAX_STATE_BYTES)}`,
    )
  }
  return content
}
