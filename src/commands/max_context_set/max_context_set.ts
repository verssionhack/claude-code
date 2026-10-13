import type { LocalCommandCall } from '../../types/command.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import {
  getContextWindowForModel,
  resolveContextWindowForModel,
} from '../../utils/context.js'
import {
  getMaxContextTokensOverride,
  setMaxContextTokensOverride,
} from '../../utils/contextWindowOverride.js'
import { persistSessionOverrides } from '../../utils/sessionOverrides.js'

const USAGE = [
  'Usage: /max_context_set [<tokens>|off]',
  '',
  'Overrides the effective context window for THIS SESSION. Local-only:',
  'it changes auto-compact thresholds, /compact_after percent resolution,',
  'and usage percentages — it does not change what the server accepts.',
  '',
  '- /max_context_set 200000   (200k also works)',
  '- /max_context_set off      restore server-reported / default window',
  '- /max_context_set          show current setting',
].join('\n')

export const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim()
  const model = context.options.mainLoopModel
  const serverWindow = resolveContextWindowForModel(model, getSdkBetas())

  if (arg === '') {
    const current = getMaxContextTokensOverride()
    if (current === undefined) {
      return {
        type: 'text',
        value: `Context window: ${serverWindow.toLocaleString()} tokens (server/default — no session override)\n\n${USAGE}`,
      }
    }
    return {
      type: 'text',
      value: `Context window: ${current.toLocaleString()} tokens (session override; server/default is ${serverWindow.toLocaleString()}) — use /max_context_set off to restore\n\n${USAGE}`,
    }
  }

  if (arg === 'off' || arg === 'reset' || arg === 'unset') {
    setMaxContextTokensOverride(undefined)
    persistSessionOverrides(context.getAppState())
    return {
      type: 'text',
      value: `Context window override cleared — using server/default: ${serverWindow.toLocaleString()} tokens`,
    }
  }

  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(arg)
  const value = m
    ? Math.round(
        Number(m[1]) *
          (m[2]?.toLowerCase() === 'k'
            ? 1_000
            : m[2]?.toLowerCase() === 'm'
              ? 1_000_000
              : 1),
      )
    : NaN
  if (!Number.isFinite(value) || value < 1_000) {
    return {
      type: 'text',
      value: `Invalid value: ${arg}. Expected a token count ≥ 1000 (e.g. 200000 or 200k).\n\n${USAGE}`,
    }
  }

  setMaxContextTokensOverride(value)
  persistSessionOverrides(context.getAppState())
  const effective = getContextWindowForModel(model, getSdkBetas())
  return {
    type: 'text',
    value: `Context window set to ${value.toLocaleString()} tokens (this session only; effective window now ${effective.toLocaleString()})`,
  }
}
