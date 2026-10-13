import type { Command } from '../../commands.js'

const minP = {
  type: 'local',
  name: 'min-p',
  description: 'Set min-p sampling for this session (self-hosted backends)',
  argumentHint: '[<0-1>|off]',
  supportsNonInteractive: false,
  load: () => import('./min-p.js'),
} satisfies Command

export default minP
