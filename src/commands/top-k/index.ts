import type { Command } from '../../commands.js'

const topK = {
  type: 'local',
  name: 'top-k',
  description: 'Set top-k sampling for this session (self-hosted backends)',
  argumentHint: '[<0-1000>|off]',
  supportsNonInteractive: false,
  load: () => import('./top-k.js'),
} satisfies Command

export default topK
