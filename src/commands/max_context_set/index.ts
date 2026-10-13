import type { Command } from '../../commands.js'

const maxContextSet = {
  type: 'local',
  name: 'max_context_set',
  description:
    'Override the effective context window for this session (local budgeting only)',
  argumentHint: '[<tokens>|off]',
  supportsNonInteractive: false,
  load: () => import('./max_context_set.js'),
} satisfies Command

export default maxContextSet
