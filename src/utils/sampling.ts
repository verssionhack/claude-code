/**
 * Session-scoped sampling parameters set via slash commands (/top-k, /top-p,
 * /min-p, /repeat-penalty). These are NOT part of the Anthropic API — they
 * are extra body fields honored by self-hosted backends (llama.cpp and
 * compatible proxies). Only included in requests when actually set.
 */
export type SamplingOptions = {
  topK?: number
  topP?: number
  minP?: number
  repeatPenalty?: number
  presencePenalty?: number
}

export const SAMPLING_FIELDS = [
  {
    key: 'topK' as const,
    bodyKey: 'top_k',
    command: '/top-k',
    label: 'top-k',
    min: 0,
    max: 1000,
    integer: true,
    selfHostedOnly: false,
  },
  {
    key: 'topP' as const,
    bodyKey: 'top_p',
    command: '/top-p',
    label: 'top-p',
    min: 0,
    max: 1,
    integer: false,
    selfHostedOnly: false,
  },
  {
    key: 'minP' as const,
    bodyKey: 'min_p',
    command: '/min-p',
    label: 'min-p',
    min: 0,
    max: 1,
    integer: false,
    selfHostedOnly: true,
  },
  {
    key: 'repeatPenalty' as const,
    bodyKey: 'repeat_penalty',
    command: '/repeat-penalty',
    label: 'repeat-penalty',
    min: 0,
    max: 10,
    integer: false,
    selfHostedOnly: true,
  },
  {
    key: 'presencePenalty' as const,
    bodyKey: 'presence_penalty',
    command: '/presence-penalty',
    label: 'presence-penalty',
    min: -2,
    max: 2,
    integer: false,
    selfHostedOnly: true,
  },
] as const

export function samplingToBodyParams(
  options: SamplingOptions | undefined,
  opts?: { allowSelfHostedFields?: boolean; hasThinking?: boolean },
): Record<string, number> {
  if (!options) return {}
  const allowSelfHosted = opts?.allowSelfHostedFields ?? true
  const hasThinking = opts?.hasThinking ?? false
  const params: Record<string, number> = {}
  for (const field of SAMPLING_FIELDS) {
    const value = options[field.key]
    if (value === undefined || !Number.isFinite(value)) continue
    if (!allowSelfHosted) {
      if (field.selfHostedOnly) continue
      // Anthropic rejects top_k (always) and top_p < 0.95 when thinking is enabled
      if (hasThinking && field.key === 'topK') continue
      if (hasThinking && field.key === 'topP' && value < 0.95) continue
    }
    params[field.bodyKey] = value
  }
  return params
}
