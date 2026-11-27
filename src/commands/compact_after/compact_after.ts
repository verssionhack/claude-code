import type { LocalCommandCall } from '../../types/command.js'
import type { AppState } from '../../state/AppStateStore.js'

type CompactAfterConfig = NonNullable<AppState['compactAfter']>

const USAGE = [
  'Usage: /compact_after [<tokens>|<N>%|off]',
  '',
  'Compacts the conversation after a turn ends naturally, once the context',
  'reaches the given length:',
  '- /compact_after 150000   compact at 150,000 tokens (150k also works)',
  '- /compact_after 85%      compact at 85% of the effective context window',
  '                          (the window adapts to what the server reports)',
  '- /compact_after off      disable',
  '- /compact_after          show the current setting',
  '',
  'Runs at the end of each naturally completed turn (not mid-turn).',
  'Skipped entirely when DISABLE_COMPACT is set.',
].join('\n')

type ParseResult =
  | { ok: true; config: CompactAfterConfig }
  | { ok: true; off: true }
  | { ok: false; error: string }

function parseCompactAfterArg(arg: string): ParseResult {
  const lower = arg.toLowerCase()
  if (
    lower === 'off' ||
    lower === 'reset' ||
    lower === 'clear' ||
    lower === 'none'
  ) {
    return { ok: true, off: true }
  }

  if (arg.endsWith('%')) {
    const n = Number(arg.slice(0, -1))
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      return {
        ok: false,
        error: `Invalid percentage: ${arg}. Expected a number between 1 and 100 followed by %.`,
      }
    }
    return { ok: true, config: { kind: 'percent', value: n } }
  }

  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(arg)
  if (!m) {
    return {
      ok: false,
      error: `Invalid length: ${arg}. Expected a token count (e.g. 150000 or 150k) or a percentage (e.g. 85%).`,
    }
  }
  const suffix = m[2]?.toLowerCase()
  const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1
  const value = Number(m[1]) * mult
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `Invalid length: ${arg}.` }
  }
  return { ok: true, config: { kind: 'tokens', value: Math.round(value) } }
}

function describeConfig(config: CompactAfterConfig): string {
  return config.kind === 'percent'
    ? `${config.value}% of the effective context window`
    : `${config.value.toLocaleString()} tokens`
}

export const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim()
  const lower = arg.toLowerCase()

  if (
    lower === '' ||
    lower === 'help' ||
    lower === '-h' ||
    lower === '--help'
  ) {
    const current = context.getAppState().compactAfter
    const status = current
      ? `Currently: ${describeConfig(current)}`
      : 'Not set (auto-compact uses its default threshold)'
    return { type: 'text', value: `${status}\n\n${USAGE}` }
  }

  const parsed = parseCompactAfterArg(arg)
  if (!parsed.ok) {
    return { type: 'text', value: `${parsed.error}\n\n${USAGE}` }
  }

  if ('off' in parsed) {
    context.setAppState(prev => ({ ...prev, compactAfter: undefined }))
    return { type: 'text', value: 'Compact-after disabled' }
  }

  context.setAppState(prev => ({ ...prev, compactAfter: parsed.config }))
  return {
    type: 'text',
    value: `Compact-after set: ${describeConfig(parsed.config)} — compacts after a turn ends naturally once the context reaches it`,
  }
}
