import type { Command } from '../../commands.js'

const compactAfter = {
  type: 'local',
  name: 'compact_after',
  description:
    'Auto-compact after a turn ends once context reaches the given length',
  argumentHint: '[<tokens>|<N>%|off]',
  supportsNonInteractive: false,
  load: () => import('./compact_after.js'),
} satisfies Command

export default compactAfter
