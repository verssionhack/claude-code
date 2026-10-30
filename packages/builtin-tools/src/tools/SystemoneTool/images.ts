import { readFile, stat } from 'node:fs/promises'
import { AbortError, errorMessage } from 'src/utils/errors.js'
import { formatFileSize } from 'src/utils/format.js'
import { expandPath } from 'src/utils/path.js'
import {
  SYSTEMONE_MAX_ENCODED_IMAGE_BYTES,
  SYSTEMONE_MAX_IMAGE_BYTES,
} from './constants.js'

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// Data URLs are passed through for the server to decode; only local files are
// sniffed, because the tool is the one introducing those bytes.
const DATA_URL_PATTERN =
  /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i

const IMAGE_FORMATS = 'PNG, JPEG, GIF, or WebP'

export function isDataUrl(source: string): boolean {
  return source.trim().startsWith('data:')
}

export function expandImageSource(source: string): string {
  return isDataUrl(source) ? source : expandPath(source)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

export function sniffImageMime(bytes: Uint8Array): ImageMime | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    ascii(bytes, 0, 3) === 'GIF' &&
    (ascii(bytes, 3, 6) === '87a' || ascii(bytes, 3, 6) === '89a')
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

function normalizeDataUrl(source: string): string {
  const compact = source.trim().replace(/\s+/g, '')
  if (!DATA_URL_PATTERN.test(compact)) {
    throw new Error(
      'Image data URLs must be base64 image data (data:image/<type>;base64,...)',
    )
  }
  if (compact.length > SYSTEMONE_MAX_ENCODED_IMAGE_BYTES) {
    throw new Error(
      `Image data URL exceeds the ${formatFileSize(SYSTEMONE_MAX_ENCODED_IMAGE_BYTES)} encoded limit`,
    )
  }
  return compact
}

async function encodeImageFile(source: string): Promise<string> {
  const path = expandPath(source)
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      throw new Error(`Image path is not a file: "${source}"`)
    }
    size = info.size
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Image path is not a file')
    ) {
      throw error
    }
    throw new Error(
      `Cannot read image file "${source}": ${errorMessage(error)}`,
    )
  }
  if (size > SYSTEMONE_MAX_IMAGE_BYTES) {
    throw new Error(
      `Image file "${source}" is ${formatFileSize(size)}; the limit is ${formatFileSize(SYSTEMONE_MAX_IMAGE_BYTES)}`,
    )
  }
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(
      `Cannot read image file "${source}": ${errorMessage(error)}`,
    )
  }
  const mime = sniffImageMime(bytes)
  if (mime === undefined) {
    throw new Error(
      `Unsupported image format for "${source}"; use ${IMAGE_FORMATS}`,
    )
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * Turn image arguments into data URLs. A source is either a data URL or a
 * local file path, which the tool reads and encodes itself so the model never
 * has to emit base64.
 */
export async function resolveImageSources(
  sources: string[] | undefined,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (sources === undefined) {
    return undefined
  }
  const resolved: string[] = []
  let encodedBytes = 0
  for (const source of sources) {
    if (signal?.aborted) {
      throw new AbortError()
    }
    const dataUrl = isDataUrl(source)
      ? normalizeDataUrl(source)
      : await encodeImageFile(source)
    encodedBytes += dataUrl.length
    if (encodedBytes > SYSTEMONE_MAX_ENCODED_IMAGE_BYTES) {
      throw new Error(
        `Images exceed the ${formatFileSize(SYSTEMONE_MAX_ENCODED_IMAGE_BYTES)} encoded limit`,
      )
    }
    resolved.push(dataUrl)
  }
  return resolved
}
