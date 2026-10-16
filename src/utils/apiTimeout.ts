/**
 * Runtime override for the per-request API client timeout.
 *
 * The Anthropic SDK client reads API_TIMEOUT_MS at construction time, and
 * getAnthropicClient builds a fresh client on every attempt (no caching), so
 * mutating the env var here takes effect on the next request. Shared by the
 * /api_timeout command (live change) and applySessionOverrides (resume) so
 * both stay in sync with AppState.apiTimeoutMs.
 *
 * Passing undefined (or a non-positive / non-finite value) clears the
 * override, restoring the built-in default (600s).
 */
export function setApiTimeoutOverride(ms?: number): void {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    delete process.env.API_TIMEOUT_MS
  } else {
    process.env.API_TIMEOUT_MS = String(Math.round(ms))
  }
}
