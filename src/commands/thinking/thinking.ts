import type { LocalCommandCall } from '../../types/command.js'

type ThinkingOverride = { enabled: boolean; budgetTokens?: number }

const USAGE = 'Usage: /thinking [on|off|<budget tokens>|default]'

/**
 * Session-scoped thinking toggle. On self-hosted backends (llama.cpp and
 * compatible) "off" also sends chat_template_kwargs.enable_thinking=false so
 * the model actually stops thinking — merely omitting the Anthropic `thinking`
 * field would leave the server-side default in place.
 */
export const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim().toLowerCase()

  const show = (): { type: 'text'; value: string } => {
    const current = context.getAppState().thinkingOverride
    if (current === undefined) {
      return {
        type: 'text',
        value: `thinking: default (model/server configured)\n\n${USAGE}`,
      }
    }
    if (!current.enabled) {
      return {
        type: 'text',
        value:
          'thinking: off (session override — use /thinking default to restore)',
      }
    }
    return {
      type: 'text',
      value: `thinking: on${
        current.budgetTokens !== undefined
          ? ` (budget: ${current.budgetTokens.toLocaleString()} tokens)`
          : ' (default budget)'
      } — session override, use /thinking default to restore`,
    }
  }

  const set = (override: ThinkingOverride, message: string) => {
    context.setAppState(prev => ({ ...prev, thinkingOverride: override }))
    return { type: 'text' as const, value: message }
  }

  if (
    arg === '' ||
    arg === 'current' ||
    arg === 'status' ||
    arg === 'help' ||
    arg === '-h' ||
    arg === '--help'
  ) {
    return show()
  }

  if (
    arg === 'default' ||
    arg === 'reset' ||
    arg === 'unset' ||
    arg === 'auto'
  ) {
    context.setAppState(prev => ({ ...prev, thinkingOverride: undefined }))
    return {
      type: 'text',
      value: 'thinking reset to default (model/server configured)',
    }
  }

  if (arg === 'off' || arg === 'disable' || arg === 'false' || arg === 'no') {
    return set(
      { enabled: false },
      'thinking off (this session only — self-hosted backends also receive chat_template_kwargs.enable_thinking=false)',
    )
  }

  if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === 'yes') {
    return set(
      { enabled: true },
      'thinking on (this session only — self-hosted backends also receive chat_template_kwargs.enable_thinking=true)',
    )
  }

  // <budget tokens>, with optional k suffix: /thinking 8000 or /thinking 8k
  const m = /^(\d+(?:\.\d+)?)\s*(k?)$/.exec(arg)
  if (m) {
    const budget = Math.round(Number(m[1]) * (m[2] ? 1000 : 1))
    if (budget < 1) {
      return {
        type: 'text',
        value: `Invalid thinking budget: ${arg}. Expected at least 1 token.\n\n${USAGE}`,
      }
    }
    return set(
      { enabled: true, budgetTokens: budget },
      `thinking on with ${budget.toLocaleString()}-token budget (this session only — on self-hosted backends the budget is sent as the reasoning budget; ignored entirely by the official Anthropic API for adaptive-thinking models)`,
    )
  }

  return {
    type: 'text',
    value: `Invalid argument: ${arg}.\n\n${USAGE}`,
  }
}
