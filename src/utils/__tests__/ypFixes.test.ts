import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import {
  clearBetaHeaderLatches,
  getLatchedEffort,
  resetStateForTests,
  setEffortLatchSeeded,
  setLatchedEffort,
  setMainLoopModelOverride,
} from '../../bootstrap/state.js'
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from '../../services/compact/autoCompact.js'
import { getEffortChangeAttachment } from '../attachments.js'
import { setMaxContextTokensOverride } from '../contextWindowOverride.js'
import { getLiveEffortLevel, resolvePinnedRequestEffort } from '../effort.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getAgentModel } from '../model/agent.js'
import { getSmallFastModel } from '../model/model.js'
import { samplingToBodyParams } from '../sampling.js'
import { loadSessionOverrides } from '../sessionOverrides.js'
import { TaskIdSchema } from '../tasks.js'
import { combineImagePermissionDecisions } from '@claude-code-best/builtin-tools/tools/SystemoneTool/SystemoneTool.js'
import { resolveSystemoneEndpoint } from '@claude-code-best/builtin-tools/tools/SystemoneTool/config.js'
import { parseSystemoneXml } from '@claude-code-best/builtin-tools/tools/SystemoneTool/xml.js'
import { tavilyExtractFailureReason } from '@claude-code-best/builtin-tools/tools/WebFetchTool/utils.js'

describe('TaskIdSchema regression', () => {
  const schema = z.strictObject({ taskId: TaskIdSchema() })

  test('accepts non-empty strings and integer numbers', () => {
    expect(schema.parse({ taskId: '17' })).toEqual({ taskId: '17' })
    expect(schema.parse({ taskId: 17 })).toEqual({ taskId: '17' })
  })

  test('rejects missing, null, boolean, object, float, NaN, and empty inputs', () => {
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ taskId: undefined }).success).toBe(false)
    expect(schema.safeParse({ taskId: null }).success).toBe(false)
    expect(schema.safeParse({ taskId: true }).success).toBe(false)
    expect(schema.safeParse({ taskId: {} }).success).toBe(false)
    expect(schema.safeParse({ taskId: [] }).success).toBe(false)
    expect(schema.safeParse({ taskId: 17.5 }).success).toBe(false)
    expect(schema.safeParse({ taskId: Number.NaN }).success).toBe(false)
    expect(schema.safeParse({ taskId: '' }).success).toBe(false)
  })
})

describe('samplingToBodyParams regression', () => {
  test('omits self-hosted-only fields on official Anthropic API', () => {
    const opts = {
      topK: 40,
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      presencePenalty: 0.2,
    }
    expect(
      samplingToBodyParams(opts, {
        allowSelfHostedFields: false,
        hasThinking: false,
      }),
    ).toEqual({ top_k: 40, top_p: 0.9 })
    expect(
      samplingToBodyParams(opts, {
        allowSelfHostedFields: false,
        hasThinking: true,
      }),
    ).toEqual({})
    expect(
      samplingToBodyParams(opts, {
        allowSelfHostedFields: true,
        hasThinking: true,
      }),
    ).toEqual({
      top_k: 40,
      top_p: 0.9,
      min_p: 0.05,
      repeat_penalty: 1.1,
      presence_penalty: 0.2,
    })
  })
})

describe('getAgentModel inherit regression', () => {
  test('resolves toolSpecifiedModel="inherit" to parent model instead of literal "inherit"', () => {
    const resolved = getAgentModel(
      undefined,
      'claude-sonnet-4-6',
      'inherit',
      'default',
    )
    expect(resolved).toBe('claude-sonnet-4-6')
    expect(resolved).not.toBe('inherit')
  })
})

describe('getSmallFastModel custom endpoint regression', () => {
  const savedEnv = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    setMainLoopModelOverride(null)
  })

  test('honors ANTHROPIC_DEFAULT_HAIKU_MODEL on custom ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test'
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-haiku-model'
    setMainLoopModelOverride('my-opus-model')
    expect(getSmallFastModel()).toBe('my-haiku-model')
  })

  test('strips [1m] suffix when falling back to main loop model on custom endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8080'
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    setMainLoopModelOverride('local-qwen[1m]')
    expect(getSmallFastModel()).toBe('local-qwen')
  })
})

describe('small context window auto-compact regression', () => {
  afterEach(() => {
    setMaxContextTokensOverride(undefined)
  })

  test('keeps effective window and autocompact threshold positive for 16k and 8k windows', () => {
    for (const size of [16_000, 8_000, 2_000]) {
      setMaxContextTokensOverride(size)
      const effective = getEffectiveContextWindowSize('local-model')
      const threshold = getAutoCompactThreshold('local-model')
      expect(effective).toBeGreaterThan(0)
      expect(threshold).toBeGreaterThan(0)
      expect(threshold).toBeLessThanOrEqual(effective)
    }
  })
})

describe('sessionOverrides validation and path traversal regression', () => {
  const testId = 'test-overrides-validation-123'
  const filePath = join(
    getClaudeConfigHomeDir(),
    'session-overrides',
    `${testId}.json`,
  )

  afterEach(async () => {
    await rm(filePath, { force: true })
  })

  test('rejects sessionId containing path traversal', async () => {
    expect(await loadSessionOverrides('../../etc/passwd')).toBeUndefined()
    expect(await loadSessionOverrides('a/b')).toBeUndefined()
  })

  test('drops out-of-range and non-integer values', async () => {
    await mkdir(join(getClaudeConfigHomeDir(), 'session-overrides'), {
      recursive: true,
    })
    await writeFile(
      filePath,
      JSON.stringify({
        temperatureOverride: 99,
        samplingOptions: { topK: 40.5, topP: 0.8 },
        compactAfter: { kind: 'percent', value: 0 },
        maxContextTokens: 500,
        apiTimeoutMs: 9_999_999_999,
      }),
    )
    const loaded = await loadSessionOverrides(testId)
    expect(loaded).toEqual({
      samplingOptions: { topP: 0.8 },
    })
  })
})

describe('effort_change revert and thinking gate regression', () => {
  const MODEL = 'claude-opus-4-6'

  beforeEach(() => {
    resetStateForTests()
    clearBetaHeaderLatches()
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  })

  afterEach(() => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  })

  test('emits revert attachment when returning from high back to pinned medium', () => {
    resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    expect(getLatchedEffort()).toBe('medium')

    expect(getEffortChangeAttachment(MODEL, 'high', true, true)).toEqual([
      { type: 'effort_change', level: 'high' },
    ])
    // Reverting back to medium must emit an effort_change back to medium!
    expect(getEffortChangeAttachment(MODEL, 'medium', true, true)).toEqual([
      { type: 'effort_change', level: 'medium' },
    ])
    // Repeating medium does not re-emit
    expect(getEffortChangeAttachment(MODEL, 'medium', true, true)).toEqual([])
  })

  test('suppresses effort_change when thinking is disabled', () => {
    setEffortLatchSeeded(true)
    setLatchedEffort('medium')
    expect(getEffortChangeAttachment(MODEL, 'high', true, false)).toEqual([])
  })

  test('getLiveEffortLevel returns high on default and null on env unset', () => {
    expect(getLiveEffortLevel('claude-sonnet-4-6', undefined)).toBe('high')
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    expect(getLiveEffortLevel('claude-sonnet-4-6', 'low')).toBeNull()
  })
})

describe('SystemoneTool security & parsing regressions', () => {
  test('combineImagePermissionDecisions preserves rule-based ask decisionReason', () => {
    const rule = {
      source: 'userSettings' as const,
      ruleBehavior: 'ask' as const,
      ruleValue: { toolName: 'Read', ruleContent: '.env' },
    }
    const combined = combineImagePermissionDecisions([
      {
        behavior: 'ask',
        message: 'Read outside cwd',
        decisionReason: { type: 'workingDir', reason: 'outside cwd' },
      },
      {
        behavior: 'ask',
        message: 'Ask rule for .env',
        decisionReason: { type: 'rule', rule },
      },
    ])
    expect(combined?.behavior).toBe('ask')
    expect(combined?.decisionReason).toEqual({ type: 'rule', rule })
  })

  test('resolveSystemoneEndpoint blocks 169.254.169.254, rejects file:// override, and honors explicitApiKey on session endpoint', () => {
    const metadata = resolveSystemoneEndpoint({
      provider: 'firstParty',
      anthropicBaseUrl: 'http://169.254.169.254',
    })
    expect(metadata.source).toBe('default')

    const badScheme = resolveSystemoneEndpoint({
      provider: 'firstParty',
      explicitUrl: 'file:///etc/passwd',
    })
    expect(badScheme.source).toBe('default')

    const withKey = resolveSystemoneEndpoint({
      provider: 'openai',
      openaiBaseUrl: 'http://127.0.0.1:8080/v1',
      openaiApiKey: 'session-key',
      explicitApiKey: 'override-key',
    })
    expect(withKey.source).toBe('session')
    expect(withKey.auth).toEqual({ Authorization: 'Bearer override-key' })
  })

  test('parseSystemoneXml allows DOCTYPE inside CDATA and rejects unclosed tags and 1-level score', () => {
    const cdataReq = parseSystemoneXml(
      '<systemone><state><![CDATA[<!DOCTYPE html><html></html>]]></state><question id="q" type="noul">html?</question></systemone>',
    )
    expect(cdataReq.state).toBe('<!DOCTYPE html><html></html>')

    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="noul">unclosed</systemone>',
      ),
    ).toThrow()

    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="score">rate<level>only one</level></question></systemone>',
      ),
    ).toThrow('at least two')
  })
})

describe('tavilyExtractFailureReason robustness regression', () => {
  test('handles malformed non-array/null entries, empty-string shadowing, and huge strings', () => {
    expect(
      tavilyExtractFailureReason(
        {
          failed_results: 'bad' as unknown as [],
          error: '',
          message: '  rate limited  ',
        },
        'https://example.com',
      ),
    ).toBe('rate limited')

    expect(
      tavilyExtractFailureReason(
        {
          failed_results: [null as unknown as { url: string; error: string }],
          results: [null as unknown as { error: string }],
          error: 'x'.repeat(800),
        },
        'https://example.com',
      )?.length,
    ).toBe(501)
  })
})
