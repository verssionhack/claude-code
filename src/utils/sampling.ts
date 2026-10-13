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
  },
  {
    key: 'topP' as const,
    bodyKey: 'top_p',
    command: '/top-p',
    label: 'top-p',
    min: 0,
    max: 1,
  },
  {
    key: 'minP' as const,
    bodyKey: 'min_p',
    command: '/min-p',
    label: 'min-p',
    min: 0,
    max: 1,
  },
  {
    key: 'repeatPenalty' as const,
    bodyKey: 'repeat_penalty',
    command: '/repeat-penalty',
    label: 'repeat-penalty',
    min: 0,
    max: 10,
  },
  {
    key: 'presencePenalty' as const,
    bodyKey: 'presence_penalty',
    command: '/presence-penalty',
    label: 'presence-penalty',
    min: -2,
    max: 2,
  },
] as const

export function samplingToBodyParams(
  options: SamplingOptions | undefined,
): Record<string, number> {
  if (!options) return {}
  const params: Record<string, number> = {}
  for (const field of SAMPLING_FIELDS) {
    const value = options[field.key]
    if (value !== undefined) {
      params[field.bodyKey] = value
    }
  }
  return params
}
