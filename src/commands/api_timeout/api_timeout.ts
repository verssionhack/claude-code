import type { LocalCommandCall } from '../../types/command.js'
import { setApiTimeoutOverride } from '../../utils/apiTimeout.js'

const USAGE = [
  'Usage: /api_timeout [<duration>|off]',
  '',
  'Sets the per-request API client timeout (this session only).',
  '- /api_timeout        Show the current timeout',
  '- /api_timeout 90s    Set the timeout to 90 seconds',
  '- /api_timeout 5m     5 minutes   (also: 1h, 500ms)',
  '- /api_timeout 90     A bare number means seconds',
  '- /api_timeout off    Restore the default (600s)',
  '',
  'Applies from the next request onward (the SDK client is rebuilt per',
  'request) and also drives the non-streaming fallback timeout.',
].join('\n')

type ParseResult = { ok: true; ms: number } | { ok: false; error: string }

function parseDurationToMs(arg: string): ParseResult {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(arg)
  if (!m) {
    return { ok: false, error: `Invalid duration: ${arg}.` }
  }
  const value = Number(m[1])
  const unit = m[2]?.toLowerCase()
  if (!Number.isFinite(value)) {
    return { ok: false, error: `Invalid duration: ${arg}.` }
  }
  const mult =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1_000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 1_000
  const ms = Math.round(value * mult)
  if (ms <= 0) {
    return {
      ok: false,
      error: `Invalid duration: ${arg}. Timeout must be positive.`,
    }
  }
  return { ok: true, ms }
}

function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  if (ms % 1_000 === 0) return `${ms / 1_000} s`
  return `${ms} ms`
}

export const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim()

  if (
    arg === '' ||
    arg === 'current' ||
    arg === 'status' ||
    arg === 'help' ||
    arg === '-h' ||
    arg === '--help'
  ) {
    const override = context.getAppState().apiTimeoutMs
    const envMs = process.env.API_TIMEOUT_MS
      ? parseInt(process.env.API_TIMEOUT_MS, 10)
      : NaN
    const status =
      override !== undefined
        ? `Timeout: ${formatMs(override)} (session override — /api_timeout off to restore the default)`
        : Number.isFinite(envMs) && envMs > 0
          ? `Timeout: ${formatMs(envMs)} (from API_TIMEOUT_MS env — /api_timeout off to clear)`
          : 'Timeout: default (600s)'
    return { type: 'text', value: `${status}\n\n${USAGE}` }
  }

  if (
    arg === 'off' ||
    arg === 'reset' ||
    arg === 'default' ||
    arg === 'unset' ||
    arg === 'clear' ||
    arg === 'none'
  ) {
    setApiTimeoutOverride(undefined)
    context.setAppState(prev => ({ ...prev, apiTimeoutMs: undefined }))
    return { type: 'text', value: 'API timeout reset to default (600s)' }
  }

  const parsed = parseDurationToMs(arg)
  if (!parsed.ok) {
    return {
      type: 'text',
      value: `${parsed.error} Expected a duration like 90s, 5m, 1h or 500ms (a bare number means seconds).\n\n${USAGE}`,
    }
  }
  setApiTimeoutOverride(parsed.ms)
  context.setAppState(prev => ({ ...prev, apiTimeoutMs: parsed.ms }))
  return {
    type: 'text',
    value: `API timeout set to ${formatMs(parsed.ms)} (this session only)`,
  }
}
