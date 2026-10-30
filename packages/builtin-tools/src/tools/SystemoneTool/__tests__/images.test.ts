import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AbortError } from 'src/utils/errors.js'
import {
  expandImageSource,
  isDataUrl,
  resolveImageSources,
  sniffImageMime,
} from '../images.js'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = Buffer.from('GIF89a______')
const WEBP = Buffer.from('RIFF____WEBP')

let dir: string
let pngPath: string
let jpegPath: string
let textPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'systemone-images-'))
  pngPath = join(dir, 'red.png')
  jpegPath = join(dir, 'photo.jpg')
  textPath = join(dir, 'note.txt')
  await writeFile(pngPath, PNG)
  await writeFile(jpegPath, JPEG)
  await writeFile(textPath, 'not an image')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sniffImageMime', () => {
  test('recognizes PNG, JPEG, GIF, and WebP', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(GIF)).toBe('image/gif')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
  })

  test('rejects other bytes', () => {
    expect(sniffImageMime(Buffer.from('hello world'))).toBeUndefined()
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined()
  })
})

describe('image sources', () => {
  test('tells data URLs apart from paths and expands paths', () => {
    expect(isDataUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isDataUrl(' ./image.png ')).toBe(false)
    expect(expandImageSource('~/image.png').startsWith('/')).toBe(true)
    expect(expandImageSource('data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA',
    )
  })

  test('reads local files and encodes them by sniffed type', async () => {
    const [png, jpeg] = (await resolveImageSources([pngPath, jpegPath])) ?? []
    expect(png).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(jpeg).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`)
  })

  test('passes valid data URLs through and compacts whitespace', async () => {
    const source = `data:image/png;base64,${PNG.toString('base64')}`
    expect(await resolveImageSources([source])).toEqual([source])
    expect(
      await resolveImageSources([
        `data:image/png;base64,\n${PNG.toString('base64')}`,
      ]),
    ).toEqual([source])
  })

  test('rejects non-image and malformed data URLs', async () => {
    await expect(
      resolveImageSources([`data:text/plain;base64,${PNG.toString('base64')}`]),
    ).rejects.toThrow('data:image/<type>;base64')
    await expect(
      resolveImageSources(['data:image/png;base64,']),
    ).rejects.toThrow('data:image/<type>;base64')
    await expect(
      resolveImageSources([`data:image/png,${PNG.toString('base64')}`]),
    ).rejects.toThrow('data:image/<type>;base64')
  })

  test('rejects missing, non-file, and unsupported paths', async () => {
    await expect(
      resolveImageSources([join(dir, 'missing.png')]),
    ).rejects.toThrow('Cannot read image file')
    await expect(resolveImageSources([dir])).rejects.toThrow('not a file')
    await expect(resolveImageSources([textPath])).rejects.toThrow(
      'Unsupported image format',
    )
  })

  test('honors an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      resolveImageSources([pngPath], controller.signal),
    ).rejects.toBeInstanceOf(AbortError)
  })

  test('returns undefined when no images were requested', async () => {
    expect(await resolveImageSources(undefined)).toBeUndefined()
  })
})
