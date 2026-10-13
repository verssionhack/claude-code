import type { LocalCommandCall } from '../../types/command.js'
import { SAMPLING_FIELDS, type SamplingOptions } from '../../utils/sampling.js'

/**
 * Shared implementation for /top-k, /top-p, /min-p, /repeat-penalty.
 * Usage: <command> [<value>|off]  — no args shows the current value.
 */
export function makeSamplingCall(key: keyof SamplingOptions): LocalCommandCall {
  const spec = SAMPLING_FIELDS.find(f => f.key === key)
  if (!spec) {
    throw new Error(`Unknown sampling field: ${String(key)}`)
  }

  return async (args, context) => {
    const arg = args.trim()

    if (
      arg === '' ||
      arg === 'current' ||
      arg === 'status' ||
      arg === 'help' ||
      arg === '-h' ||
      arg === '--help'
    ) {
      const current = context.getAppState().samplingOptions?.[key]
      if (current === undefined) {
        return {
          type: 'text',
          value: `${spec.label}: default (server-configured)\n\nUsage: ${spec.command} [<${spec.min}-${spec.max}>|off]`,
        }
      }
      return {
        type: 'text',
        value: `${spec.label}: ${current} (session override — use ${spec.command} off to restore the default)`,
      }
    }

    if (arg === 'off' || arg === 'reset' || arg === 'unset') {
      context.setAppState(prev => {
        const next = { ...prev.samplingOptions }
        delete next[key]
        return {
          ...prev,
          samplingOptions: Object.keys(next).length > 0 ? next : undefined,
        }
      })
      return {
        type: 'text',
        value: `${spec.label} reset to default (server-configured)`,
      }
    }

    const parsed = Number(arg)
    if (!Number.isFinite(parsed) || parsed < spec.min || parsed > spec.max) {
      return {
        type: 'text',
        value: `Invalid ${spec.label}: ${arg}. Expected a number between ${spec.min} and ${spec.max}.`,
      }
    }

    context.setAppState(prev => ({
      ...prev,
      samplingOptions: { ...prev.samplingOptions, [key]: parsed },
    }))
    return {
      type: 'text',
      value: `${spec.label} set to ${parsed} (this session only — sent to the backend as \`${spec.bodyKey}\`; ignored by the official Anthropic API)`,
    }
  }
}
