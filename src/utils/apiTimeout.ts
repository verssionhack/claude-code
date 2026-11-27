import { clearGrokClientCache } from '../services/api/grok/client.js'
import { clearOpenAIClientCache } from '../services/api/openai/client.js'

// Node/Bun timers use a 32-bit signed int for ms; anything above overflows to 1ms.
export const MAX_API_TIMEOUT_MS = 2_147_483_647

// Capture launch-time API_TIMEOUT_MS once before the first session override
// mutates it so resetting to default restores the user's launch environment.
let initialEnvApiTimeoutMs: string | undefined
let hasCapturedInitialEnv = false

/**
 * Runtime override for the per-request API client timeout.
 *
 * The Anthropic SDK client reads API_TIMEOUT_MS at construction time, and
 * getAnthropicClient builds a fresh client on every attempt (no caching), so
 * mutating the env var here takes effect on the next request. OpenAI and Grok
 * cache their client instances, so we clear those caches on change. Shared by
 * the /api_timeout command (live change) and applySessionOverrides (resume) so
 * both stay in sync with AppState.apiTimeoutMs.
 *
 * Passing undefined (or a non-positive / non-finite value) clears the
 * override, restoring the launch-time env var or built-in default (600s).
 */
export function setApiTimeoutOverride(ms?: number): void {
  if (!hasCapturedInitialEnv) {
    initialEnvApiTimeoutMs = process.env.API_TIMEOUT_MS
    hasCapturedInitialEnv = true
  }
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    if (initialEnvApiTimeoutMs !== undefined) {
      process.env.API_TIMEOUT_MS = initialEnvApiTimeoutMs
    } else {
      delete process.env.API_TIMEOUT_MS
    }
  } else {
    const clamped = Math.min(Math.round(ms), MAX_API_TIMEOUT_MS)
    process.env.API_TIMEOUT_MS = String(clamped)
  }
  clearOpenAIClientCache()
  clearGrokClientCache()
}
