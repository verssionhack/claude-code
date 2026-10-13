import type { Command } from '../../commands.js'

const presencePenalty = {
  type: 'local',
  name: 'presence-penalty',
  description: 'Set presence penalty for this session (self-hosted backends)',
  argumentHint: '[<value>|off]',
  supportsNonInteractive: false,
  load: () => import('./presence-penalty.js'),
} satisfies Command

export default presencePenalty
