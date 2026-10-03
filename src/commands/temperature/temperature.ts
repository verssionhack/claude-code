import type { LocalCommandCall } from '../../types/command.js'

const USAGE = [
  'Usage: /temperature [0.0-1.0 | reset]',
  '',
  'Sets the sampling temperature for model responses (this session only).',
  '- /temperature        Show the current temperature',
  '- /temperature 0.7    Set the temperature to 0.7',
  '- /temperature reset  Restore the default (1)',
  '',
  'Note: when extended thinking is enabled, the API requires temperature 1,',
  'so the override is ignored on those requests.',
].join('\n')

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
    const current = context.getAppState().temperatureOverride
    if (current === undefined) {
      return { type: 'text', value: `Temperature: default (1)\n\n${USAGE}` }
    }
    return {
      type: 'text',
      value: `Temperature: ${current} (session override — use /temperature reset to restore the default)`,
    }
  }

  if (arg === 'reset' || arg === 'default' || arg === 'unset') {
    context.setAppState(prev => ({ ...prev, temperatureOverride: undefined }))
    return { type: 'text', value: 'Temperature reset to default (1)' }
  }

  const parsed = Number(arg)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return {
      type: 'text',
      value: `Invalid temperature: ${arg}. Expected a number between 0 and 1.\n\n${USAGE}`,
    }
  }

  context.setAppState(prev => ({ ...prev, temperatureOverride: parsed }))
  return {
    type: 'text',
    value: `Temperature set to ${parsed} (this session only)`,
  }
}
