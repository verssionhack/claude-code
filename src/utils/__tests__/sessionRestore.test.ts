import { beforeEach, describe, expect, test } from 'bun:test'

const { resetStateForTests, getRenderedSystemPrompt } = await import(
  '../../bootstrap/state.js'
)
const { clearPersistedPromptContext } = await import('../../context.js')
const { restorePromptContext } = await import('../sessionRestore.js')

beforeEach(() => {
  resetStateForTests()
})

describe('restorePromptContext', () => {
  test('replays the assembled system prompt verbatim', () => {
    clearPersistedPromptContext()

    restorePromptContext({
      promptProjectRoot: '/project',
      systemPromptSections: [['env_info_simple', 'env']],
      userContext: { currentDate: 'date-x' },
      systemContext: { gitStatus: 'git-x' },
      renderedSystemPrompt: ['leading-a', 'leading-b'],
      renderedSystemPromptMcpKey: 'server-a',
    })

    expect(getRenderedSystemPrompt()).toEqual({
      parts: ['leading-a', 'leading-b'],
      mcpKey: 'server-a',
    })
  })

  test('a transcript without the rendered snapshot leaves the prompt unset', () => {
    clearPersistedPromptContext()

    restorePromptContext({
      promptProjectRoot: '/project',
      systemPromptSections: [],
      userContext: {},
      systemContext: {},
    })

    expect(getRenderedSystemPrompt()).toBeNull()
  })
})
