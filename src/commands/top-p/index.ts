import type { Command } from '../../commands.js'

const topP = {
  type: 'local',
  name: 'top-p',
  description:
    'Set top-p (nucleus) sampling for this session (self-hosted backends)',
  argumentHint: '[<0-1>|off]',
  supportsNonInteractive: false,
  load: () => import('./top-p.js'),
} satisfies Command

export default topP
