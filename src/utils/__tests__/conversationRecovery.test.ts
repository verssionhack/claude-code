import { describe, expect, test } from 'bun:test'
import { replayPersistedSkillListing } from '../conversationRecovery.js'

function userMessage(uuid: string, text: string): any {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    sessionId: uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    userType: 'external',
    version: '0.0.0',
    cwd: '/',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantMessage(uuid: string, parentUuid: string): any {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    sessionId: parentUuid,
    timestamp: '2026-01-01T00:00:01.000Z',
    userType: 'external',
    version: '0.0.0',
    cwd: '/',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  }
}

const listing = { content: '- skill-a: does a thing', skillCount: 1 }

function hasListing(messages: any[]): boolean {
  return messages.some(
    m => m.type === 'attachment' && m.attachment?.type === 'skill_listing',
  )
}

describe('replayPersistedSkillListing', () => {
  test('inserts the attachment right after the first user message', () => {
    const messages = [
      userMessage('u1', 'hello'),
      assistantMessage('a1', 'u1'),
      userMessage('u2', 'again'),
    ]
    const replayed = replayPersistedSkillListing(messages, listing)
    expect(replayed).toBe(listing)
    expect(messages).toHaveLength(4)
    expect(messages[0].uuid).toBe('u1')
    expect(messages[1].type).toBe('attachment')
    expect(messages[1].attachment.content).toBe(listing.content)
    expect(messages[1].attachment.skillCount).toBe(1)
    expect(messages[1].attachment.isInitial).toBe(true)
  })

  test('does nothing for compacted conversations', () => {
    const compacted = [
      userMessage(
        'u1',
        'This session is being continued from a previous conversation that ran out of context.',
      ),
      assistantMessage('a1', 'u1'),
    ]
    expect(replayPersistedSkillListing(compacted, listing)).toBeUndefined()
    expect(hasListing(compacted)).toBe(false)
  })

  test('does not duplicate a listing already in the transcript', () => {
    const messages = [
      userMessage('u1', 'hello'),
      {
        type: 'attachment',
        uuid: 'att1',
        timestamp: '2026-01-01T00:00:00.000Z',
        attachment: {
          type: 'skill_listing',
          content: 'old',
          skillCount: 1,
          isInitial: true,
        },
      },
      assistantMessage('a1', 'u1'),
    ]
    expect(replayPersistedSkillListing(messages, listing)).toBeUndefined()
    expect(messages.filter(m => m.type === 'attachment')).toHaveLength(1)
  })

  test('no recorded listing is a no-op', () => {
    const messages = [userMessage('u1', 'hello')]
    expect(replayPersistedSkillListing(messages, undefined)).toBeUndefined()
    expect(hasListing(messages)).toBe(false)
  })
})
