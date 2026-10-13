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
import type { SamplingOptions } from './sampling.js'
import { jsonStringify } from './slowOperations.js'

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
}

function overridesPath(sessionId: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'session-overrides',
    `${sessionId}.json`,
  )
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
  }
  const maxCtx = getMaxContextTokensOverride()
  if (maxCtx !== undefined) data.maxContextTokens = maxCtx

  const hasContent =
    data.model !== null ||
    data.temperatureOverride !== undefined ||
    data.samplingOptions !== undefined ||
    data.thinkingOverride !== undefined ||
    data.compactAfter !== undefined ||
    data.maxContextTokens !== undefined
  return hasContent ? data : undefined
}

/** Fire-and-forget. Removes the file when nothing is set anymore. */
export function persistSessionOverrides(state: AppState): void {
  const data = captureSessionOverrides(state)
  const path = overridesPath(getSessionId())
  if (!data) {
    void rm(path, { force: true }).catch(() => {})
    return
  }
  void mkdir(dirname(path), { recursive: true })
    .then(() =>
      writeFile(path, jsonStringify(data), { encoding: 'utf-8', mode: 0o600 }),
    )
    .catch(error => {
      logForDebugging(
        `[sessionOverrides] persist failed: ${error instanceof Error ? error.message : 'unknown'}`,
      )
    })
}

export async function loadSessionOverrides(
  sessionId: string,
): Promise<SessionOverrides | undefined> {
  try {
    const raw = await readFile(overridesPath(sessionId), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    if (!parsed || typeof parsed !== 'object') return undefined
    const o = parsed as Record<string, unknown>
    const out: SessionOverrides = {}

    if (typeof o.model === 'string') out.model = o.model
    else if (o.model === null) out.model = null

    if (typeof o.temperatureOverride === 'number') {
      out.temperatureOverride = o.temperatureOverride
    }

    if (o.samplingOptions && typeof o.samplingOptions === 'object') {
      const s = o.samplingOptions as Record<string, unknown>
      const so: SamplingOptions = {}
      for (const key of [
        'topK',
        'topP',
        'minP',
        'repeatPenalty',
        'presencePenalty',
      ] as const) {
        if (typeof s[key] === 'number') so[key] = s[key] as number
      }
      if (Object.keys(so).length > 0) out.samplingOptions = so
    }

    if (o.thinkingOverride && typeof o.thinkingOverride === 'object') {
      const t = o.thinkingOverride as Record<string, unknown>
      if (typeof t.enabled === 'boolean') {
        out.thinkingOverride = {
          enabled: t.enabled,
          ...(typeof t.budgetTokens === 'number' && {
            budgetTokens: t.budgetTokens,
          }),
        }
      }
    }

    if (o.compactAfter && typeof o.compactAfter === 'object') {
      const c = o.compactAfter as Record<string, unknown>
      if (
        (c.kind === 'tokens' || c.kind === 'percent') &&
        typeof c.value === 'number'
      ) {
        out.compactAfter = { kind: c.kind, value: c.value }
      }
    }

    if (typeof o.maxContextTokens === 'number' && o.maxContextTokens > 0) {
      out.maxContextTokens = o.maxContextTokens
    }

    return out
  } catch {
    return undefined
  }
}

/**
 * Restores the parts that live outside AppState (module/bootstrap state).
 * An explicit CLI --model (already in the bootstrap override at this point)
 * wins over the saved session model — same guard pattern as agent restore.
 */
export function applySessionOverrides(overrides: SessionOverrides): void {
  if (overrides.model !== undefined && !getMainLoopModelOverride()) {
    setMainLoopModelOverride(overrides.model)
  }
  if (overrides.maxContextTokens !== undefined) {
    setMaxContextTokensOverride(overrides.maxContextTokens)
  }
}
