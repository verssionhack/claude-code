import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearSystemPromptSectionState,
  getRenderedSystemPrompt,
  resetStateForTests,
  setOriginalCwd,
  setProjectRoot,
  setRenderedSystemPrompt,
} from '../bootstrap/state'
import {
  getSystemContext,
  getUserContext,
  setPersistedPromptContext,
  setSystemPromptInjection,
} from '../context'
import { clearMemoryFileCaches } from '../utils/claudemd'
import {
  cleanupTempDir,
  createTempDir,
  writeTempFile,
} from '../../tests/mocks/file-system'

let tempDir = ''
let projectClaudeMdContent = ''

beforeEach(async () => {
  tempDir = await createTempDir('context-baseline-')
  projectClaudeMdContent = `baseline-${Date.now()}`

  resetStateForTests()
  setOriginalCwd(tempDir)
  setProjectRoot(tempDir)
  await writeTempFile(tempDir, 'CLAUDE.md', projectClaudeMdContent)

  clearMemoryFileCaches()
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  setSystemPromptInjection(null)
  delete process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS
})

afterEach(async () => {
  clearMemoryFileCaches()
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  setSystemPromptInjection(null)
  delete process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS
  resetStateForTests()
  if (tempDir) {
    await cleanupTempDir(tempDir)
  }
})

describe('context baseline', () => {
  test('getUserContext includes currentDate and project CLAUDE.md content', async () => {
    const ctx = await getUserContext()

    expect(ctx.currentDate).toContain("Today's date is")
    expect(ctx.claudeMd).toContain(projectClaudeMdContent)
  })

  test('CLAUDE_CODE_DISABLE_CLAUDE_MDS suppresses claudeMd loading', async () => {
    process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'

    const ctx = await getUserContext()

    expect(ctx.currentDate).toContain("Today's date is")
    expect(ctx.claudeMd).toBeUndefined()
  })

  test('setSystemPromptInjection clears the memoized user-context cache', async () => {
    const first = await getUserContext()
    process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'

    const second = await getUserContext()
    expect(first.claudeMd).toContain(projectClaudeMdContent)
    expect(second.claudeMd).toContain(projectClaudeMdContent)

    setSystemPromptInjection('cache-break')

    const third = await getUserContext()
    expect(third.claudeMd).toBeUndefined()
  })

  test('getSystemContext reflects system prompt injection after cache invalidation', async () => {
    const first = await getSystemContext()
    expect(first.gitStatus).toBeUndefined()
    expect(first.cacheBreaker).toBeUndefined()

    setSystemPromptInjection('baseline-cache-break')

    const second = await getSystemContext()
    if ('cacheBreaker' in second) {
      expect(second.cacheBreaker).toContain('baseline-cache-break')
    } else {
      expect(second.gitStatus).toBeUndefined()
    }
  })

  test('the rendered system prompt is reused until a render point', () => {
    const parts = ['leading-a', 'leading-b']
    setRenderedSystemPrompt(parts, 'server-a')
    // Copies: a caller mutating its own array cannot rewrite the cached prefix.
    parts.push('later')
    expect(getRenderedSystemPrompt()).toEqual({
      parts: ['leading-a', 'leading-b'],
      mcpKey: 'server-a',
    })

    clearSystemPromptSectionState()
    expect(getRenderedSystemPrompt()).toBeNull()
  })

  test('swapping the persisted context drops the rendered system prompt', () => {
    setRenderedSystemPrompt(['stale'], '')

    setPersistedPromptContext({})

    expect(getRenderedSystemPrompt()).toBeNull()
  })
})
