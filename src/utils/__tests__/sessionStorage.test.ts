import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_CACHED_ENTRIES = 200 // mirrors MAX_CACHED_SESSION_FILES in sessionStorage.ts

const {
  getSessionMessages,
  getSessionMessagesCache,
  clearSessionMessagesCache,
  getLastSessionLog,
  getTranscriptPathForSession,
  loadTranscriptFile,
  loadTranscriptFromFile,
  resolvePromptCwd,
} = await import('../sessionStorage.js')

function asUuid(s: string): any {
  return s as unknown as any
}

let tempDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  // `getProjectsDir()` returns `${CLAUDE_CONFIG_DIR}/projects`, and
  // loadSessionFile reads from `${getProjectsDir()}/${sessionId}.jsonl`.
  // Pre-create the projects subdir so writeFileSync doesn't fail.
  mkdirSync(join(tempDir, 'projects'), { recursive: true })
  // Pin session-file lookups to a temp dir via CLAUDE_CONFIG_DIR.
  // Restoring in afterEach keeps tests hermetic.
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(() => {
  clearSessionMessagesCache()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function sessionFilePath(sessionId: string): string {
  // Mirror sessionStorage.ts's path computation:
  //   getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  // With CLAUDE_CONFIG_DIR=tempDir and getSessionProjectDir() returning
  // null in tests, files live at `${tempDir}/projects/${sessionId}.jsonl`.
  return join(tempDir, 'projects', `${sessionId}.jsonl`)
}

describe('getSessionMessagesCache', () => {
  test('returns the same Map instance across calls', () => {
    // Cache identity must be stable — `getLastSessionLog` uses
    // `getSessionMessagesCache()` directly to prime entries, so a
    // different instance each call would break that priming.
    expect(getSessionMessagesCache()).toBe(getSessionMessagesCache())
  })

  test('clearSessionMessagesCache empties a populated cache', async () => {
    const cache = getSessionMessagesCache()
    writeFileSync(sessionFilePath('id-1'), '')
    writeFileSync(sessionFilePath('id-2'), '')
    await getSessionMessages(asUuid('id-1'))
    await getSessionMessages(asUuid('id-2'))
    expect(cache.size).toBeGreaterThan(0)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('clearSessionMessagesCache is a no-op on empty cache', () => {
    const cache = getSessionMessagesCache()
    expect(cache.size).toBe(0)
    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('getSessionMessages dedups concurrent calls for the same sessionId', async () => {
    const cache = getSessionMessagesCache()
    const id = asUuid('same-id')
    writeFileSync(sessionFilePath('same-id'), '')
    const [a, b, c] = await Promise.all([
      getSessionMessages(id),
      getSessionMessages(id),
      getSessionMessages(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(cache.size).toBe(1)
  })
})

describe('getSessionMessages bounded cache (memory leak fix)', () => {
  test('cache size stays at MAX_CACHED_ENTRIES after many distinct sessionIds', async () => {
    // Bounded cache — calling getSessionMessages with N distinct
    // sessionIds must NOT grow the cache beyond MAX_CACHED_ENTRIES.
    // Pre-fix: lodash memoize grew unbounded. Post-fix: Map-based
    // cache evicts oldest entry when at capacity.
    const cache = getSessionMessagesCache()
    const total = MAX_CACHED_ENTRIES * 3 // 600 distinct sessionIds
    for (let i = 0; i < total; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })

  test('FIFO eviction: oldest entry is removed first', async () => {
    // Fill cache to MAX with sequential ids. The first inserted
    // (`oldest`) should be evicted on the (MAX+1)th insertion.
    const cache = getSessionMessagesCache()
    const oldestId = asUuid('id-0')
    writeFileSync(sessionFilePath('id-0'), '')
    await getSessionMessages(oldestId)
    for (let i = 1; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(true)

    writeFileSync(sessionFilePath('id-overflow'), '')
    await getSessionMessages(asUuid('id-overflow'))
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(false)
  })

  test('cleared cache can be refilled without leaking entries', async () => {
    const cache = getSessionMessagesCache()
    for (let i = 0; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)

    for (let i = 0; i < MAX_CACHED_ENTRIES + 5; i++) {
      writeFileSync(sessionFilePath(`refill-${i}`), '')
      await getSessionMessages(asUuid(`refill-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })
})

describe('resolvePromptCwd', () => {
  const message = (cwd: string): any => ({ type: 'user', cwd })
  const boundary = (cwd: string): any => ({
    type: 'system',
    subtype: 'compact_boundary',
    cwd,
  })

  test('persisted prompt-cwd wins over transcript evidence', () => {
    expect(resolvePromptCwd([message('/launch')], '/persisted')).toBe(
      '/persisted',
    )
  })

  test('uses the last compact boundary cwd, not the shell tail', () => {
    // A `cd` after the last prompt render stamps later entries with /tail;
    // the prompt itself still carries the post-compact /tools cwd.
    expect(
      resolvePromptCwd([
        message('/launch'),
        boundary('/tools'),
        message('/tail'),
      ]),
    ).toBe('/tools')
  })

  test('falls back to the first entry without a compact boundary', () => {
    expect(resolvePromptCwd([message('/launch'), message('/tail')])).toBe(
      '/launch',
    )
  })

  test('skips entries without a non-empty cwd', () => {
    expect(
      resolvePromptCwd([{ type: 'user' } as any, message(''), message('/x')]),
    ).toBe('/x')
  })

  test('returns undefined for an empty transcript', () => {
    expect(resolvePromptCwd([])).toBeUndefined()
  })
})

describe('prompt-cwd transcript entries', () => {
  const sid = '11111111-1111-4111-8111-111111111111'

  test('last entry wins and is returned by loadTranscriptFile', async () => {
    const file = join(tempDir, 'prompt-cwd.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'prompt-cwd',
          sessionId: sid,
          promptCwd: '/one',
        }),
        JSON.stringify({
          type: 'prompt-cwd',
          sessionId: sid,
          promptCwd: '/two',
        }),
        '',
      ].join('\n'),
    )
    const loaded = await loadTranscriptFile(file)
    expect(loaded.promptCwds.get(sid as any)).toBe('/two')
  })

  test('entries are keyed by sessionId', async () => {
    const otherSid = '22222222-2222-4222-8222-222222222222'
    const file = join(tempDir, 'prompt-cwd-sessions.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'prompt-cwd', sessionId: sid, promptCwd: '/a' }),
        JSON.stringify({
          type: 'prompt-cwd',
          sessionId: otherSid,
          promptCwd: '/b',
        }),
        '',
      ].join('\n'),
    )
    const loaded = await loadTranscriptFile(file)
    expect(loaded.promptCwds.get(sid as any)).toBe('/a')
    expect(loaded.promptCwds.get(otherSid as any)).toBe('/b')
  })
})

describe('prompt-context / skill-listing metadata', () => {
  const sid = '55555555-5555-4555-8555-555555555555'
  const otherSid = '66666666-6666-4666-8666-666666666666'
  const messageUuid = '77777777-7777-4777-8777-777777777777'

  test('entries are keyed by sessionId', async () => {
    const file = join(tempDir, 'prompt-context.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'prompt-context',
          sessionId: sid,
          promptProjectRoot: '/a',
          systemPromptSections: [['env_info_simple', 'rendered']],
          userContext: { currentDate: 'date-a' },
          systemContext: { gitStatus: 'git-a' },
        }),
        JSON.stringify({
          type: 'prompt-context',
          sessionId: otherSid,
          promptProjectRoot: '/b',
          systemPromptSections: [],
          userContext: {},
          systemContext: {},
        }),
        JSON.stringify({
          type: 'skill-listing',
          sessionId: sid,
          content: 'listing-a',
          skillCount: 2,
        }),
        JSON.stringify({
          type: 'skill-listing',
          sessionId: otherSid,
          content: 'listing-b',
          skillCount: 1,
        }),
        '',
      ].join('\n'),
    )
    const loaded = await loadTranscriptFile(file)
    expect(loaded.promptContexts.get(sid as any)?.promptProjectRoot).toBe('/a')
    expect(loaded.promptContexts.get(otherSid as any)?.promptProjectRoot).toBe(
      '/b',
    )
    expect(loaded.skillListings.get(sid as any)?.content).toBe('listing-a')
    expect(loaded.skillListings.get(otherSid as any)?.content).toBe('listing-b')
  })

  test('loaders carry promptContext and skillListing through', async () => {
    const file = getTranscriptPathForSession(sid)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          uuid: messageUuid,
          parentUuid: null,
          isSidechain: false,
          sessionId: sid,
          cwd: '/tail',
          timestamp: new Date().toISOString(),
          userType: 'external',
          version: '0.0.0',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'prompt-context',
          sessionId: sid,
          promptProjectRoot: '/project',
          systemPromptSections: [['memory', 'memory-section']],
          userContext: { currentDate: 'date-x' },
          systemContext: { gitStatus: 'snapshot' },
          renderedSystemPrompt: ['leading-a', 'leading-b'],
          renderedSystemPromptMcpKey: 'server-a',
        }),
        JSON.stringify({
          type: 'skill-listing',
          sessionId: sid,
          content: 'skills-content',
          skillCount: 3,
        }),
        '',
      ].join('\n'),
    )

    const log = await getLastSessionLog(asUuid(sid))
    expect(log?.promptContext?.promptProjectRoot).toBe('/project')
    expect(log?.promptContext?.userContext.currentDate).toBe('date-x')
    expect(log?.promptContext?.renderedSystemPrompt).toEqual([
      'leading-a',
      'leading-b',
    ])
    expect(log?.promptContext?.renderedSystemPromptMcpKey).toBe('server-a')
    expect(log?.skillListing?.content).toBe('skills-content')
    expect(log?.skillListing?.skillCount).toBe(3)

    const fromFile = await loadTranscriptFromFile(file)
    expect(fromFile.promptContext?.systemContext.gitStatus).toBe('snapshot')
    expect(fromFile.promptContext?.renderedSystemPrompt).toEqual([
      'leading-a',
      'leading-b',
    ])
    expect(fromFile.promptContext?.renderedSystemPromptMcpKey).toBe('server-a')
    expect(fromFile.skillListing?.content).toBe('skills-content')
  })
})

describe('prompt-cwd propagation through LogOption loaders', () => {
  const sid = '33333333-3333-4333-8333-333333333333'
  const messageUuid = '44444444-4444-4444-8444-444444444444'

  function writeTranscript(): string {
    // getLastSessionLog resolves the path via getProjectDir(originalCwd);
    // compute it the same way instead of guessing the projects layout.
    const file = getTranscriptPathForSession(sid)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          uuid: messageUuid,
          parentUuid: null,
          isSidechain: false,
          sessionId: sid,
          cwd: '/tail',
          timestamp: new Date().toISOString(),
          userType: 'external',
          version: '0.0.0',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'prompt-cwd',
          sessionId: sid,
          promptCwd: '/rendered',
        }),
        '',
      ].join('\n'),
    )
    return file
  }

  test('getLastSessionLog carries the persisted prompt cwd', async () => {
    writeTranscript()
    const log = await getLastSessionLog(asUuid(sid))
    expect(log?.promptCwd).toBe('/rendered')
  })

  test('loadTranscriptFromFile carries the persisted prompt cwd', async () => {
    const file = writeTranscript()
    const log = await loadTranscriptFromFile(file)
    expect(log.promptCwd).toBe('/rendered')
  })
})
