import type { Command } from '../../commands.js'

const thinking = {
  type: 'local',
  name: 'thinking',
  description:
    'Toggle extended thinking for this session (on self-hosted backends this also flips enable_thinking in the chat template)',
  argumentHint: '[on|off|<budget tokens>|default]',
  supportsNonInteractive: false,
  load: () => import('./thinking.js'),
} satisfies Command

export default thinking
