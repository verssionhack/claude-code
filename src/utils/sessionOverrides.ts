import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  getMainLoopModelOverride,
  getSessionId,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import type { AppState } from '../state/AppStateStore.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { safeParseJSON } from './json.js'
import {
  getMaxContextTokensOverride,
  setMaxContextTokensOverride,
} from './contextWindowOverride.js'
import { MAX_API_TIMEOUT_MS, setApiTimeoutOverride } from './apiTimeout.js'
import { jsonStringify } from './slowOperations.js'
import { SAMPLING_FIELDS, type SamplingOptions } from './sampling.js'

/**
 * Session-scoped tuning set via slash commands (/model, /temperature,
 * /top-k..., /thinking, /compact_after, /max_context_set) persisted per
 * session id so `claude -r <id>` picks the session back up where it left
 * off. Stored as a sidecar JSON next to the transcript dir rather than
 * inside the .jsonl transcript — small, self-contained, and the transcript
 * format stays untouched.
 */
export type SessionOverrides = {
  model?: string | null
  temperatureOverride?: number
  samplingOptions?: SamplingOptions
  thinkingOverride?: { enabled: boolean; budgetTokens?: number }
  compactAfter?:
    | { kind: 'tokens'; value: number }
    | { kind: 'percent'; value: number }
  maxContextTokens?: number
  apiTimeoutMs?: number
}

// Only allow safe filename characters in sessionId (UUIDs and simple ids)
// to prevent path traversal outside session-overrides/.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function overridesPath(sessionId: string): string | null {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    return null
  }
  return join(
    getClaudeConfigHomeDir(),
    'session-overrides',
    `${sessionId}.json`,
  )
}

const persistQueues = new Map<string, Promise<void>>()

function enqueuePersistOp(path: string, op: () => Promise<void>): void {
  const prev = persistQueues.get(path) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(op)
    .catch(error => {
      logForDebugging(
        `[sessionOverrides] persist failed: ${error instanceof Error ? error.message : 'unknown'}`,
      )
    })
  persistQueues.set(path, next)
}

export function captureSessionOverrides(
  state: AppState,
): SessionOverrides | undefined {
  const data: SessionOverrides = {
    model: state.mainLoopModel,
    ...(state.temperatureOverride !== undefined && {
      temperatureOverride: state.temperatureOverride,
    }),
    ...(state.samplingOptions !== undefined && {
      samplingOptions: state.samplingOptions,
    }),
    ...(state.thinkingOverride !== undefined && {
      thinkingOverride: state.thinkingOverride,
    }),
    ...(state.compactAfter !== undefined && {
      compactAfter: state.compactAfter,
    }),
    ...(state.apiTimeoutMs !== undefined && {
      apiTimeoutMs: state.apiTimeoutMs,
    }),
  }
  const maxCtx = getMaxContextTokensOverride()
  if (maxCtx !== undefined) data.maxContextTokens = maxCtx

  const hasContent =
    data.model !== null ||
    data.temperatureOverride !== undefined ||
    data.samplingOptions !== undefined ||
    data.thinkingOverride !== undefined ||
    data.compactAfter !== undefined ||
    data.maxContextTokens !== undefined ||
    data.apiTimeoutMs !== undefined
  return hasContent ? data : undefined
}

/** Fire-and-forget. Removes the file when nothing is set anymore. */
export function persistSessionOverrides(state: AppState): void {
  const path = overridesPath(getSessionId())
  if (!path) return
  const data = captureSessionOverrides(state)
  if (!data) {
    enqueuePersistOp(path, () => rm(path, { force: true }))
    return
  }
  const serialized = jsonStringify(data)
  enqueuePersistOp(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, serialized, { encoding: 'utf-8', mode: 0o600 })
  })
}

export async function loadSessionOverrides(
  sessionId: string,
): Promise<SessionOverrides | undefined> {
  const path = overridesPath(sessionId)
  if (!path) return undefined
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = safeParseJSON(raw, false)
    if (!parsed || typeof parsed !== 'object') return undefined
    const o = parsed as Record<string, unknown>
    const out: SessionOverrides = {}

    if (typeof o.model === 'string') out.model = o.model
    else if (o.model === null) out.model = null

    if (
      typeof o.temperatureOverride === 'number' &&
      Number.isFinite(o.temperatureOverride) &&
      o.temperatureOverride >= 0 &&
      o.temperatureOverride <= 1
    ) {
      out.temperatureOverride = o.temperatureOverride
    }

    if (o.samplingOptions && typeof o.samplingOptions === 'object') {
      const s = o.samplingOptions as Record<string, unknown>
      const so: SamplingOptions = {}
      for (const field of SAMPLING_FIELDS) {
        const val = s[field.key]
        if (
          typeof val === 'number' &&
          Number.isFinite(val) &&
          (!field.integer || Number.isInteger(val)) &&
          val >= field.min &&
          val <= field.max
        ) {
          so[field.key] = val
        }
      }
      if (Object.keys(so).length > 0) out.samplingOptions = so
    }

    if (o.thinkingOverride && typeof o.thinkingOverride === 'object') {
      const t = o.thinkingOverride as Record<string, unknown>
      if (typeof t.enabled === 'boolean') {
        out.thinkingOverride = {
          enabled: t.enabled,
          ...(typeof t.budgetTokens === 'number' &&
            Number.isFinite(t.budgetTokens) &&
            t.budgetTokens > 0 && {
              budgetTokens: Math.round(t.budgetTokens),
            }),
        }
      }
    }

    if (o.compactAfter && typeof o.compactAfter === 'object') {
      const c = o.compactAfter as Record<string, unknown>
      if (
        c.kind === 'tokens' &&
        typeof c.value === 'number' &&
        Number.isFinite(c.value) &&
        c.value > 0
      ) {
        out.compactAfter = { kind: 'tokens', value: Math.round(c.value) }
      } else if (
        c.kind === 'percent' &&
        typeof c.value === 'number' &&
        Number.isFinite(c.value) &&
        c.value > 0 &&
        c.value <= 100
      ) {
        out.compactAfter = { kind: 'percent', value: c.value }
      }
    }

    if (
      typeof o.maxContextTokens === 'number' &&
      Number.isFinite(o.maxContextTokens) &&
      o.maxContextTokens >= 1_000
    ) {
      out.maxContextTokens = Math.round(o.maxContextTokens)
    }

    if (
      typeof o.apiTimeoutMs === 'number' &&
      Number.isFinite(o.apiTimeoutMs) &&
      o.apiTimeoutMs > 0 &&
      o.apiTimeoutMs <= MAX_API_TIMEOUT_MS
    ) {
      out.apiTimeoutMs = Math.round(o.apiTimeoutMs)
    }

    return out
  } catch {
    return undefined
  }
}

/**
 * Clears out-of-AppState session overrides (bootstrap/module/env state).
 * Called on /clear and before loading another session's overrides on /resume.
 */
export function resetSessionOverrides(): void {
  setMaxContextTokensOverride(undefined)
  setApiTimeoutOverride(undefined)
}

/**
 * Restores the parts that live outside AppState (module/bootstrap state).
 * An explicit CLI --model (already in the bootstrap override at this point)
 * wins over the saved session model — same guard pattern as agent restore.
 */
export function applySessionOverrides(
  overrides: SessionOverrides,
  opts?: { allowModelOverride?: boolean },
): void {
  const allowModel = opts?.allowModelOverride ?? !getMainLoopModelOverride()
  if (overrides.model !== undefined && allowModel) {
    setMainLoopModelOverride(overrides.model)
  }
  setMaxContextTokensOverride(overrides.maxContextTokens)
  setApiTimeoutOverride(overrides.apiTimeoutMs)
}
