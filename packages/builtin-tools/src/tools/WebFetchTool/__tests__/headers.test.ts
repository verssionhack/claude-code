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

type MockAxiosResponse = {
  data: ArrayBuffer
  headers: Record<string, unknown>
  status: number
  statusText: string
}

type MockAxiosError = Error & {
  isAxiosError: true
  response?: {
    headers: Record<string, unknown>
    status: number
  }
}

let getMock: (url: string) => Promise<MockAxiosResponse>

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = (url: string) => getMock(url)
axiosHandle.stubs.isAxiosError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { isAxiosError?: unknown }).isAxiosError === true

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

mock.module('src/services/api/claude.js', () => ({
  queryHaiku: async () => ({ message: { content: [] } }),
}))

// Must register before the real settings/http modules are evaluated, so the
// real modules load cleanly in any file order (their import chains reach
// bun:bundle and debug.ts).
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: (_name: string) => false }))

// Provide every runtime export of src/utils/http.js: modules further
// down the chain (e.g. the real API client, loaded via the claude.js
// mock merge) link bindings like getUserAgent against this mocked
// namespace during circular initialization, and a partial namespace
// breaks the whole test process.
mock.module('src/utils/http.js', () => ({
  getUserAgent: () => 'claude-code/test',
  getMCPUserAgent: () => 'claude-code/test',
  getWebFetchUserAgent: () => 'TestAgent/1.0',
  getAuthHeaders: () => ({}) as Record<string, string>,
  withOAuth401Retry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))

mock.module('src/utils/mcpOutputStorage.js', () => ({
  isBinaryContentType: (contentType: string) =>
    !contentType.toLowerCase().startsWith('text/'),
  persistBinaryContent: async () => ({
    filepath: '/tmp/webfetch-test.bin',
    size: 0,
  }),
}))

// Cache the real settings exports before registering the mock so the
// factory can spread them: the settings module has a circular import
// (settings → types → pluginOnlyPolicy → settings), and a partial mock
// namespace breaks that circular link for the rest of the test process.
const realSettingsExports = await import('src/utils/settings/settings.js')

mock.module('src/utils/settings/settings.js', () => ({
  ...realSettingsExports,
  getInitialSettings: () => ({}),
  getSettings_DEPRECATED: () => ({ skipWebFetchPreflight: true }),
}))

beforeEach(() => {
  getMock = async () => ({
    data: new TextEncoder().encode('hello').buffer,
    headers: { 'content-type': 'text/plain' },
    status: 200,
    statusText: 'OK',
  })
})

beforeAll(() => {
  axiosHandle.useStubs = true
})

afterAll(() => {
  axiosHandle.useStubs = false
})

describe('WebFetch response headers', () => {
  test('reads redirect Location from AxiosHeaders-style get()', async () => {
    getMock = async () => {
      const error = new Error('redirect') as MockAxiosError
      error.isAxiosError = true
      error.response = {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location' ? '/next' : undefined,
        },
        status: 302,
      }
      throw error
    }

    const { getWithPermittedRedirects } = await import('../utils')
    const result = await getWithPermittedRedirects(
      'https://example.com/old',
      new AbortController().signal,
      () => false,
    )

    expect(result).toEqual({
      type: 'redirect',
      originalUrl: 'https://example.com/old',
      redirectUrl: 'https://example.com/next',
      statusCode: 302,
    })
  })

  test('reads proxy block markers from normalized headers', async () => {
    getMock = async () => {
      const error = new Error('blocked') as MockAxiosError
      error.isAxiosError = true
      error.response = {
        headers: { 'x-proxy-error': 'blocked-by-allowlist' },
        status: 403,
      }
      throw error
    }

    const { getWithPermittedRedirects } = await import('../utils')

    await expect(
      getWithPermittedRedirects(
        'https://blocked.example/path',
        new AbortController().signal,
        () => false,
      ),
    ).rejects.toThrow('EGRESS_BLOCKED')
  })

  test('normalizes array content-type before cache and parsing', async () => {
    getMock = async () => ({
      data: new TextEncoder().encode('plain body').buffer,
      headers: { 'content-type': ['text/plain', 'charset=utf-8'] },
      status: 200,
      statusText: 'OK',
    })

    const { clearWebFetchCache, getURLMarkdownContent } = await import(
      '../utils'
    )
    clearWebFetchCache()

    const result = await getURLMarkdownContent(
      'https://example.com/plain.txt',
      new AbortController(),
    )

    expect('type' in result).toBe(false)
    if ('type' in result) {
      throw new Error('unexpected redirect result')
    }
    expect(result.content).toBe('plain body')
    expect(result.contentType).toBe('text/plain, charset=utf-8')
  })
})
