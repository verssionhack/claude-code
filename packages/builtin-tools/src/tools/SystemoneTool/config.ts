import type { APIProvider } from 'src/utils/model/providerClassification.js'
import {
  SYSTEMONE_DEFAULT_BASE_URL,
  SYSTEMONE_DEFAULT_TIMEOUT_MS,
  SYSTEMONE_MAX_TIMEOUT_MS,
  SYSTEMONE_MIN_TIMEOUT_MS,
} from './constants.js'

export type SystemoneEndpointSource = 'override' | 'session' | 'default'

export interface SystemoneEndpointInput {
  explicitUrl?: string
  explicitBase?: string
  explicitApiKey?: string
  provider: APIProvider
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
  geminiBaseUrl?: string
  grokBaseUrl?: string
  anthropicAuthToken?: string
  anthropicApiKey?: string
  openaiApiKey?: string
  geminiApiKey?: string
  grokApiKey?: string
}

export interface SystemoneEndpoint {
  url: string
  auth: Record<string, string>
  source: SystemoneEndpointSource
}

function trim(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result ? result : undefined
}

function joinSystemonePath(base: string): string {
  const trimmed = base.trim()
  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/systemone')) {
      parsed.pathname = pathname
    } else if (pathname.endsWith('/v1') || pathname.endsWith('/v1beta')) {
      parsed.pathname = `${pathname}/systemone`
    } else {
      parsed.pathname = `${pathname}/v1/systemone`
    }
    return parsed.toString()
  } catch {
    const clean = trimmed.replace(/\/+$/, '')
    if (clean.endsWith('/systemone')) {
      return clean
    }
    if (clean.endsWith('/v1') || clean.endsWith('/v1beta')) {
      return `${clean}/systemone`
    }
    return `${clean}/v1/systemone`
  }
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === 'host.docker.internal' ||
    host.endsWith('.local')
  ) {
    return true
  }
  // Single-label LAN hostnames (docker service names, machine names).
  if (!host.includes('.') && !host.includes(':')) {
    return true
  }
  const parts = host.split('.')
  if (parts.length !== 4) {
    return false
  }
  const octets = parts.map(Number)
  if (!octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return false
  }
  const [a, b] = octets
  // Exclude 169.254.0.0/16 (link-local / cloud metadata endpoints like 169.254.169.254).
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}

function isOfficialHost(provider: APIProvider, hostname: string): boolean {
  const host = hostname.toLowerCase()
  switch (provider) {
    case 'openai':
      return host === 'api.openai.com' || host.endsWith('.api.openai.com')
    case 'firstParty':
      return (
        host === 'api.anthropic.com' || host === 'api-staging.anthropic.com'
      )
    case 'grok':
      return host === 'api.x.ai'
    case 'gemini':
      return host === 'generativelanguage.googleapis.com'
    default:
      return false
  }
}

function sessionAuth(
  provider: APIProvider,
  input: SystemoneEndpointInput,
): Record<string, string> {
  if (provider === 'openai') {
    const key = trim(input.openaiApiKey)
    return key ? { Authorization: `Bearer ${key}` } : {}
  }
  if (provider === 'grok') {
    const key = trim(input.grokApiKey)
    return key ? { Authorization: `Bearer ${key}` } : {}
  }
  if (provider === 'gemini') {
    const key = trim(input.geminiApiKey)
    return key ? { 'x-goog-api-key': key } : {}
  }
  if (provider === 'firstParty') {
    const token = trim(input.anthropicAuthToken)
    if (token) {
      return { Authorization: `Bearer ${token}` }
    }
    const key = trim(input.anthropicApiKey)
    return key ? { 'x-api-key': key } : {}
  }
  return {}
}

function providerBase(
  provider: APIProvider,
  input: SystemoneEndpointInput,
): string | undefined {
  switch (provider) {
    case 'firstParty':
      return trim(input.anthropicBaseUrl)
    case 'openai':
      return trim(input.openaiBaseUrl)
    case 'gemini':
      return trim(input.geminiBaseUrl)
    case 'grok':
      return trim(input.grokBaseUrl)
    default:
      return undefined
  }
}

/**
 * Resolve the Systemone endpoint.
 *
 * Explicit SYSTEMONE_URL / SYSTEMONE_BASE_URL win. Otherwise prefer the model
 * server configured through /login when it is a local/private endpoint, since
 * that is where a local ninfer instance lives; fall back to loopback. Public
 * provider hosts (Anthropic, OpenAI, DeepSeek, ...) are never used because they
 * do not serve /v1/systemone.
 */
export function resolveSystemoneEndpoint(
  input: SystemoneEndpointInput,
): SystemoneEndpoint {
  const explicitKey = trim(input.explicitApiKey)
  const explicitAuth: Record<string, string> = explicitKey
    ? { Authorization: `Bearer ${explicitKey}` }
    : {}

  const explicitUrl = trim(input.explicitUrl)
  if (explicitUrl && isValidHttpUrl(explicitUrl)) {
    return { url: explicitUrl, auth: explicitAuth, source: 'override' }
  }
  const explicitBase = trim(input.explicitBase)
  if (explicitBase && isValidHttpUrl(explicitBase)) {
    return {
      url: joinSystemonePath(explicitBase),
      auth: explicitAuth,
      source: 'override',
    }
  }

  const order: APIProvider[] = [
    input.provider,
    'openai',
    'firstParty',
    'grok',
    'gemini',
  ]
  const seen = new Set<string>()
  for (const provider of order) {
    if (seen.has(provider)) {
      continue
    }
    seen.add(provider)
    const base = providerBase(provider, input)
    if (base === undefined) {
      continue
    }
    let parsed: URL
    try {
      parsed = new URL(base)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      continue
    }
    if (isOfficialHost(provider, parsed.hostname)) {
      continue
    }
    if (!isPrivateHost(parsed.hostname)) {
      continue
    }
    return {
      url: joinSystemonePath(base),
      auth:
        Object.keys(explicitAuth).length > 0
          ? explicitAuth
          : sessionAuth(provider, input),
      source: 'session',
    }
  }

  return {
    url: joinSystemonePath(SYSTEMONE_DEFAULT_BASE_URL),
    auth: explicitAuth,
    source: 'default',
  }
}

export function systemoneTimeoutMs(raw: string | undefined): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return SYSTEMONE_DEFAULT_TIMEOUT_MS
  }
  return Math.min(
    SYSTEMONE_MAX_TIMEOUT_MS,
    Math.max(SYSTEMONE_MIN_TIMEOUT_MS, Math.trunc(value)),
  )
}
