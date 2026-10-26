import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AbortError } from 'src/utils/errors.js'
import { SYSTEMONE_MAX_STATE_BYTES } from '../constants.js'
import { expandStateSource, readStateFile } from '../state.js'

let dir: string
let contextPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'systemone-state-'))
  contextPath = join(dir, 'context.txt')
  await writeFile(contextPath, 'The report is positive.\nRevenue grew 20%.\n')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readStateFile', () => {
  test('reads the exact file text', async () => {
    expect(await readStateFile(contextPath)).toBe(
      'The report is positive.\nRevenue grew 20%.\n',
    )
  })

  test('expands a home-relative path', () => {
    expect(expandStateSource('~/context.txt').startsWith('/')).toBe(true)
  })

  test('rejects missing paths, directories, and oversized files', async () => {
    await expect(readStateFile(join(dir, 'missing.txt'))).rejects.toThrow(
      'Cannot read state file',
    )
    await expect(readStateFile(dir)).rejects.toThrow('not a file')

    const big = join(dir, 'big.txt')
    await writeFile(big, '')
    await truncate(big, SYSTEMONE_MAX_STATE_BYTES + 1)
    await expect(readStateFile(big)).rejects.toThrow('limit is')
  })

  test('honors an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      readStateFile(contextPath, controller.signal),
    ).rejects.toBeInstanceOf(AbortError)
  })
})
