import type { Command } from '../../commands.js'

const apiTimeout = {
  type: 'local',
  name: 'api_timeout',
  description: 'Set the per-request API client timeout for this session',
  argumentHint: '[<duration>|off]',
  supportsNonInteractive: false,
  load: () => import('./api_timeout.js'),
} satisfies Command

export default apiTimeout
