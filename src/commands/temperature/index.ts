import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const temperature = {
  type: 'local',
  name: 'temperature',
  aliases: ['temp'],
  description: 'Set sampling temperature for model responses (this session)',
  argumentHint: '[0.0-1.0|reset]',
  supportsNonInteractive: false,
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./temperature.js'),
} satisfies Command

export default temperature
