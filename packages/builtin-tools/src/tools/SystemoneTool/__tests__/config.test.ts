import { describe, expect, test } from 'bun:test'

import { resolveSystemoneEndpoint, systemoneTimeoutMs } from '../config.js'
import {
  SYSTEMONE_DEFAULT_TIMEOUT_MS,
  SYSTEMONE_MAX_TIMEOUT_MS,
} from '../constants.js'

describe('resolveSystemoneEndpoint', () => {
  test('an explicit full URL wins and uses the explicit key', () => {
    const endpoint = resolveSystemoneEndpoint({
      provider: 'firstParty',
      explicitUrl: 'http://example.test/custom/systemone',
      explicitApiKey: 'explicit',
      anthropicBaseUrl: 'http://127.0.0.1:9000',
      anthropicApiKey: 'session',
    })
    expect(endpoint.source).toBe('override')
    expect(endpoint.url).toBe('http://example.test/custom/systemone')
    expect(endpoint.auth).toEqual({ Authorization: 'Bearer explicit' })
  })

  test('an explicit base appends the systemone path, respecting a trailing /v1', () => {
    expect(
      resolveSystemoneEndpoint({
        provider: 'firstParty',
        explicitBase: 'http://systemone.test',
      }).url,
    ).toBe('http://systemone.test/v1/systemone')
    expect(
      resolveSystemoneEndpoint({
        provider: 'firstParty',
        explicitBase: 'http://systemone.test/v1/',
      }).url,
    ).toBe('http://systemone.test/v1/systemone')
    expect(
      resolveSystemoneEndpoint({
        provider: 'firstParty',
        explicitBase: 'http://systemone.test/base',
      }).url,
    ).toBe('http://systemone.test/base/v1/systemone')
  })

  test('defaults to the /login private OpenAI endpoint when the active model server is public', () => {
    // This is the box's real shape: Anthropic-compatible DeepSeek is active,
    // while the local ninfer is configured as the OpenAI endpoint.
    const endpoint = resolveSystemoneEndpoint({
      provider: 'firstParty',
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      anthropicAuthToken: 'deepseek-token',
      openaiBaseUrl: 'http://10.42.0.2:8080/v1',
      openaiApiKey: 'ninfer-key',
    })
    expect(endpoint.source).toBe('session')
    expect(endpoint.url).toBe('http://10.42.0.2:8080/v1/systemone')
    expect(endpoint.auth).toEqual({ Authorization: 'Bearer ninfer-key' })
  })

  test('prefers the active provider when its server is private', () => {
    const endpoint = resolveSystemoneEndpoint({
      provider: 'openai',
      anthropicBaseUrl: 'http://127.0.0.1:9000',
      anthropicApiKey: 'anthropic-key',
      openaiBaseUrl: 'http://192.168.1.20:8080/v1',
      openaiApiKey: 'openai-key',
    })
    expect(endpoint.url).toBe('http://192.168.1.20:8080/v1/systemone')
    expect(endpoint.auth).toEqual({ Authorization: 'Bearer openai-key' })
  })

  test('uses the session Anthropic credentials for a private first-party server', () => {
    const bearer = resolveSystemoneEndpoint({
      provider: 'firstParty',
      anthropicBaseUrl: 'http://127.0.0.1:9000',
      anthropicAuthToken: 'auth-token',
      anthropicApiKey: 'api-key',
    })
    expect(bearer.url).toBe('http://127.0.0.1:9000/v1/systemone')
    expect(bearer.auth).toEqual({ Authorization: 'Bearer auth-token' })

    const key = resolveSystemoneEndpoint({
      provider: 'firstParty',
      anthropicBaseUrl: 'http://gpu-box:9000',
      anthropicApiKey: 'api-key',
    })
    expect(key.url).toBe('http://gpu-box:9000/v1/systemone')
    expect(key.auth).toEqual({ 'x-api-key': 'api-key' })
  })

  test('falls back to loopback for public or missing session endpoints', () => {
    const publicOnly = resolveSystemoneEndpoint({
      provider: 'firstParty',
      anthropicBaseUrl: 'https://api.anthropic.com',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiApiKey: 'public',
    })
    expect(publicOnly.source).toBe('default')
    expect(publicOnly.url).toBe('http://127.0.0.1:8080/v1/systemone')
    expect(publicOnly.auth).toEqual({})

    const missing = resolveSystemoneEndpoint({ provider: 'firstParty' })
    expect(missing.source).toBe('default')
    expect(missing.url).toBe('http://127.0.0.1:8080/v1/systemone')
  })

  test('an explicit key still authorizes the fallback endpoint', () => {
    const endpoint = resolveSystemoneEndpoint({
      provider: 'firstParty',
      explicitApiKey: 'secret',
    })
    expect(endpoint.url).toBe('http://127.0.0.1:8080/v1/systemone')
    expect(endpoint.auth).toEqual({ Authorization: 'Bearer secret' })
  })

  test('ignores non-http(s) and malformed bases', () => {
    const endpoint = resolveSystemoneEndpoint({
      provider: 'firstParty',
      anthropicBaseUrl: 'file:///etc/passwd',
      openaiBaseUrl: 'not a url',
    })
    expect(endpoint.source).toBe('default')
  })
})

describe('systemoneTimeoutMs', () => {
  test('defaults, clamps, and replays a valid override', () => {
    expect(systemoneTimeoutMs(undefined)).toBe(SYSTEMONE_DEFAULT_TIMEOUT_MS)
    expect(systemoneTimeoutMs('abc')).toBe(SYSTEMONE_DEFAULT_TIMEOUT_MS)
    expect(systemoneTimeoutMs('1')).toBe(1_000)
    expect(systemoneTimeoutMs('9999999')).toBe(SYSTEMONE_MAX_TIMEOUT_MS)
    expect(systemoneTimeoutMs('45000')).toBe(45_000)
  })
})
