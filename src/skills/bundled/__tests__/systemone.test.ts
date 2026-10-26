import { afterEach, describe, expect, test } from 'bun:test'

import type { PromptCommand } from '../../../types/command.js'
import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import { registerSystemoneSkill } from '../systemone.js'

function asPrompt(command: { type: string }): PromptCommand {
  return command as unknown as PromptCommand
}

afterEach(() => {
  clearBundledSkills()
})

describe('registerSystemoneSkill', () => {
  test('registers a user-invocable prompt skill named systemone', () => {
    registerSystemoneSkill()

    const skill = getBundledSkills().find(s => s.name === 'systemone')
    expect(skill).toBeDefined()
    expect(skill!.type).toBe('prompt')
    expect(skill!.userInvocable).toBe(true)
    expect(skill!.whenToUse).toBeTruthy()
    expect(skill!.description).toContain('typed decision')
    expect(asPrompt(skill!).allowedTools).toContain('Systemone')
    expect(skill!.argumentHint).toBe('[decision request]')
    expect(asPrompt(skill!).source).toBe('bundled')
  })

  test('prompt teaches batching and context_id prefix reuse', async () => {
    registerSystemoneSkill()

    const skill = getBundledSkills().find(s => s.name === 'systemone')!
    const blocks = await asPrompt(skill).getPromptForCommand('', {} as never)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')
    const text = (blocks[0] as { type: 'text'; text: string }).text

    expect(text).toContain('Systemone')
    expect(text).toContain('ONE Systemone call')
    expect(text).toContain('context_id')
    expect(text).toContain('reuses its KV prefix')
    expect(text).toContain('Do not call the endpoint with Bash/curl')
    expect(text).toContain('64 questions')
  })

  test('appends the user request when args are given', async () => {
    registerSystemoneSkill()

    const skill = getBundledSkills().find(s => s.name === 'systemone')!
    const blocks = await asPrompt(skill).getPromptForCommand(
      'route this ticket: billing or shipping?',
      {} as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).toContain('## User Request')
    expect(text).toContain('route this ticket: billing or shipping?')
  })
})
