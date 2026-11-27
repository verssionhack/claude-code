import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'

type MockPostResponse = {
  data: unknown
  headers: Record<string, unknown>
  status: number
  statusText: string
}

let postMock: (
  url: string,
  data: unknown,
  config: unknown,
) => Promise<MockPostResponse>

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.post = (url: string, data: unknown, config: unknown) =>
  postMock(url, data, config)
axiosHandle.stubs.isAxiosError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { isAxiosError?: unknown }).isAxiosError === true

// Must register before anything that pulls in bootstrap/state / settings.
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: (_name: string) => false }))

const realAnalyticsExports = await import('src/services/analytics/index.js')
mock.module('src/services/analytics/index.ts', () => ({
  ...realAnalyticsExports,
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

const realClaudeExports = await import('src/services/api/claude.js')
mock.module('src/services/api/claude.ts', () => ({
  ...realClaudeExports,
  queryHaiku: async () => ({ message: { content: [] } }),
}))

const realHttpExports = await import('src/utils/http.js')
mock.module('src/utils/http.ts', () => ({
  ...realHttpExports,
  getUserAgent: () => 'claude-code/test',
  getMCPUserAgent: () => 'claude-code/test',
  getWebFetchUserAgent: () => 'TestAgent/1.0',
  getAuthHeaders: () => ({ headers: {} }),
  withOAuth401Retry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))

const realMcpStorageExports = await import('src/utils/mcpOutputStorage.js')
mock.module('src/utils/mcpOutputStorage.ts', () => ({
  ...realMcpStorageExports,
  isBinaryContentType: (contentType: string) =>
    !contentType.toLowerCase().startsWith('text/'),
  persistBinaryContent: async () => ({
    filepath: '/tmp/webfetch-test.bin',
    size: 0,
  }),
}))

const realSettingsExports = await import('src/utils/settings/settings.js')
mock.module('src/utils/settings/settings.ts', () => ({
  ...realSettingsExports,
  getSettings_DEPRECATED: () => ({}),
}))

beforeEach(async () => {
  const { clearWebFetchCache } = await import('../utils')
  clearWebFetchCache()
})

beforeAll(() => {
  postMock = url =>
    Promise.resolve({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { results: [] },
    })
  axiosHandle.useStubs = true
})

afterAll(() => {
  axiosHandle.useStubs = false
})

const GNOME_SEARCH_URL = 'https://extensions.gnome.org/extensions/?query=mosaic'

describe('tavilyExtractFailureReason', () => {
  test('prefers the failed_results entry matching the URL', async () => {
    const { tavilyExtractFailureReason } = await import('../utils')
    expect(
      tavilyExtractFailureReason(
        {
          results: [],
          failed_results: [
            { url: 'https://other.example/x', error: 'boom' },
            { url: GNOME_SEARCH_URL, error: '404 page not found' },
          ],
        },
        GNOME_SEARCH_URL,
      ),
    ).toBe('404 page not found')
  })

  test('falls back to a single failed_results entry without a URL match', async () => {
    const { tavilyExtractFailureReason } = await import('../utils')
    expect(
      tavilyExtractFailureReason(
        { results: [], failed_results: [{ error: 'timed out' }] },
        GNOME_SEARCH_URL,
      ),
    ).toBe('timed out')
  })

  test('falls back to results[].error then top-level error/message', async () => {
    const { tavilyExtractFailureReason } = await import('../utils')
    expect(
      tavilyExtractFailureReason(
        { results: [{ error: 'blocked by bot filter' }] },
        GNOME_SEARCH_URL,
      ),
    ).toBe('blocked by bot filter')
    expect(
      tavilyExtractFailureReason({ error: 'internal error' }, GNOME_SEARCH_URL),
    ).toBe('internal error')
    expect(
      tavilyExtractFailureReason({ message: 'rate limited' }, GNOME_SEARCH_URL),
    ).toBe('rate limited')
  })

  test('returns undefined when the endpoint reported nothing', async () => {
    const { tavilyExtractFailureReason } = await import('../utils')
    expect(tavilyExtractFailureReason({ results: [] }, GNOME_SEARCH_URL)).toBe(
      undefined,
    )
    expect(tavilyExtractFailureReason(undefined, GNOME_SEARCH_URL)).toBe(
      undefined,
    )
  })
})

describe('fetchContentWithTavily failure messages', () => {
  test('surfaces the endpoint-reported reason for a failed extraction', async () => {
    postMock = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          results: [],
          failed_results: [
            { url: GNOME_SEARCH_URL, error: '404 page not found' },
          ],
        },
      })

    const { fetchContentWithTavily } = await import('../utils')

    await expect(
      fetchContentWithTavily(GNOME_SEARCH_URL, new AbortController()),
    ).rejects.toThrow('404 page not found')
  })

  test('keeps the URL in the reason-less error', async () => {
    postMock = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { results: [] },
      })

    const { fetchContentWithTavily } = await import('../utils')

    await expect(
      fetchContentWithTavily(
        'https://empty.example/page',
        new AbortController(),
      ),
    ).rejects.toThrow('https://empty.example/page')
  })

  test('still delivers content via results[].raw_content', async () => {
    postMock = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          results: [{ url: 'https://ok.example/page', raw_content: '# Title' }],
        },
      })

    const { fetchContentWithTavily } = await import('../utils')

    const result = await fetchContentWithTavily(
      'https://ok.example/page',
      new AbortController(),
    )
    if ('type' in result) {
      throw new Error('unexpected redirect result')
    }
    expect(result.content).toBe('# Title')
  })
})
