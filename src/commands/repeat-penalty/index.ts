import type { Command } from '../../commands.js'

const repeatPenalty = {
  type: 'local',
  name: 'repeat-penalty',
  description: 'Set repeat penalty for this session (self-hosted backends)',
  argumentHint: '[<0-10>|off]',
  supportsNonInteractive: false,
  load: () => import('./repeat-penalty.js'),
} satisfies Command

export default repeatPenalty
