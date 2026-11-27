import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'

// Mock heavy dependencies to avoid import chain issues
mock.module('src/utils/thinking.js', () => ({
  isUltrathinkEnabled: () => false,
}))
mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
}))
mock.module('src/utils/auth.js', () => ({
  isProSubscriber: () => false,
  isMaxSubscriber: () => false,
  isTeamSubscriber: () => false,
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, defaultValue: unknown) =>
    defaultValue ?? {},
}))
mock.module('src/utils/model/modelSupportOverrides.js', () => ({
  get3PModelCapabilityOverride: () => undefined,
}))

const {
  isEffortLevel,
  parseEffortValue,
  isValidNumericEffort,
  convertEffortValueToLevel,
  getEffortLevelDescription,
  resolvePickerEffortPersistence,
  resolveRequestEffort,
  resolvePinnedRequestEffort,
  effortLatchModeForQuerySource,
  EFFORT_LEVELS,
} = await import('src/utils/effort.js')

const {
  getLatchedEffort,
  isEffortLatchSeeded,
  resetStateForTests,
  clearBetaHeaderLatches,
} = await import('src/bootstrap/state.js')

// ─── EFFORT_LEVELS constant ────────────────────────────────────────────

describe('EFFORT_LEVELS', () => {
  test('contains the five canonical levels', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

// ─── isEffortLevel ─────────────────────────────────────────────────────

describe('isEffortLevel', () => {
  test("returns true for 'low'", () => {
    expect(isEffortLevel('low')).toBe(true)
  })

  test("returns true for 'medium'", () => {
    expect(isEffortLevel('medium')).toBe(true)
  })

  test("returns true for 'high'", () => {
    expect(isEffortLevel('high')).toBe(true)
  })

  test("returns true for 'max'", () => {
    expect(isEffortLevel('max')).toBe(true)
  })

  test("returns false for 'invalid'", () => {
    expect(isEffortLevel('invalid')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isEffortLevel('')).toBe(false)
  })
})

// ─── parseEffortValue ──────────────────────────────────────────────────

describe('parseEffortValue', () => {
  test('returns undefined for undefined', () => {
    expect(parseEffortValue(undefined)).toBeUndefined()
  })

  test('returns undefined for null', () => {
    expect(parseEffortValue(null)).toBeUndefined()
  })

  test('returns undefined for empty string', () => {
    expect(parseEffortValue('')).toBeUndefined()
  })

  test('returns number for integer input', () => {
    expect(parseEffortValue(42)).toBe(42)
  })

  test('returns string for valid effort level string', () => {
    expect(parseEffortValue('low')).toBe('low')
    expect(parseEffortValue('medium')).toBe('medium')
    expect(parseEffortValue('high')).toBe('high')
    expect(parseEffortValue('max')).toBe('max')
  })

  test('parses numeric string to number', () => {
    expect(parseEffortValue('42')).toBe(42)
  })

  test('returns undefined for invalid string', () => {
    expect(parseEffortValue('invalid')).toBeUndefined()
  })

  test('non-integer number falls through to string parsing (parseInt truncates)', () => {
    // 3.14 fails isValidNumericEffort, then String(3.14) -> "3.14" -> parseInt = 3
    expect(parseEffortValue(3.14)).toBe(3)
  })

  test('handles case-insensitive effort level strings', () => {
    expect(parseEffortValue('LOW')).toBe('low')
    expect(parseEffortValue('HIGH')).toBe('high')
  })
})

// ─── isValidNumericEffort ──────────────────────────────────────────────

describe('isValidNumericEffort', () => {
  test('returns true for integer', () => {
    expect(isValidNumericEffort(50)).toBe(true)
  })

  test('returns true for zero', () => {
    expect(isValidNumericEffort(0)).toBe(true)
  })

  test('returns true for negative integer', () => {
    expect(isValidNumericEffort(-1)).toBe(true)
  })

  test('returns false for float', () => {
    expect(isValidNumericEffort(3.14)).toBe(false)
  })

  test('returns false for NaN', () => {
    expect(isValidNumericEffort(NaN)).toBe(false)
  })

  test('returns false for Infinity', () => {
    expect(isValidNumericEffort(Infinity)).toBe(false)
  })
})

// ─── convertEffortValueToLevel ─────────────────────────────────────────

describe('convertEffortValueToLevel', () => {
  test('returns valid effort level string as-is', () => {
    expect(convertEffortValueToLevel('low')).toBe('low')
    expect(convertEffortValueToLevel('medium')).toBe('medium')
    expect(convertEffortValueToLevel('high')).toBe('high')
    expect(convertEffortValueToLevel('max')).toBe('max')
  })

  test("returns 'high' for unknown string", () => {
    expect(convertEffortValueToLevel('unknown' as any)).toBe('high')
  })

  test("non-ant numeric value returns 'high'", () => {
    const saved = process.env.USER_TYPE
    delete process.env.USER_TYPE

    expect(convertEffortValueToLevel(50)).toBe('high')
    expect(convertEffortValueToLevel(100)).toBe('high')

    process.env.USER_TYPE = saved
  })

  describe('ant numeric mapping', () => {
    let savedUserType: string | undefined

    beforeEach(() => {
      savedUserType = process.env.USER_TYPE
      process.env.USER_TYPE = 'ant'
    })

    afterEach(() => {
      if (savedUserType === undefined) {
        delete process.env.USER_TYPE
      } else {
        process.env.USER_TYPE = savedUserType
      }
    })

    test("value <= 50 maps to 'low'", () => {
      expect(convertEffortValueToLevel(50)).toBe('low')
      expect(convertEffortValueToLevel(0)).toBe('low')
      expect(convertEffortValueToLevel(-10)).toBe('low')
    })

    test("value 51-85 maps to 'medium'", () => {
      expect(convertEffortValueToLevel(51)).toBe('medium')
      expect(convertEffortValueToLevel(85)).toBe('medium')
    })

    test("value 86-100 maps to 'high'", () => {
      expect(convertEffortValueToLevel(86)).toBe('high')
      expect(convertEffortValueToLevel(100)).toBe('high')
    })

    test("value > 100 maps to 'max'", () => {
      expect(convertEffortValueToLevel(101)).toBe('max')
      expect(convertEffortValueToLevel(200)).toBe('max')
    })
  })
})

// ─── getEffortLevelDescription ─────────────────────────────────────────

describe('getEffortLevelDescription', () => {
  test("returns description for 'low'", () => {
    const desc = getEffortLevelDescription('low')
    expect(desc).toContain('Quick')
  })

  test("returns description for 'medium'", () => {
    const desc = getEffortLevelDescription('medium')
    expect(desc).toContain('Balanced')
  })

  test("returns description for 'high'", () => {
    const desc = getEffortLevelDescription('high')
    expect(desc).toContain('Comprehensive')
  })

  test("returns description for 'max'", () => {
    const desc = getEffortLevelDescription('max')
    expect(desc).toContain('Maximum')
  })

  test('max description does not contain model names', () => {
    const desc = getEffortLevelDescription('max')
    expect(desc).not.toContain('Opus')
    expect(desc).not.toContain('DeepSeek')
  })

  test("returns description for 'xhigh'", () => {
    const desc = getEffortLevelDescription('xhigh')
    expect(desc).toContain('Extended reasoning')
  })

  test('xhigh description does not contain model names', () => {
    const desc = getEffortLevelDescription('xhigh')
    expect(desc).not.toContain('Opus')
  })
})

// ─── resolvePickerEffortPersistence ────────────────────────────────────

describe('resolvePickerEffortPersistence', () => {
  test('returns undefined when picked matches model default and no prior persistence', () => {
    const result = resolvePickerEffortPersistence(
      'high',
      'high',
      undefined,
      false,
    )
    expect(result).toBeUndefined()
  })

  test('returns picked when it differs from model default', () => {
    const result = resolvePickerEffortPersistence(
      'low',
      'high',
      undefined,
      false,
    )
    expect(result).toBe('low')
  })

  test('returns picked when priorPersisted is set (even if same as default)', () => {
    const result = resolvePickerEffortPersistence('high', 'high', 'high', false)
    expect(result).toBe('high')
  })

  test('returns picked when toggledInPicker is true (even if same as default)', () => {
    const result = resolvePickerEffortPersistence(
      'high',
      'high',
      undefined,
      true,
    )
    expect(result).toBe('high')
  })

  test('returns undefined picked value when no explicit and matches default', () => {
    const result = resolvePickerEffortPersistence(
      undefined,
      'high' as any,
      undefined,
      false,
    )
    expect(result).toBeUndefined()
  })
})

// ─── modelSupportsMaxEffort ────────────────────────────────────────────

describe('modelSupportsMaxEffort', () => {
  test('returns true for opus-4-7', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-opus-4-7-20250918')).toBe(true)
  })

  test('returns true for opus-4-6', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-opus-4-6-20250514')).toBe(true)
  })

  test('returns true for sonnet models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-sonnet-4-6-20250514')).toBe(true)
  })

  test('returns true for haiku models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-haiku-4-5-20251001')).toBe(true)
  })

  test('returns true for deepseek models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('deepseek-v4-pro')).toBe(true)
  })

  test('returns true for unknown models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('some-random-model')).toBe(true)
  })
})

// ─── modelSupportsXhighEffort ──────────────────────────────────────────

describe('modelSupportsXhighEffort', () => {
  test('returns true for opus-4-7', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('claude-opus-4-7-20250918')).toBe(true)
  })

  test('returns true for sonnet models', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('claude-sonnet-4-6-20250514')).toBe(true)
  })

  test('returns true for haiku models', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('claude-haiku-4-5-20251001')).toBe(true)
  })

  test('returns true for unknown models', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('some-random-model')).toBe(true)
  })
})

// ─── resolveRequestEffort ──────────────────────────────────────────────

describe('resolveRequestEffort', () => {
  const MODEL = 'claude-sonnet-4-6'

  afterEach(() => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  })

  test('omits effort entirely when thinking is disabled', () => {
    // Explicit session effort
    expect(resolveRequestEffort(MODEL, 'xhigh', false)).toBeUndefined()
    // Numeric value
    expect(resolveRequestEffort(MODEL, 77, false)).toBeUndefined()
    // Even a hard env override is suppressed
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    expect(resolveRequestEffort(MODEL, 'xhigh', false)).toBeUndefined()
  })

  test('resolves the session effort when thinking is enabled', () => {
    expect(resolveRequestEffort(MODEL, 'xhigh', true)).toBe('xhigh')
  })

  test('falls through to the env override when thinking is enabled', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'low'
    expect(resolveRequestEffort(MODEL, 'xhigh', true)).toBe('low')
  })

  test('respects CLAUDE_CODE_EFFORT_LEVEL=unset when thinking is enabled', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    expect(resolveRequestEffort(MODEL, 'xhigh', true)).toBeUndefined()
  })
})

// ─── resolvePinnedRequestEffort (cache-key pin) ────────────────────────

describe('resolvePinnedRequestEffort', () => {
  const MODEL = 'claude-opus-4-7'

  beforeEach(() => {
    resetStateForTests()
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  })

  afterEach(() => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  })

  test('query source routing: main manages, cache-sharing forks pinned, rest live', () => {
    expect(effortLatchModeForQuerySource('repl_main_thread')).toBe('manage')
    expect(
      effortLatchModeForQuerySource('repl_main_thread:outputStyle:custom'),
    ).toBe('manage')
    expect(effortLatchModeForQuerySource('sdk')).toBe('manage')
    expect(effortLatchModeForQuerySource(undefined)).toBe('manage')
    expect(effortLatchModeForQuerySource('compact')).toBe('pinned')
    expect(effortLatchModeForQuerySource('session_memory')).toBe('pinned')
    expect(effortLatchModeForQuerySource('side_question')).toBe('pinned')
    expect(effortLatchModeForQuerySource('away_summary')).toBe('pinned')
    expect(effortLatchModeForQuerySource('prompt_suggestion')).toBe('pinned')
    expect(effortLatchModeForQuerySource('extract_memories')).toBe('pinned')
    expect(effortLatchModeForQuerySource('speculation')).toBe('pinned')
    expect(effortLatchModeForQuerySource('auto_dream')).toBe('pinned')
    expect(effortLatchModeForQuerySource('agent:builtin:fork')).toBe('live')
  })

  test('first manage-mode request seeds the latch with its live value', () => {
    const wire = resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    expect(wire).toBe('medium')
    expect(isEffortLatchSeeded()).toBe(true)
    expect(getLatchedEffort()).toBe('medium')
  })

  test('a mid-session /effort change keeps sending the pinned wire value', () => {
    resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    // /effort low: wire stays medium (cache key preserved); the live level
    // rides the effort_change tail attachment instead.
    const wire = resolvePinnedRequestEffort(MODEL, 'low', true, 'manage')
    expect(wire).toBe('medium')
    expect(getLatchedEffort()).toBe('medium')
  })

  test('undefined live value seeds the pin as "no param" (beta-header-only shape)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    const wire = resolvePinnedRequestEffort(MODEL, 'high', true, 'manage')
    expect(wire).toBeUndefined()
    expect(isEffortLatchSeeded()).toBe(true)
    // A later live change must not start sending a param.
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    expect(
      resolvePinnedRequestEffort(MODEL, 'low', true, 'manage'),
    ).toBeUndefined()
  })

  test('live numeric override (ant-only) is not pinned and sends live', () => {
    resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    const wire = resolvePinnedRequestEffort(MODEL, 77, true, 'manage')
    expect(wire).toBe(77)
  })

  test('pinned-mode forks send the main thread wire value', () => {
    resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    // A compact fork resolving a different live value (e.g. no effortValue
    // in its context) must still send what the main thread sends.
    expect(resolvePinnedRequestEffort(MODEL, undefined, true, 'pinned')).toBe(
      'medium',
    )
    expect(getLatchedEffort()).toBe('medium')
  })

  test('pinned-mode before any seed falls back to its own live value', () => {
    expect(resolvePinnedRequestEffort(MODEL, 'high', true, 'pinned')).toBe(
      'high',
    )
    expect(isEffortLatchSeeded()).toBe(false)
  })

  test('live-mode (subagents) never reads or writes the pin', () => {
    resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    // Fork with a different model default must keep its own resolution —
    // pinning it would change the main thread's wire value for a prefix
    // nobody shares.
    expect(resolvePinnedRequestEffort(MODEL, 'low', true, 'live')).toBe('low')
    expect(getLatchedEffort()).toBe('medium')
  })

  test('thinking disabled returns undefined without seeding', () => {
    expect(
      resolvePinnedRequestEffort(MODEL, 'high', false, 'manage'),
    ).toBeUndefined()
    expect(isEffortLatchSeeded()).toBe(false)
  })

  test('render point re-seeds the pin from live state', () => {
    resolvePinnedRequestEffort(MODEL, 'medium', true, 'manage')
    clearBetaHeaderLatches()
    expect(isEffortLatchSeeded()).toBe(false)
    expect(getLatchedEffort()).toBeNull()
    // Post-/compact: live /effort low now wins on the wire — the cache is
    // being rewritten at the render point anyway.
    expect(resolvePinnedRequestEffort(MODEL, 'low', true, 'manage')).toBe('low')
  })
})
