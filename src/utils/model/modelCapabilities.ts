import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getAnthropicClient } from '../../services/api/client.js'
import { isClaudeAISubscriber } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { jsonStringify } from '../slowOperations.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

// .strip() — don't persist internal-only fields (mycro_deployments etc.) to disk
const ModelCapabilitySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strip(),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilitySchema()),
    timestamp: z.number(),
    // Client-requested short name → canonical id echoed by the server
    // (proxies resolve aliases like "qwen-27b" to full model ids).
    aliases: z.record(z.string(), z.string()).optional(),
  }),
)

export type ModelCapability = z.infer<ReturnType<typeof ModelCapabilitySchema>>

function getCacheDir(): string {
  return join(getClaudeConfigHomeDir(), 'cache')
}

function getCachePath(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!baseUrl || isFirstPartyAnthropicBaseUrl()) {
    return join(getCacheDir(), 'model-capabilities.json')
  }
  const key = createHash('sha256')
    .update(baseUrl.replace(/\/+$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 12)
  return join(getCacheDir(), `model-capabilities-${key}.json`)
}

function isModelCapabilitiesEligible(): boolean {
  // Upstream gates this to ant-only, but the /v1/models API is available
  // to all firstParty users (API key and OAuth), including custom base
  // URLs (proxies/gateways). Enabling for everyone lets model capabilities
  // (max_input_tokens, max_tokens) be fetched dynamically instead of
  // relying on hardcoded values in context.ts. When the endpoint doesn't
  // implement /v1/models the fetch fails silently (refreshModelCapabilities
  // catches) and the hardcoded window is used instead.
  return getAPIProvider() === 'firstParty'
}

// Longest-id-first so substring match prefers most specific; secondary key for stable isEqual
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort(
    (a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id),
  )
}

// llama.cpp-style endpoints don't report max_input_tokens; the context
// length lives in status.args (--ctx-size N) or the preset text.
function extractLlamacppCtxSize(
  entry: Record<string, unknown>,
): number | undefined {
  const status = entry.status
  if (!status || typeof status !== 'object') return undefined
  const s = status as Record<string, unknown>
  const args = s.args
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (typeof arg !== 'string') continue
      if ((arg === '--ctx-size' || arg === '-c') && i + 1 < args.length) {
        const n = Number(args[i + 1])
        if (Number.isFinite(n) && n > 0) return n
      } else if (arg.startsWith('--ctx-size=')) {
        const n = Number(arg.slice('--ctx-size='.length))
        if (Number.isFinite(n) && n > 0) return n
      }
    }
  }
  if (typeof s.preset === 'string') {
    const m = /ctx-size\s*=\s*(\d+)/.exec(s.preset)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return undefined
}

// Keyed on cache path so tests that set CLAUDE_CONFIG_DIR get a fresh read
const loadCacheFile = memoize(
  (path: string) => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getContextWindowForModel
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  },
  path => path,
)

// Client name → canonical server id, learned at runtime (recordResolvedModel)
// and hydrated from the persisted aliases map below.
const modelAliases: Record<string, string> = {}
let aliasesHydratedFor: string | null = null

export function getModelCapability(model: string): ModelCapability | undefined {
  if (!isModelCapabilitiesEligible()) return undefined
  const path = getCachePath()
  const file = loadCacheFile(path)
  const cached = file?.models
  if (!cached || cached.length === 0) return undefined
  if (aliasesHydratedFor !== path) {
    for (const k of Object.keys(modelAliases)) {
      delete modelAliases[k]
    }
    if (file?.aliases) {
      for (const [k, v] of Object.entries(file.aliases)) {
        modelAliases[k] = v
      }
    }
    aliasesHydratedFor = path
  }
  const m = (modelAliases[model.toLowerCase()] ?? model).toLowerCase()
  const exact = cached.find(c => c.id.toLowerCase() === m)
  if (exact) return exact
  return cached.find(c => m.includes(c.id.toLowerCase()))
}

/**
 * Model options from the server's /v1/models cache, for the /model picker.
 * Only for custom endpoints (llama.cpp and similar proxies) — the official
 * Anthropic API returns hundreds of dated models that would flood the list.
 */
export function getServerModels(): Array<{
  id: string
  maxInputTokens?: number
}> {
  if (!isModelCapabilitiesEligible()) return []
  if (isFirstPartyAnthropicBaseUrl()) return []
  const file = loadCacheFile(getCachePath())
  if (!file?.models?.length) return []
  return file.models.map(m => ({
    id: m.id,
    maxInputTokens: m.max_input_tokens,
  }))
}

export function getServerModelOptions(): Array<{
  value: string
  label: string
  description: string
}> {
  return getServerModels().map(m => ({
    value: m.id,
    label: m.id,
    description:
      m.maxInputTokens !== undefined
        ? `Server model (context: ${m.maxInputTokens.toLocaleString()} tokens)`
        : 'Server model',
  }))
}

/**
 * Record that a request for `requested` was served by the model `resolved`
 * (echoed in the API response). Proxies often resolve short client names to
 * canonical ids; learning the mapping lets server-reported capabilities
 * (max_input_tokens) apply to the short name.
 */
export function recordResolvedModel(
  requested: string,
  resolved: string | undefined,
): void {
  if (!isModelCapabilitiesEligible()) return
  const key = requested.toLowerCase()
  const value = resolved?.toLowerCase()
  if (!key || !value || key === value) return
  if (modelAliases[key] === value) return
  modelAliases[key] = value
  // Persist so the mapping survives restarts (fire-and-forget).
  const path = getCachePath()
  const file = loadCacheFile(path)
  if (!file) return
  void persistCache(
    {
      ...file,
      aliases: { ...file.aliases, ...modelAliases },
    },
    path,
  ).catch(error => {
    logForDebugging(
      `[modelCapabilities] alias persist failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  })
}

const persistQueues = new Map<string, Promise<void>>()

async function persistCache(
  file: {
    models: ModelCapability[]
    timestamp: number
    aliases?: Record<string, string>
  },
  path: string,
): Promise<void> {
  const prev = persistQueues.get(path) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(async () => {
      await mkdir(getCacheDir(), { recursive: true })
      await writeFile(path, jsonStringify(file), {
        encoding: 'utf-8',
        mode: 0o600,
      })
      loadCacheFile.cache.delete(path)
    })
  persistQueues.set(path, next)
  await next
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
  if (isEssentialTrafficOnly()) return

  try {
    const anthropic = await getAnthropicClient({ maxRetries: 1 })
    const betas = isClaudeAISubscriber() ? [OAUTH_BETA_HEADER] : undefined
    const parsed: ModelCapability[] = []
    for await (const entry of anthropic.models.list({ betas })) {
      const result = ModelCapabilitySchema().safeParse(entry)
      if (!result.success) continue
      let cap = result.data
      if (cap.max_input_tokens === undefined) {
        const ctxSize = extractLlamacppCtxSize(
          entry as unknown as Record<string, unknown>,
        )
        if (ctxSize !== undefined) {
          cap = { ...cap, max_input_tokens: ctxSize }
        }
      }
      parsed.push(cap)
    }
    if (parsed.length === 0) return

    const path = getCachePath()
    const models = sortForMatching(parsed)
    if (isEqual(loadCacheFile(path)?.models, models)) {
      logForDebugging('[modelCapabilities] cache unchanged, skipping write')
      return
    }

    await persistCache(
      {
        models,
        timestamp: Date.now(),
        // Carry over learned aliases (persisted and/or in-memory this session)
        aliases: { ...loadCacheFile(path)?.aliases, ...modelAliases },
      },
      path,
    )
    logForDebugging(`[modelCapabilities] cached ${models.length} models`)
  } catch (error) {
    logForDebugging(
      `[modelCapabilities] fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}
